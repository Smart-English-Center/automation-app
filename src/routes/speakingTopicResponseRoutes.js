import {
  loadSpeakingTopicResponsePage,
  submitSpeakingTopicResponse
} from "../speakingTopicResponse/service.js";

function clean(value) { return String(value ?? "").trim(); }
function escapeHtml(value) {
  return String(value ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function hidden(name, value) { return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`; }
function earlyFrench(row) {
  const curriculum = row.curriculum_snapshot || {};
  return clean(curriculum.level).toUpperCase() === "A1" && Number(clean(curriculum.module).match(/\d+/)?.[0] || 1) <= 3;
}
function secure(res) {
  if (typeof res.set === "function") res.set({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff"
  });
  return res;
}
function shell(title, body, language = "en", tone = "normal") {
  const accent = tone === "error" ? "#b42318" : tone === "success" ? "#16794c" : "#2563eb";
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="margin:0;padding:24px;background:#f4f6f8;font-family:Arial,Helvetica,sans-serif;color:#172033;line-height:1.55"><main style="max-width:760px;margin:auto;background:white;border:1px solid #e5e7eb;border-top:5px solid ${accent};border-radius:16px;padding:24px;box-shadow:0 10px 30px rgba(16,24,40,.08)"><div style="font-weight:bold;color:#344054">John's English Academy</div><h1 style="font-size:23px">${escapeHtml(title)}</h1>${body}</main></body></html>`;
}
function topicText(topic) {
  const learner = topic.learner_content || {};
  const points = Array.isArray(learner.points) ? learner.points : [];
  return `<h2 style="font-size:18px;margin:0 0 8px">${escapeHtml(topic.position)}. ${escapeHtml(topic.title)}</h2><p>${escapeHtml(learner.body)}</p>${points.length ? `<ul>${points.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : ""}`;
}
function pageBody(row, token, notice = "") {
  const french = earlyFrench(row);
  const language = french ? "fr" : "en";
  const copy = french ? {
    intro: "Pour chaque sujet, indiquez si vous en avez déjà discuté avec votre professeur. Vous devez répondre pour les trois sujets avant d’envoyer le formulaire.",
    question: "Avez-vous déjà discuté de ce sujet avec votre professeur ?",
    yes: "Oui, sujet discuté",
    no: "Pas encore",
    submit: "Enregistrer mes réponses",
    locked: "Ces réponses ne peuvent plus être modifiées parce que le cycle suivant a déjà commencé.",
    saved: "Vos réponses ont été enregistrées. Les sujets non discutés seront réutilisés la prochaine fois.",
    title: "Mise à jour de vos sujets de pratique orale"
  } : {
    intro: "For each topic, indicate whether you have already discussed it with your teacher. You must answer for all three topics before submitting the form.",
    question: "Have you already discussed this topic with your teacher?",
    yes: "Yes, discussed",
    no: "Not yet",
    submit: "Save my answers",
    locked: "These answers can no longer be changed because the next topic cycle has already started.",
    saved: "Your answers have been saved. Topics that have not been discussed will be reused next time.",
    title: "Update your speaking-practice topics"
  };
  const noticeHtml = notice ? `<div style="padding:12px 14px;border-radius:10px;background:#ecfdf3;border:1px solid #bbf7d0;color:#166534;margin:16px 0">${escapeHtml(copy.saved)}</div>` : "";
  const cards = row.topics.map((topic) => {
    const response = clean(topic.response).toUpperCase();
    const name = `topic_${topic.id}`;
    return `<section style="border:1px solid #dbe2ea;border-radius:12px;padding:18px;margin:18px 0">${topicText(topic)}<fieldset style="border:0;padding:0;margin:16px 0 0"><legend style="font-weight:bold;margin-bottom:10px">${escapeHtml(copy.question)}</legend><label style="display:block;margin:8px 0"><input required type="radio" name="${escapeHtml(name)}" value="DISCUSSED" ${response === "DISCUSSED" ? "checked" : ""} ${row.editable ? "" : "disabled"}> ${escapeHtml(copy.yes)}</label><label style="display:block;margin:8px 0"><input required type="radio" name="${escapeHtml(name)}" value="NOT_YET" ${response === "NOT_YET" ? "checked" : ""} ${row.editable ? "" : "disabled"}> ${escapeHtml(copy.no)}</label></fieldset></section>`;
  }).join("");
  const form = row.editable ? `<form method="post" action="/api/speaking-topic-response">${hidden("token", token)}${hidden("version", row.version)}${cards}<button type="submit" style="background:#2563eb;color:white;border:0;border-radius:9px;padding:12px 18px;font-weight:bold">${escapeHtml(copy.submit)}</button></form>` : `${cards}<p style="padding:12px 14px;border-radius:10px;background:#fff7ed;border:1px solid #fed7aa;color:#9a3412">${escapeHtml(copy.locked)}</p>`;
  return { title: copy.title, language, html: `${noticeHtml}<p>${escapeHtml(copy.intro)}</p>${form}` };
}
function errorResponse(res, error) {
  const status = Number(error?.httpStatus) || 400;
  return secure(res).status(status).send(shell("Speaking-topic response unavailable", `<p>${escapeHtml(error?.message || error)}</p>`, "en", "error"));
}

export function registerSpeakingTopicResponseRoutes(app, dependencies = {}) {
  const load = dependencies.loadSpeakingTopicResponsePage || loadSpeakingTopicResponsePage;
  const submit = dependencies.submitSpeakingTopicResponse || submitSpeakingTopicResponse;
  app.get("/api/speaking-topic-response", async (req, res) => {
    try {
      const token = clean(req.query.token);
      const row = await load(token);
      const page = pageBody(row, token);
      return secure(res).send(shell(page.title, page.html, page.language));
    } catch (error) { return errorResponse(res, error); }
  });
  app.post("/api/speaking-topic-response", async (req, res) => {
    try {
      const row = await submit(req.body || {});
      const token = clean(req.body?.token);
      const page = pageBody(row, token, "saved");
      return secure(res).send(shell(page.title, page.html, page.language, "success"));
    } catch (error) { return errorResponse(res, error); }
  });
}
