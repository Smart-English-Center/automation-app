import { sendBrevoTransactionalEmail } from "../brevoClient.js";
import { generateProfileSummary } from "../speaking/deepseekClient.js";
import { getSpeakingConfig } from "../speaking/config.js";
import { createReviewToken, decryptReviewPayload, encryptReviewPayload, hashEventId, hashReviewToken } from "./security.js";
import * as repository from "./repository.js";

function clean(value) { return String(value ?? "").trim(); }
function lower(value) { return clean(value).toLowerCase(); }
function escapeHtml(value) { return clean(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function expiry() { return new Date(Date.now() + 7 * 86400000); }
function approvers() { return clean(process.env.REGISTRATION_APPROVER_EMAILS).split(/[;,]/).map(lower).filter(Boolean); }
function baseUrl() { return clean(process.env.REGISTRATION_PUBLIC_BASE_URL).replace(/\/+$/, ""); }

function answersFromPayload(payload) {
  return (Array.isArray(payload?.answers) ? payload.answers : []).map((item) => ({ question: clean(item.question), answer: item.answer }));
}

function encryptedContext(payload) {
  return encryptReviewPayload({
    event_id: clean(payload.event_id),
    verified_email: lower(payload.student?.verified_email),
    submitted_at: clean(payload.submitted_at),
    answers: answersFromPayload(payload)
  });
}

function reviewUrl({ token, encryptedPayload }) {
  const params = new URLSearchParams({ token, payload: encryptedPayload });
  return `${baseUrl()}/api/speaking-profiles/review?${params.toString()}`;
}

function answerListHtml(answers) {
  return answers.map((item) => `<div style="margin:10px 0"><strong>${escapeHtml(item.question)}</strong><br>${escapeHtml(Array.isArray(item.answer) ? item.answer.join(", ") : item.answer)}</div>`).join("");
}

async function sendReviewEmail({ review, token, encryptedPayload, answers }) {
  if (!baseUrl()) throw new Error("Missing REGISTRATION_PUBLIC_BASE_URL.");
  if (!approvers().length) throw new Error("Missing REGISTRATION_APPROVER_EMAILS.");
  const url = reviewUrl({ token, encryptedPayload });
  const subject = review.student_id ? "Speaking profile summary ready for review" : "Speaking profile requires manual student matching";
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;background:#f4f6f8;padding:24px;color:#172033"><div style="max-width:700px;margin:auto;background:white;border:1px solid #e5e7eb;border-radius:14px;padding:24px"><h2>John's English Academy</h2><p><strong>Verified email:</strong> ${escapeHtml(review.verified_email)}</p><h3>Original answers</h3>${answerListHtml(answers)}<h3>Draft summary</h3><p>${escapeHtml(review.draft_summary)}</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#2563eb;color:white;text-decoration:none;padding:12px 18px;border-radius:9px;font-weight:bold">Open review page</a></p><p style="color:#667085;font-size:12px">This secure link expires seven days after this email is sent.</p></div></body></html>`;
  const text = [`Verified email: ${review.verified_email}`, "Original answers:", ...answers.flatMap((item) => [item.question, Array.isArray(item.answer) ? item.answer.join(", ") : String(item.answer ?? "")]), "Draft summary:", review.draft_summary, `Review: ${url}`].join("\n\n");
  const results = [];
  for (const email of approvers()) {
    results.push(await sendBrevoTransactionalEmail({ toEmail: email, toName: email, subject, htmlContent: html, textContent: text, tags: ["jea-speaking-profile-review"] }));
  }
  return results;
}

export async function processProfileSubmission(payload) {
  if (!clean(payload?.event_id)) throw new Error("A form event ID is required.");
  const eventHash = hashEventId(payload.event_id);
  const receipt = await repository.claimIngest({ eventHash, submittedAt: payload.submitted_at });
  if (!receipt.inserted && ["approved", "discarded"].includes(receipt.status)) return { ok:true,duplicate:true,status:receipt.status };
  const email = lower(payload.student?.verified_email);
  if (!email || !email.includes("@")) throw new Error("A verified student email is required.");
  let review = await repository.loadReviewByEventHash(eventHash);
  if (review && review.email_delivery_status === "sent") return { ok: true, duplicate: true, status: review.workflow_status };
  const student = await repository.findActiveStudentByEmail(email);
  review ||= await repository.createGeneratingReview({ eventHash, email, studentId: student?.id });
  const answers = answersFromPayload(payload);
  let token;
  if (review.workflow_status === "generating_summary") {
    const config = getSpeakingConfig();
    const generated = await generateProfileSummary({ answers, model: config.model, thinkingMode: config.thinkingMode, reasoningEffort: config.reasoningEffort });
    token = createReviewToken();
    review = await repository.completeDraft({ reviewId: review.id, studentId: student?.id, summary: generated.summary, tokenHash: token.hash, expiresAt: expiry(), pendingMatch: !student });
  } else {
    token = createReviewToken();
    review = await repository.rotateReviewToken({ reviewId: review.id, tokenHash: token.hash, expiresAt: expiry() });
  }
  const context = encryptedContext(payload);
  try {
    await sendReviewEmail({ review, token: token.raw, encryptedPayload: context, answers });
    await repository.markReviewEmail(review.id, { sent: true });
  } catch (error) {
    await repository.markReviewEmail(review.id, { sent: false });
    error.retryable = true;
    throw error;
  }
  return { ok: true, duplicate: !receipt.inserted, status: review.workflow_status };
}

export async function loadReviewPageContext({ token, payload }) {
  const review = await repository.loadReviewByTokenHash(hashReviewToken(token));
  const context = decryptReviewPayload(payload);
  if (review && (hashEventId(context.event_id) !== review.event_id_hash || lower(context.verified_email) !== lower(review.verified_email))) {
    throw new Error("The encrypted questionnaire payload does not belong to this review link.");
  }
  return { review, context, expired: !review || new Date(review.approval_token_expires_at).getTime() <= Date.now() };
}

export async function approveProfile({ token, payload, summary }) {
  const state = await loadReviewPageContext({ token, payload });
  if (state.expired) return { ok: false, status: "EXPIRED" };
  if (!clean(summary)) throw new Error("The approved summary cannot be empty.");
  return repository.approveAndDeleteReview({ reviewId: state.review.id, summary: clean(summary) });
}

export async function discardProfileReview({ token, payload, confirmation }) {
  if (clean(confirmation) !== "discard") {
    throw new Error("Explicit cancellation confirmation is required.");
  }

  const state = await loadReviewPageContext({ token, payload });
  if (state.expired) return { ok: false, status: "EXPIRED" };

  return repository.discardAndDeleteReview({
    reviewId: state.review.id
  });
}

export async function reviseProfile({ token, payload, instructions }) {
  const state = await loadReviewPageContext({ token, payload });
  if (state.expired) return { ok: false, status: "EXPIRED" };
  if (!clean(instructions)) throw new Error("Revision instructions are required.");
  await repository.beginRevision({ reviewId: state.review.id, instructions: clean(instructions) });
  try {
    const config = getSpeakingConfig();
    const generated = await generateProfileSummary({ answers: state.context.answers, currentSummary: state.review.draft_summary, revisionInstructions: clean(instructions), model: config.model, thinkingMode: config.thinkingMode, reasoningEffort: config.reasoningEffort });
    const nextToken = createReviewToken();
    const review = await repository.completeDraft({ reviewId: state.review.id, studentId: state.review.student_id, summary: generated.summary, tokenHash: nextToken.hash, expiresAt: expiry(), pendingMatch: !state.review.student_id });
    const encryptedPayload = encryptReviewPayload(state.context);
    await sendReviewEmail({ review, token: nextToken.raw, encryptedPayload, answers: state.context.answers });
    await repository.markReviewEmail(review.id, { sent: true });
    return { ok: true };
  } catch (error) {
    await repository.restoreReviewAfterRevisionFailure({
      reviewId: state.review.id,
      summary: state.review.draft_summary,
      tokenHash: state.review.approval_token_hash,
      expiresAt: state.review.approval_token_expires_at
    });
    throw error;
  }
}

export function normaliseProfileMatchEmail(input = {}) {
  return lower(input.studentEmail || input.student_email);
}

export async function matchProfile(input = {}) {
  const { token, payload } = input;
  const state = await loadReviewPageContext({ token, payload });
  if (state.expired) return { ok: false, status: "EXPIRED" };
  const studentEmail = normaliseProfileMatchEmail(input);
  if (!studentEmail || !studentEmail.includes("@")) {
    throw new Error("Enter a valid student email address before matching.");
  }
  const student = await repository.findActiveStudentByEmail(studentEmail);
  if (!student) return { ok: false, status: "NO_ACTIVE_STUDENT" };
  await repository.matchReviewStudent({ reviewId: state.review.id, studentId: student.id });
  return { ok: true, student };
}

export async function resendExpiredReview({ payload }) {
  const context = decryptReviewPayload(payload);
  const review = await repository.loadReviewByEventHash(hashEventId(context.event_id));
  if (!review) return { ok: false, status: "NOT_FOUND" };
  const token = createReviewToken();
  const updated = await repository.rotateReviewToken({ reviewId: review.id, tokenHash: token.hash, expiresAt: expiry() });
  const encryptedPayload = encryptReviewPayload(context);
  await sendReviewEmail({ review: updated, token: token.raw, encryptedPayload, answers: context.answers });
  await repository.markReviewEmail(updated.id, { sent: true });
  return { ok: true };
}
