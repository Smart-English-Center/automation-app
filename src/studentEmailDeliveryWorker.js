/******************************************************************
 * studentEmailDeliveryWorker.js
 *
 * Supabase-native Brevo delivery worker for queued emails.
 *
 * Responsibilities:
 * - Optionally queue student feedback PDF emails from final_feedback rows.
 * - Claim one queued email safely from email_queue for the requested source_type.
 * - Send it through Brevo.
 * - Mark email_queue SENT/FAILED.
 * - Update final_feedback delivery_status only for real student feedback deliveries.
 *
 * Test recipient override:
 * - Queueing with testRecipientEmail creates STUDENT_FEEDBACK_PDF_TEST.
 * - Test rows do not change final_feedback delivery_status.
 ******************************************************************/

import { sendBrevoTransactionalEmail } from "./brevoClient.js";
import {
  claimOneQueuedStudentFeedbackEmail,
  getDefaultStudentFeedbackSendLimit,
  getEmailQueueSummary,
  getStudentFeedbackEmailSourceTypes,
  markQueuedEmailFailed,
  markQueuedEmailSent,
  queueStudentFeedbackEmails,
  reconcileSentTeacherDigestInclusions,
  storeRenderedQueuedEmailContent
} from "./supabase/emailQueueRepository.js";
import { getSpeakingConfig } from "./speaking/config.js";
import { renderSpeakingQueueEmail } from "./speaking/emailRenderer.js";
import { loadSpeakingEmailSource } from "./supabase/speakingTopicRepository.js";

function nowIso_() {
  return new Date().toISOString();
}

function clean_(value) {
  return String(value ?? "").trim();
}

function hasRenderedEmailContent_(job) {
  return Boolean(clean_(job?.subject) && (clean_(job?.body_html) || clean_(job?.body_text)));
}

function normaliseLimit_(value, fallback = 1, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normaliseBoolean_(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const clean = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(clean)) return true;
  if (["0", "false", "no", "n", "off"].includes(clean)) return false;
  return fallback;
}

function configuredBoolean_(value) {
  if (value === undefined || value === null || clean_(value) === "") return null;
  return normaliseBoolean_(value, false);
}

function normaliseSourceTypes_(value, fallback = [getStudentFeedbackEmailSourceTypes().real]) {
  if (Array.isArray(value)) {
    const cleaned = value.map((item) => clean_(item).toUpperCase()).filter(Boolean);
    return cleaned.length ? [...new Set(cleaned)] : fallback;
  }

  const cleaned = clean_(value)
    .split(/[;,]/)
    .map((item) => clean_(item).toUpperCase())
    .filter(Boolean);

  return cleaned.length ? [...new Set(cleaned)] : fallback;
}

function inferSendErrorCode_(error) {
  const message = String(error && error.message ? error.message : error).toUpperCase();

  if (message.includes("BREVO")) return "BREVO_SEND_FAILED";
  if (message.includes("RECIPIENT")) return "INVALID_RECIPIENT";
  if (message.includes("SUBJECT")) return "INVALID_EMAIL_SUBJECT";
  if (message.includes("CONTENT")) return "INVALID_EMAIL_CONTENT";

  return "STUDENT_FEEDBACK_EMAIL_SEND_FAILED";
}

function payloadJson_(job) {
  const value = job?.payload_json;
  if (!value) return {};
  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

function bccEmailForJob_(job) {
  const payload = payloadJson_(job);
  const explicitBcc = clean_(payload.bcc_email || payload.bcc || "");
  if (explicitBcc) return explicitBcc;

  const sourceType = clean_(job?.source_type).toUpperCase();
  if (sourceType.includes("TEACHER_PROGRESS_DIGEST") || sourceType.includes("TEACHER_ALERT")) {
    return clean_(
      process.env.TEACHER_DIGEST_BCC_EMAIL ||
      process.env.HEAD_TEACHER_EMAIL ||
      process.env.JEA_HEAD_TEACHER_EMAIL ||
      ""
    );
  }

  return "";
}


function emailTestRoutingConfig_(job = {}) {
  const sourceType = clean_(job?.source_type).toUpperCase();
  const progressReportOverride = sourceType.includes("PROGRESS_REPORT")
    ? configuredBoolean_(process.env.PROGRESS_REPORT_TEST_MODE)
    : null;

  const enabled = progressReportOverride !== null
    ? progressReportOverride
    : normaliseBoolean_(
        process.env.EMAIL_TEST_MODE || process.env.STUDENT_EMAIL_TEST_MODE || process.env.JEA_EMAIL_TEST_MODE,
        false
      );

  const recipientEmail = clean_(
    sourceType.includes("PROGRESS_REPORT")
      ? (
          process.env.PROGRESS_REPORT_TEST_RECIPIENT ||
          process.env.EMAIL_TEST_RECIPIENT ||
          process.env.STUDENT_EMAIL_TEST_RECIPIENT ||
          process.env.HEAD_TEACHER_EMAIL ||
          process.env.JEA_HEAD_TEACHER_EMAIL ||
          ""
        )
      : (
          process.env.EMAIL_TEST_RECIPIENT ||
          process.env.STUDENT_EMAIL_TEST_RECIPIENT ||
          process.env.HEAD_TEACHER_EMAIL ||
          process.env.JEA_HEAD_TEACHER_EMAIL ||
          ""
        )
  );

  return {
    enabled: enabled && Boolean(recipientEmail),
    recipientEmail,
    recipientName: clean_(process.env.EMAIL_TEST_RECIPIENT_NAME || process.env.STUDENT_EMAIL_TEST_RECIPIENT_NAME || "Head Teacher")
  };
}

function applyTestRoutingToJob_(job) {
  const config = emailTestRoutingConfig_(job);
  if (!config.enabled) {
    return {
      testMode: false,
      toEmail: job.recipient_email,
      toName: job.recipient_name || job.recipient_email,
      subject: job.subject,
      htmlContent: job.body_html,
      textContent: job.body_text,
      bccEmail: bccEmailForJob_(job)
    };
  }

  return {
    testMode: true,
    toEmail: config.recipientEmail,
    toName: config.recipientName || config.recipientEmail,
    subject: job.subject,
    htmlContent: job.body_html,
    textContent: job.body_text,
    bccEmail: ""
  };
}

export async function runStudentEmailDeliveryOnce(options = {}) {
  const sourceTypes = normaliseSourceTypes_(
    options.sourceTypes || options.source_types || process.env.STUDENT_EMAIL_DELIVERY_SOURCE_TYPES,
    [getStudentFeedbackEmailSourceTypes().real]
  );

  const queueBeforeSend = normaliseBoolean_(
    options.queueBeforeSend ??
      options.queue_before_send ??
      options.prepareBeforeClaim ??
      options.prepare_before_claim ??
      process.env.QUEUE_STUDENT_FEEDBACK_EMAILS_BEFORE_SEND,
    false
  );

  const result = {
    ok: true,
    mode: "SUPABASE_STUDENT_FEEDBACK_EMAIL_DELIVERY",
    started_at: nowIso_(),
    source_types: sourceTypes,
    queue_before_send: queueBeforeSend,
    teacher_digest_reconciliation: null,
    queue_result: null,
    send_results: [],
    finished_at: null
  };

  try {
    result.teacher_digest_reconciliation = await reconcileSentTeacherDigestInclusions({ limit: 25 });
  } catch (error) {
    result.teacher_digest_reconciliation = {
      ok: false,
      error: String(error && error.message ? error.message : error)
    };
  }

  if (queueBeforeSend) {
    result.queue_result = await queueStudentFeedbackEmails({
      limit: normaliseLimit_(options.queueLimit || options.queue_limit || options.prepareLimit || options.prepare_limit || process.env.EMAIL_QUEUE_LIMIT, 10),
      studentId: options.studentId || options.student_id,
      studentEmail: options.studentEmail || options.student_email,
      pdfJobId: options.pdfJobId || options.pdf_job_id,
      finalFeedbackId: options.finalFeedbackId || options.final_feedback_id
    });
  }

  const limit = normaliseLimit_(
    options.limit || process.env.EMAIL_DELIVERY_LIMIT,
    getDefaultStudentFeedbackSendLimit(),
    100
  );

  for (let index = 0; index < limit; index += 1) {
    const sendResult = await sendOneQueuedStudentFeedbackEmail({
      emailId: index === 0 ? options.emailId || options.email_id : "",
      sourceTypes,
      workerId: options.workerId || options.worker_id || "student-email-delivery-worker"
    });

    result.send_results.push(sendResult);

    if (sendResult.status === "NO_QUEUED_EMAIL") {
      break;
    }
  }

  result.ok = result.send_results.every((item) => item.ok !== false);
  result.finished_at = nowIso_();

  return result;
}

export async function sendOneQueuedStudentFeedbackEmail(options = {}) {
  const sourceTypes = normaliseSourceTypes_(
    options.sourceTypes || options.source_types,
    [getStudentFeedbackEmailSourceTypes().real]
  );

  const job = await claimOneQueuedStudentFeedbackEmail({
    emailId: options.emailId || options.email_id,
    sourceTypes,
    workerId: options.workerId || options.worker_id || "manual-email-send-one"
  });

  if (!job) {
    return {
      ok: true,
      status: "NO_QUEUED_EMAIL",
      message: "No queued email is ready to send for the requested source_type filter.",
      source_types: sourceTypes,
      checked_at: nowIso_()
    };
  }

  try {
    let deliverableJob = job;
    const sourceType = clean_(job.source_type).toUpperCase();
    if (["SPEAKING_GROUP_TOPICS", "SPEAKING_PROFILE_REMINDER", "SPEAKING_TEACHER_MATERIALS"].includes(sourceType) && !hasRenderedEmailContent_(job)) {
      const source = await loadSpeakingEmailSource(sourceType, job.source_id, job.payload_json);
      if (!source) throw new Error(`Speaking email source ${job.source_id} was not found.`);
      const rendered = renderSpeakingQueueEmail(sourceType, source, getSpeakingConfig());
      const stored=await storeRenderedQueuedEmailContent({emailId:job.id,subject:rendered.subject,bodyHtml:rendered.html,bodyText:rendered.text});
      if(!stored)throw new Error(`Could not store rendered speaking email content for queue row ${job.id}.`);
      deliverableJob = { ...job, ...stored, subject: rendered.subject, body_html: rendered.html, body_text: rendered.text };
    }
    const routed = applyTestRoutingToJob_(deliverableJob);

    const sendResult = await sendBrevoTransactionalEmail({
      toEmail: routed.toEmail,
      toName: routed.toName,
      subject: routed.subject,
      htmlContent: routed.htmlContent,
      textContent: routed.textContent,
      tags: buildBrevoTagsForQueuedEmail_(deliverableJob),
      bccEmail: routed.bccEmail
    });

    const marked = await markQueuedEmailSent({
      emailId: job.id,
      providerMessageId: sendResult.message_id
    });

    return {
      ok: true,
      status: "SENT",
      email_queue_id: job.id,
      source_type: job.source_type,
      recipient_email: job.recipient_email,
      recipient_name: job.recipient_name,
      actual_to_email: routed.toEmail,
      actual_to_name: routed.toName,
      subject: routed.subject,
      test_mode: routed.testMode,
      bcc_email_configured: Boolean(routed.bccEmail),
      pdf_job_id: job.pdf_job_id,
      final_feedback_ids: job.final_feedback_ids || [],
      provider: "BREVO",
      provider_message_id: sendResult.message_id,
      post_send_finalization_status: marked?.post_send_finalization_status || "COMPLETED",
      post_send_finalization_error: marked?.post_send_finalization_error || null,
      email_queue: summariseQueueRow_(marked),
      checked_at: nowIso_()
    };
  } catch (error) {
    const failed = await markQueuedEmailFailed({
      emailId: job.id,
      errorCode: inferSendErrorCode_(error),
      errorMessage: String(error && error.message ? error.message : error)
    });

    if (clean_(failed?.status).toUpperCase() === "SENT") {
      return {
        ok: true,
        status: "SENT",
        email_queue_id: job.id,
        source_type: job.source_type,
        recipient_email: job.recipient_email,
        subject: job.subject,
        provider: "BREVO",
        provider_acceptance_recovered: true,
        post_send_finalization_status: "UNKNOWN",
        post_send_finalization_error: String(error && error.message ? error.message : error),
        email_queue: summariseQueueRow_(failed),
        checked_at: nowIso_()
      };
    }

    return {
      ok: false,
      status: "FAILED",
      email_queue_id: job.id,
      source_type: job.source_type,
      recipient_email: job.recipient_email,
      error: String(error && error.message ? error.message : error),
      email_queue: summariseQueueRow_(failed),
      checked_at: nowIso_()
    };
  }
}

export async function sendQueuedStudentFeedbackEmailBatch(options = {}) {
  const limit = normaliseLimit_(options.limit || process.env.EMAIL_DELIVERY_LIMIT, 1, 100);
  return runStudentEmailDeliveryOnce({
    ...options,
    limit,
    queueBeforeSend: false
  });
}

export async function getStudentFeedbackEmailQueueSummary(options = {}) {
  return getEmailQueueSummary(options);
}

function buildBrevoTagsForQueuedEmail_(job) {
  const sourceType = clean_(job.source_type).toUpperCase();
  const normalisedSource = sourceType.toLowerCase().replace(/_/g, "-");

  if (sourceType === "STUDENT_FEEDBACK_PDF" || sourceType === "STUDENT_FEEDBACK_PDF_TEST") {
    return ["jea-student-feedback", normalisedSource];
  }

  if (sourceType.includes("ENCOURAGEMENT") || sourceType.includes("REACTIVATION")) {
    return ["jea-encouragement", normalisedSource];
  }

  if (sourceType.includes("NO_SUBMISSION_REMINDER") || sourceType.includes("NO_ASSIGNMENT_WARNING")) {
    return ["jea-student-reminder", normalisedSource];
  }

  if (sourceType.includes("TEACHER_PROGRESS_DIGEST") || sourceType.includes("TEACHER_ALERT")) {
    return ["jea-teacher-digest", normalisedSource];
  }

  if (sourceType.includes("MAINTAINER_ALERT")) {
    return ["jea-maintainer-alert", normalisedSource];
  }

  if (sourceType.includes("PROGRESS_REPORT")) {
    return ["jea-progress-report", normalisedSource];
  }

  if (sourceType.includes("SPEAKING")) {
    return ["jea-speaking-practice", normalisedSource];
  }

  return ["jea-email-queue", normalisedSource].filter(Boolean);
}

function summariseQueueRow_(row) {
  if (!row) return null;

  return {
    id: row.id,
    source_type: row.source_type,
    status: row.status,
    recipient_email: row.recipient_email,
    pdf_job_id: row.pdf_job_id,
    attempt_count: row.attempt_count,
    provider_message_id: row.provider_message_id,
    sent_at: row.sent_at,
    error_code: row.error_code,
    error_message: row.error_message
  };
}
