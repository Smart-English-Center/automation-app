import {
  correctRemediationLink,
  loadRemediationPage,
  resolveRemediationWithoutSpeaking
} from "../speakingLinkRemediation/service.js";
import { classifySpeakPipeLink } from "../submissionPolicy.js";
import { speakingLinkRemediationEditState } from "../supabase/speakingLinkRemediationRepository.js";

function clean_(value) { return String(value ?? "").trim(); }
function escapeHtml_(value) {
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function hidden_(name, value) { return `<input type="hidden" name="${escapeHtml_(name)}" value="${escapeHtml_(value)}">`; }
function page_(title, body, tone = "normal") {
  const accent = tone === "error" ? "#b42318" : tone === "success" ? "#16794c" : "#2563eb";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml_(title)}</title></head><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#172033;line-height:1.55"><main style="max-width:760px;margin:auto;background:white;border:1px solid #e5e7eb;border-top:5px solid ${accent};border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(16,24,40,.08)"><div style="font-weight:bold;color:#344054">John's English Academy</div><h1 style="font-size:23px">${escapeHtml_(title)}</h1>${body}</main></body></html>`;
}

function secureResponse_(res) {
  if (typeof res.set === "function") {
    res.set({
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff"
    });
  }
  return res;
}

function statusLabel_(status) {
  return {
    AWAITING_ACTION: "Waiting for teacher action",
    LINK_CORRECTED: "Correct link accepted",
    RESOLVED_WITHOUT_SPEAKING: "Resolved without speaking"
  }[clean_(status)] || clean_(status);
}

function pageBody_(row, token, mode = "correct", notice = "", enteredLink = null) {
  const { canCorrect, canResolve } = speakingLinkRemediationEditState(row);
  const awaitingAction = row.status === "AWAITING_ACTION";
  const suggestedLink = enteredLink === null ? row.canonical_link || classifySpeakPipeLink(row.original_link).normalized_url || "" : clean_(enteredLink);
  const decision = row.status === "RESOLVED_WITHOUT_SPEAKING"
    ? "Saved decision: continue without speaking. Speaking is not assessed; the system can continue with the available writing result."
    : row.status === "LINK_CORRECTED"
      ? "Saved decision: use the corrected recording link."
      : "No decision has been saved yet.";
  const savedAt = row.resolved_at ? `<p><strong>Decision saved at:</strong> ${escapeHtml_(row.resolved_at instanceof Date ? row.resolved_at.toISOString() : row.resolved_at)}</p>` : "";
  const decisionHtml = `<div style="padding:12px 14px;border-radius:10px;background:#f8fafc;border:1px solid #e5e7eb;margin:16px 0"><strong>${escapeHtml_(decision)}</strong>${savedAt}${row.has_final_feedback ? "<p>Final feedback has been assembled. This page remains available to view the saved decision.</p>" : ""}</div>`;
  const writing = clean_(row.writing_answer || row.answer_text) || "Written answer unavailable.";
  const noticeHtml = notice ? `<div style="padding:12px 14px;border-radius:10px;background:#ecfdf3;border:1px solid #bbf7d0;color:#166534;margin:16px 0">${escapeHtml_(notice)}</div>` : "";
  const correctionForm = !canCorrect ? `<p style="padding:12px 14px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412">The link can no longer be changed safely because downstream processing has started or final feedback has already been assembled.</p>` : `
    <form method="post" action="/api/speaking-link-remediation/correct" style="margin-top:20px;padding:18px;border:1px solid #dbeafe;background:#eff6ff;border-radius:12px">
      ${hidden_("token",token)}${hidden_("version",row.version)}
      <label style="display:block;font-weight:bold;margin-bottom:8px">Complete SpeakPipe message link</label>
      <input required type="url" name="corrected_link" value="${escapeHtml_(suggestedLink)}" placeholder="https://www.speakpipe.com/voice-recorder/msg/..." style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #94a3b8;border-radius:8px">
      <label style="display:block;margin:14px 0"><input required type="checkbox" name="confirmation" value="verified"> I opened and verified that this is the correct student's recording.</label>
      <button type="submit" style="background:#2563eb;color:white;border:0;border-radius:9px;padding:11px 16px;font-weight:bold">Validate and start speaking processing</button>
    </form>`;
  const resolveForm = !canResolve ? "" : `
    <form method="post" action="/api/speaking-link-remediation/resolve" style="margin-top:20px;padding:18px;border:1px solid #fecaca;background:#fef2f2;border-radius:12px">
      ${hidden_("token",token)}${hidden_("version",row.version)}
      <p><strong>Use this only when no valid recording can be found.</strong> Speaking will be marked Not assessed and the system will continue with the available writing result.</p>
      <label style="display:block;margin:14px 0"><input required type="checkbox" name="confirmation" value="continue_without_speaking"> I confirm that no valid speaking recording is available.</label>
      <button type="submit" style="background:#b42318;color:white;border:0;border-radius:9px;padding:11px 16px;font-weight:bold">Continue without speaking</button>
    </form>`;
  const originalIssue = awaitingAction
    ? `<p><strong>Detected issue:</strong> ${escapeHtml_(row.issue_message || row.issue_code)}</p>`
    : `<details><summary>Original issue — historical</summary><p>${escapeHtml_(row.issue_message || row.issue_code)}</p></details>`;
  return `${noticeHtml}${decisionHtml}
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin:18px 0">
      <div style="padding:12px;background:#f8fafc;border-radius:10px"><strong>Student</strong><br>${escapeHtml_(row.student_name || row.student_email || "—")}</div>
      <div style="padding:12px;background:#f8fafc;border-radius:10px"><strong>Assignment</strong><br>${escapeHtml_(row.assignment_key || "—")}</div>
      <div style="padding:12px;background:#f8fafc;border-radius:10px"><strong>Status</strong><br>${escapeHtml_(statusLabel_(row.status))}</div>
    </div>
    <h2 style="font-size:18px">Submitted link</h2><div style="word-break:break-all;padding:12px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:10px">${escapeHtml_(row.original_link || "No link received")}</div>
    ${row.canonical_link ? `<p><strong>Current corrected link:</strong> <a href="${escapeHtml_(row.canonical_link)}" target="_blank" rel="noopener noreferrer">Open recording</a></p>` : ""}
    ${originalIssue}
    <details><summary style="cursor:pointer;font-weight:bold">Written answer</summary><div style="white-space:pre-wrap;margin-top:10px;padding:12px;background:#f8fafc;border-radius:10px">${escapeHtml_(writing)}</div></details>
    ${mode === "resolve" ? resolveForm + correctionForm : correctionForm + resolveForm}`;
}

function errorResponse_(res, error) {
  const status = Number(error?.httpStatus) || 400;
  return secureResponse_(res).status(status).send(page_("Speaking-link action unavailable", `<p>${escapeHtml_(error?.message || error)}</p>`, "error"));
}

export function registerSpeakingLinkRemediationRoutes(app, dependencies = {}) {
  const load = dependencies.loadRemediationPage || loadRemediationPage;
  const correct = dependencies.correctRemediationLink || correctRemediationLink;
  const resolve = dependencies.resolveRemediationWithoutSpeaking || resolveRemediationWithoutSpeaking;

  app.get("/api/speaking-link-remediation", async (req, res) => {
    try {
      const token = clean_(req.query.token);
      const row = await load(token);
      const title = row.status === "RESOLVED_WITHOUT_SPEAKING" ? "Resolved without speaking" : row.status === "LINK_CORRECTED" ? "Speaking link corrected" : "Resolve invalid speaking link";
      return secureResponse_(res).send(page_(title, pageBody_(row, token, clean_(req.query.mode))));
    } catch (error) { return errorResponse_(res, error); }
  });

  app.post("/api/speaking-link-remediation/correct", async (req, res) => {
    let accepted = false;
    try {
      await correct(req.body || {});
      accepted = true;
      const token = clean_(req.body?.token);
      const row = await load(token);
      return secureResponse_(res).send(page_("Speaking link corrected", pageBody_(row, token, "correct", "The corrected link was accepted and speaking processing can continue."), "success"));
    } catch (error) {
      if (accepted) return secureResponse_(res).status(503).send(page_("Speaking link corrected", "<p>The corrected link was saved, but the updated page could not be loaded. Reopen the original email link to view the saved decision.</p>", "success"));
      const token = clean_(req.body?.token);
      try {
        const row = await load(token);
        return secureResponse_(res).status(Number(error?.httpStatus) || 400).send(page_("Correction not saved", `<p>${escapeHtml_(error.message || error)}</p>${pageBody_(row, token, "correct", "", req.body?.corrected_link || "")}`, "error"));
      } catch { return errorResponse_(res, error); }
    }
  });

  app.post("/api/speaking-link-remediation/resolve", async (req, res) => {
    try {
      await resolve(req.body || {});
      const token = clean_(req.body?.token);
      const row = await load(token);
      return secureResponse_(res).send(page_("Resolved without speaking", pageBody_(row, token, "resolve", "The system may now continue without a speaking assessment."), "success"));
    } catch (error) { return errorResponse_(res, error); }
  });
}
