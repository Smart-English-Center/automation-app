import { approveProfile, discardProfileReview, loadReviewPageContext, matchProfile, processProfileSubmission, resendExpiredReview, reviseProfile } from "../speakingProfile/service.js";
import { verifyWebhook } from "../speakingProfile/security.js";

function clean(value) { return String(value ?? "").trim(); }
function escapeHtml(value) { return clean(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
function page(title, body) { return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,sans-serif;background:#f4f6f8;color:#172033;margin:0;padding:24px"><main style="max-width:760px;margin:auto;background:white;border:1px solid #e5e7eb;border-radius:14px;padding:24px"><div style="font-weight:bold;margin-bottom:12px">John's English Academy</div><h1 style="font-size:22px">${escapeHtml(title)}</h1>${body}</main></body></html>`; }
function hidden(name, value) { return `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`; }
function expiredPage(payload) { return page("Review link expired", `<p>This link is no longer valid.</p><form method="post" action="/api/speaking-profiles/review/resend">${hidden("payload",payload)}<button style="padding:11px 16px">Send new link</button></form>`); }

export function registerSpeakingProfileRoutes(app) {
  app.post("/api/speaking-profiles/forms/submit", async (req, res) => {
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const eventId = clean(req.get("x-jea-event-id"));
    const valid = verifyWebhook({ rawBody, eventId, timestamp: req.get("x-jea-webhook-timestamp"), signature: req.get("x-jea-webhook-signature") });
    if (!valid || eventId !== clean(req.body?.event_id)) return res.status(401).json({ ok: false, status: "INVALID_SIGNATURE" });
    try {
      const result = await processProfileSubmission(req.body || {});
      return res.status(202).json(result);
    } catch (error) {
      const retryable = error?.retryable !== false;
      return res.status(retryable ? 503 : 400).json({ ok: false, retryable, error: clean(error?.message || error) });
    }
  });

  app.get("/api/speaking-profiles/review", async (req, res) => {
    try {
      const token = clean(req.query.token); const payload = clean(req.query.payload);
      const state = await loadReviewPageContext({ token, payload });
      if (state.expired) return res.status(410).send(expiredPage(payload));
      const answers = state.context.answers.map((item) => `<p><strong>${escapeHtml(item.question)}</strong><br>${escapeHtml(Array.isArray(item.answer) ? item.answer.join(", ") : item.answer)}</p>`).join("");
      const matching = state.review.student_id ? "" : `<section style="border:1px solid #fde68a;background:#fffbeb;padding:14px;border-radius:10px"><h2>Manual student matching</h2><p>Enter the email of the active database student who owns this response.</p><form method="post" action="/api/speaking-profiles/review/match">${hidden("token",token)}${hidden("payload",payload)}<input required type="email" name="student_email" style="padding:9px;width:90%"><button style="padding:10px;margin-top:8px">Match student</button></form></section>`;
      return res.send(page("Review speaking profile", `${matching}<h2>Original answers</h2>${answers}<form method="post" action="/api/speaking-profiles/review/approve">${hidden("token",token)}${hidden("payload",payload)}<h2>Summary</h2><textarea name="summary" required rows="7" style="width:100%;box-sizing:border-box;padding:10px">${escapeHtml(state.review.draft_summary)}</textarea><button ${state.review.student_id ? "" : "disabled"} style="padding:11px 16px;margin-top:10px">Approve and save</button></form><form method="post" action="/api/speaking-profiles/review/revise" style="margin-top:24px">${hidden("token",token)}${hidden("payload",payload)}<h2>Request a DeepSeek revision</h2><textarea name="instructions" required rows="4" style="width:100%;box-sizing:border-box;padding:10px"></textarea><button style="padding:11px 16px;margin-top:10px">Generate revised summary</button></form><section style="border-top:1px solid #e5e7eb;margin-top:30px;padding-top:20px"><h2>Cancel this request</h2><p>Use this only when this submission should not be matched, approved or retained for further review.</p><form method="post" action="/api/speaking-profiles/review/cancel/confirm">${hidden("token",token)}${hidden("payload",payload)}<button style="padding:11px 16px;background:#b42318;color:white;border:0;border-radius:6px;font-weight:bold">Cancel and discard request</button></form></section>`));
    } catch (error) { return res.status(400).send(page("Review unavailable", `<p>${escapeHtml(error.message)}</p>`)); }
  });

  app.post("/api/speaking-profiles/review/approve", async (req, res) => {
    try { const result = await approveProfile(req.body || {}); return res.status(result.ok ? 200 : 410).send(result.ok ? page("Profile approved", "<p>The approved summary has been saved and all temporary review data has been removed.</p>") : expiredPage(req.body.payload)); }
    catch (error) { return res.status(400).send(page("Approval failed", `<p>${escapeHtml(error.message)}</p>`)); }
  });
  app.post("/api/speaking-profiles/review/revise", async (req, res) => {
    try { const result = await reviseProfile(req.body || {}); return res.status(result.ok ? 200 : 410).send(result.ok ? page("Revision requested", "<p>A revised summary and a new review link have been emailed to the administrators.</p>") : expiredPage(req.body.payload)); }
    catch (error) { return res.status(500).send(page("Revision failed", `<p>${escapeHtml(error.message)}</p>`)); }
  });
  app.post("/api/speaking-profiles/review/match", async (req, res) => {
    try { const result = await matchProfile(req.body || {}); return res.status(result.ok ? 200 : 400).send(result.ok ? page("Student matched", `<p>Matched to ${escapeHtml(result.student.full_name)}. Return to the review link to approve or revise the summary.</p>`) : page("Match failed", "<p>No active student has that exact email address.</p>")); }
    catch (error) { return res.status(400).send(page("Match failed", `<p>${escapeHtml(error.message)}</p>`)); }
  });
  app.post("/api/speaking-profiles/review/cancel/confirm", async (req, res) => {
    try {
      const token = clean(req.body?.token); const payload = clean(req.body?.payload);
      const state = await loadReviewPageContext({ token, payload });
      if (state.expired) return res.status(410).send(expiredPage(payload));
      const returnUrl = `/api/speaking-profiles/review?${new URLSearchParams({ token, payload }).toString()}`;
      return res.send(page("Confirm request cancellation", `<p><strong>This action cannot be undone.</strong></p><p>The draft summary, verified email, revision instructions and approval link will be permanently removed. No speaking profile will be saved.</p><form method="post" action="/api/speaking-profiles/review/cancel">${hidden("token",token)}${hidden("payload",payload)}${hidden("confirmation","discard")}<button style="padding:11px 16px;background:#b42318;color:white;border:0;border-radius:6px;font-weight:bold">Confirm cancellation and delete temporary review</button></form><p style="margin-top:18px"><a href="${escapeHtml(returnUrl)}">Return to the review without cancelling</a></p>`));
    } catch (error) { return res.status(400).send(page("Cancellation unavailable", `<p>${escapeHtml(error.message)}</p>`)); }
  });
  app.post("/api/speaking-profiles/review/cancel", async (req, res) => {
    try {
      const result = await discardProfileReview(req.body || {});
      if (result.ok) return res.send(page("Request cancelled", "<p>The request has been discarded. All temporary review data has been removed and no speaking profile was saved.</p>"));
      if (result.status === "EXPIRED") return res.status(410).send(expiredPage(req.body?.payload));
      return res.status(409).send(page("Request already resolved", "<p>This request is no longer pending and no further action is required.</p>"));
    } catch (error) { return res.status(400).send(page("Cancellation failed", `<p>${escapeHtml(error.message)}</p>`)); }
  });
  app.post("/api/speaking-profiles/review/resend", async (req, res) => {
    try { const result = await resendExpiredReview(req.body || {}); return res.status(result.ok ? 200 : 404).send(page(result.ok ? "New link sent" : "Review not found", result.ok ? "<p>A new seven-day review link has been emailed.</p>" : "<p>The temporary review no longer exists.</p>")); }
    catch (error) { return res.status(400).send(page("New link failed", `<p>${escapeHtml(error.message)}</p>`)); }
  });
}
