import crypto from "node:crypto";
import {
  formatDateTimeForTimezone,
  scoreBandForPercentage,
  studentLanguageForLevel,
  whatsappUrlForTeacher
} from "../submissionPolicy.js";
import { studentFacingName } from "../studentFacingName.js";
import {
  messageCardHtml,
  monoBoxHtml,
  nameCardHtml,
  paragraph,
  statGridHtml,
  whatsappButtonHtml,
  wrapEmailHtml
} from "../emailDesign.js";
import { withSupabaseClient } from "./client.js";

export const EMAIL_SOURCE_TYPES = Object.freeze({
  ASSIGNMENT_RECEIPT_ACK: "ASSIGNMENT_RECEIPT_ACK",
  BAD_SPEAKPIPE_LINK_STUDENT: "BAD_SPEAKPIPE_LINK_STUDENT",
  BAD_SPEAKPIPE_LINK_TEACHER_ALERT: "BAD_SPEAKPIPE_LINK_TEACHER_ALERT",
  BAD_WRITING_SUBMISSION_STUDENT: "BAD_WRITING_SUBMISSION_STUDENT",
  BAD_WRITING_SUBMISSION_TEACHER_ALERT: "BAD_WRITING_SUBMISSION_TEACHER_ALERT",
  QUIZ_COMPLETION_ACK: "QUIZ_COMPLETION_ACK",
  TWICE_MONTHLY_PROGRESS_REPORT: "TWICE_MONTHLY_PROGRESS_REPORT"
});

const ACTIVE_NEGATIVE_STATUSES = [
  "INACTIVE",
  "DROPPED",
  "CANCELLED",
  "CANCELED",
  "ARCHIVED",
  "DISABLED",
  "SUSPENDED",
  "ENDED",
  "COMPLETED"
];

function clean_(value) {
  return String(value ?? "").trim();
}

function lower_(value) {
  return clean_(value).toLowerCase();
}

function normaliseLimit_(value, fallback = 100, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function hashKey_(parts) {
  return crypto.createHash("sha256").update(parts.map(clean_).join("|")).digest("hex").slice(0, 32);
}

function escapeHtml_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function paragraph_(value) {
  return `<p style="margin:0 0 14px;">${escapeHtml_(value).replace(/\n/g, "<br>")}</p>`;
}

function warningButtonHtml_(url, label) {
  if (!url) return "";
  return `
    <div style="margin-top:20px;text-align:center;">
      <a href="${escapeHtml_(url)}" style="display:inline-block;background:#16a34a;color:#ffffff;text-decoration:none;font-weight:bold;border-radius:999px;padding:12px 20px;font-size:14px;">
        ${escapeHtml_(label)}
      </a>
    </div>
  `;
}

function remediationButtonHtml_(url, label, color = "#2563eb") {
  if (!url) return "";
  return `<a href="${escapeHtml_(url)}" style="display:inline-block;margin:6px 8px 6px 0;background:${escapeHtml_(color)};color:#ffffff;text-decoration:none;font-weight:bold;border-radius:10px;padding:12px 18px;font-size:14px;">${escapeHtml_(label)}</a>`;
}

function baseEmailHtml_({ subject, preheader = "", badge = "", headerColor = "#1d4ed8", background = "#f8fafc", children = "" }) {
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml_(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${escapeHtml_(background)};font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml_(preheader)}</div>
    <div style="max-width:700px;margin:0 auto;padding:26px 14px;">
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;box-shadow:0 10px 26px rgba(15,23,42,0.08);">
        <div style="background:${escapeHtml_(headerColor)};padding:22px 24px;color:#ffffff;">
          <div style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;opacity:0.86;">John's English Academy</div>
          ${badge ? `<div style="display:inline-block;margin-top:10px;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);border-radius:999px;padding:5px 10px;font-size:12px;font-weight:bold;">${escapeHtml_(badge)}</div>` : ""}
          <h1 style="font-family:'Trebuchet MS',Arial,Helvetica,sans-serif;font-size:22px;line-height:1.25;margin:10px 0 0;">${escapeHtml_(subject)}</h1>
        </div>
        <div style="padding:24px;">
          ${children}
        </div>
      </div>
    </div>
  </body>
</html>
`.trim();
}

function textJoin_(parts) {
  return parts.map(clean_).filter(Boolean).join("\n\n");
}

function teacherWhatsapp_(enrollment = {}, message = "") {
  return whatsappUrlForTeacher({
    teacher_whatsapp_url: enrollment.teacher_whatsapp_url,
    teacher_whatsapp: enrollment.teacher_whatsapp,
    whatsapp_number: enrollment.teacher_whatsapp_number,
    phone: enrollment.teacher_phone
  }, process.env.DEFAULT_ACADEMY_WHATSAPP || process.env.JEA_SUPPORT_WHATSAPP_NUMBER || "", message);
}

function studentDisplayDate_(value) {
  return formatDateTimeForTimezone(value, process.env.APP_TIMEZONE || process.env.TZ || "Africa/Douala");
}


function teacherButton_(url, language = "en") {
  return whatsappButtonHtml(url, language === "fr" ? "Contacter votre professeur sur WhatsApp" : "Contact your teacher on WhatsApp");
}

function teacherButtonWithPreparedMessage_(url, language = "en", preparedMessage = "") {
  return teacherButton_(url, language);
}

function teacherDisplayName_(enrollment = {}) {
  return clean_(enrollment.teacher_name) || "Teacher";
}

function preparedAssignmentHelpMessage_({ language = "en", enrollment = {}, assignmentKey = "", problem = "general", scoreDisplay = "", quizKey = "" } = {}) {
  const teacherName = teacherDisplayName_(enrollment);
  const key = clean_(assignmentKey);
  const qKey = clean_(quizKey);
  const score = clean_(scoreDisplay);
  const fr = language === "fr";

  const messages = {
    bad_speakpipe: fr
      ? `Bonjour ${teacherName}, j’ai besoin d’aide pour le devoir ${key}. Mon lien SpeakPipe n’est pas accepté et je ne sais pas comment envoyer un bon lien SpeakPipe. Pouvez-vous m’aider s’il vous plaît ?`
      : `Hello ${teacherName}, I need help with assignment ${key}. My SpeakPipe link was not accepted and I don’t know how to submit a good SpeakPipe link. Could you help me please?`,
    writing_empty: fr
      ? `Bonjour ${teacherName}, j’ai besoin d’aide pour le devoir ${key}. Mon writing a été marqué comme vide. Je ne comprends pas bien comment soumettre une réponse complète. Pouvez-vous m’aider s’il vous plaît ?`
      : `Hello ${teacherName}, I need help with assignment ${key}. My writing answer was marked as empty. I don’t fully understand how to submit a complete answer. Could you help me please?`,
    writing_too_short: fr
      ? `Bonjour ${teacherName}, j’ai besoin d’aide pour le devoir ${key}. Mon writing est trop court et n’a pas été accepté pour la correction. Pouvez-vous m’aider à comprendre comment écrire une réponse plus complète ?`
      : `Hello ${teacherName}, I need help with assignment ${key}. My writing answer was too short and was not accepted for correction. Could you help me understand how to write a fuller answer?`,
    writing_link_only: fr
      ? `Bonjour ${teacherName}, j’ai besoin d’aide pour le devoir ${key}. J’ai envoyé un lien comme réponse writing, mais il fallait écrire directement dans le formulaire. Pouvez-vous m’aider à corriger cela ?`
      : `Hello ${teacherName}, I need help with assignment ${key}. I submitted a link as my writing answer, but I needed to write directly in the form. Could you help me correct this?`,
    writing_mostly_link: fr
      ? `Bonjour ${teacherName}, j’ai besoin d’aide pour le devoir ${key}. Ma réponse writing contient surtout un lien et n’a pas été acceptée pour la correction. Pouvez-vous m’aider à soumettre une vraie réponse écrite ?`
      : `Hello ${teacherName}, I need help with assignment ${key}. My writing answer mostly contained a link and was not accepted for correction. Could you help me submit a proper written answer?`,
    assignment_receipt: fr
      ? `Bonjour ${teacherName}, j’ai soumis le devoir ${key}. Pouvez-vous me dire s’il y a quelque chose que je dois vérifier ou améliorer ?`
      : `Hello ${teacherName}, I submitted assignment ${key}. Could you let me know if there is anything I should check or improve?`,
    quiz_excellent: fr
      ? `Bonjour ${teacherName}, j’ai eu ${score} au quiz ${qKey}. Je suis content de mon résultat. Avez-vous un conseil pour continuer à progresser ?`
      : `Hello ${teacherName}, I got ${score} in quiz ${qKey}. I’m happy with my result. Do you have any advice to help me keep improving?`,
    quiz_very_good: fr
      ? `Bonjour ${teacherName}, j’ai eu ${score} au quiz ${qKey}. J’ai bien compris la leçon, mais j’aimerais savoir comment corriger mes petites erreurs. Pouvez-vous me conseiller ?`
      : `Hello ${teacherName}, I got ${score} in quiz ${qKey}. I understood the lesson well, but I would like to know how to correct my small mistakes. Could you advise me?`,
    quiz_good: fr
      ? `Bonjour ${teacherName}, j’ai eu ${score} au quiz ${qKey}. J’ai compris une partie de la leçon, mais certains points ne sont pas encore clairs. Pouvez-vous m’aider s’il vous plaît ?`
      : `Hello ${teacherName}, I got ${score} in quiz ${qKey}. I understood part of the lesson, but some concepts are still not clear. Could you help me please?`,
    quiz_needs_revision: fr
      ? `Bonjour ${teacherName}, j’ai eu ${score} au quiz ${qKey}. J’ai besoin de revoir cette leçon parce que plusieurs points ne sont pas clairs pour moi. Pouvez-vous m’aider s’il vous plaît ?`
      : `Hello ${teacherName}, I got ${score} in quiz ${qKey}. I need to review this lesson because several points are not clear to me. Could you help me please?`,
    quiz_support_needed: fr
      ? `Bonjour ${teacherName}, j’ai eu ${score} au quiz ${qKey}. J’ai vraiment besoin d’aide pour comprendre cette leçon avant de continuer. Pouvez-vous m’accompagner s’il vous plaît ?`
      : `Hello ${teacherName}, I got ${score} in quiz ${qKey}. I really need help understanding this lesson before I continue. Could you guide me please?`
  };

  return messages[problem] || messages.assignment_receipt;
}

function writingIssueProblemKey_(issue = {}) {
  const code = clean_(issue.issue_code).toUpperCase();
  if (code === "BAD_WRITING_EMPTY") return "writing_empty";
  if (code === "BAD_WRITING_TOO_SHORT") return "writing_too_short";
  if (code === "BAD_WRITING_LINK_ONLY") return "writing_link_only";
  if (code === "BAD_WRITING_MOSTLY_LINK") return "writing_mostly_link";
  return "writing_too_short";
}

function quizProblemKey_(bandKey = "") {
  if (bandKey === "excellent") return "quiz_excellent";
  if (bandKey === "very_good") return "quiz_very_good";
  if (bandKey === "good") return "quiz_good";
  if (bandKey === "needs_revision") return "quiz_needs_revision";
  if (bandKey === "support_needed") return "quiz_support_needed";
  return "quiz_good";
}

function scoreTheme_(band) {
  if (band?.theme) return band.theme;
  if (band?.key === "excellent") return "excellent";
  if (band?.key === "very_good") return "veryGood";
  if (band?.key === "good") return "good";
  if (band?.key === "needs_revision") return "revision";
  if (band?.key === "support_needed") return "support";
  return "good";
}

function scoreMessage_(bandKey, language, firstName) {
  const fr = language === "fr";
  const messages = {
    excellent: fr
      ? {
          title: "Vous faites un très bon travail.",
          body: "Continuez avec cette régularité. Quand vous travaillez ainsi, vous construisez une base solide et durable en anglais.",
          subject: `Excellent travail, ${firstName}`,
          hero: "Votre résultat montre une très bonne maîtrise de la leçon."
        }
      : {
          title: "You are doing very well.",
          body: "Keep this rhythm. Consistent practice is turning into strong results.",
          subject: `Excellent work, ${firstName}`,
          hero: "Your result shows very strong understanding of the lesson."
        },
    very_good: fr
      ? {
          title: "Vous êtes sur une très bonne voie.",
          body: "Relisez les petites erreurs pour consolider vos acquis. Ce genre de résultat montre que votre travail porte déjà des fruits.",
          subject: `Très bon résultat, ${firstName}`,
          hero: "Vous comprenez bien la leçon."
        }
      : {
          title: "This is a strong result.",
          body: "Review the few mistakes, then continue with confidence. Your effort is paying off.",
          subject: `Very good result, ${firstName}`,
          hero: "You are understanding the lesson well."
        },
    good: fr
      ? {
          title: "Vous êtes sur la bonne voie.",
          body: "Ce score montre que vous avez compris beaucoup de choses. Prenez quelques minutes pour revoir vos erreurs et vous pourrez passer d’un bon résultat à un très bon résultat.",
          subject: `Bon progrès, ${firstName}`,
          hero: "Vous avez compris les points essentiels."
        }
      : {
          title: "You are on the right track.",
          body: "Take a few minutes to review the mistakes. With a little more practice, you can move from a good result to a very strong one.",
          subject: `Good progress, ${firstName}`,
          hero: "You understood the main points of the lesson."
        },
    needs_revision: fr
      ? {
          title: "Ce n’est pas un échec.",
          body: "C’est un signal utile. Relisez la leçon calmement, reprenez les exemples, puis contactez votre professeur si un point reste difficile.",
          subject: `Révision recommandée, ${firstName}`,
          hero: "Votre quiz est reçu. Certaines notions doivent être reprises."
        }
      : {
          title: "This is not a failure.",
          body: "It is a useful signal. Review the lesson calmly, check the examples again, and contact your teacher if something is still unclear.",
          subject: `Revision recommended, ${firstName}`,
          hero: "Your quiz was received. Some parts of the lesson need more attention."
        },
    support_needed: fr
      ? {
          title: "Ne vous découragez pas.",
          body: "Il vaut mieux demander de l’aide maintenant au lieu d’avancer trop vite. Votre professeur peut vous aider à reprendre les bases et à comprendre les points difficiles.",
          subject: `Aide recommandée, ${firstName}`,
          hero: "Ce résultat montre que cette leçon a besoin de plus d’attention."
        }
      : {
          title: "Let’s improve this together.",
          body: "This lesson needs more attention, but you can still improve. Your teacher can help you understand the difficult points and rebuild the basics with confidence.",
          subject: `Support recommended, ${firstName}`,
          hero: "Your result shows that extra support would be useful."
        }
  };
  return messages[bandKey] || messages.good;
}

function badSpeakpipeStudentEmail_({ submission, student, enrollment, linkInfo }) {
  const level = clean_(submission.level || enrollment.level);
  const language = studentLanguageForLevel(level);
  const studentFirstName = studentFacingName(student.full_name || submission.student_name, language === "fr" ? "cher apprenant" : "there");
  const assignmentKey = clean_(submission.assignment_key);
  const submittedAt = studentDisplayDate_(submission.submitted_at);
  const audioLink = clean_(submission.audio_link || submission.speakpipe_link);
  const writtenAnswer = clean_(submission.writing_answer || submission.answer_text);
  const preparedMessage = preparedAssignmentHelpMessage_({ language, enrollment, assignmentKey, problem: "bad_speakpipe" });
  const whatsappUrl = teacherWhatsapp_(enrollment, preparedMessage);
  const theme = "warning";

  if (language === "fr") {
    const subject = "Action nécessaire : votre lien SpeakPipe n’est pas valide";
    const bodyText = textJoin_([
      `Bonjour ${studentFirstName},`,
      "Votre writing est reçu, mais la partie speaking ne peut pas encore être traitée.",
      `Devoir : ${assignmentKey}`,
      submittedAt ? `Date de soumission : ${submittedAt}` : "",
      `Votre réponse écrite reçue :\n${writtenAnswer || "Votre réponse écrite n’est pas affichée dans cet email."}`,
      `Lien envoyé :\n${audioLink || "Aucun lien reçu"}`,
      "Le lien doit être un lien SpeakPipe complet. Une page d’accueil SpeakPipe ou un lien Google Drive ne peut pas être utilisé pour la correction speaking.",
      whatsappUrl ? `Contacter votre professeur : ${whatsappUrl}` : "",
      "Ne vous découragez pas. Votre réponse écrite a été reçue ; il faut seulement corriger le lien audio.",
      "John’s English Academy"
    ]);
    const bodyHtml = wrapEmailHtml({
      subject,
      preheader: "Votre lien speaking doit être corrigé.",
      badge: "Action nécessaire",
      theme,
      background: "#eef4ff",
      children: `
        ${nameCardHtml({ eyebrow: "Action nécessaire", name: studentFirstName, subtitle: "Votre speaking ne peut pas encore être traité.", theme })}
        ${paragraph("Votre writing est reçu, mais la partie speaking ne peut pas encore être traitée.")}
        ${statGridHtml([
          { label: "Devoir", value: assignmentKey },
          { label: "Date", value: submittedAt || "—" },
          { label: "Statut", value: "Lien à corriger" }
        ])}
        ${messageCardHtml({ title: "Le lien envoyé n’est pas valide.", body: "Le lien doit être un lien SpeakPipe complet. Une page d’accueil SpeakPipe ou un lien Google Drive ne peut pas être utilisé pour la correction speaking.", theme })}
        <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Votre réponse écrite reçue :</strong></p>
        ${monoBoxHtml(writtenAnswer || "Votre réponse écrite n’est pas affichée dans cet email.")}
        <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Lien envoyé :</strong></p>
        ${monoBoxHtml(audioLink || "Aucun lien reçu")}
        ${teacherButtonWithPreparedMessage_(whatsappUrl, "fr", preparedMessage)}
        ${paragraph("Ne vous découragez pas. Votre réponse écrite a été reçue ; il faut seulement corriger le lien audio.")}
      `
    });
    return { subject, bodyText, bodyHtml };
  }

  const subject = "Action needed: your SpeakPipe link is not valid";
  const bodyText = textJoin_([
    `Hello ${studentFirstName},`,
    "Your writing was received, but your speaking part cannot be processed yet.",
    `Assignment: ${assignmentKey}`,
    submittedAt ? `Submitted at: ${submittedAt}` : "",
    `Written answer received:\n${writtenAnswer || "Your written answer is not displayed in this email."}`,
    `Submitted link:\n${audioLink || "No link received"}`,
    "Please resend a complete SpeakPipe message link. Home-page links or Google Drive links cannot be processed for speaking review.",
    whatsappUrl ? `Contact your teacher: ${whatsappUrl}` : "",
    "Your written answer was received. Only the speaking link needs to be corrected.",
    "John’s English Academy"
  ]);
  const bodyHtml = wrapEmailHtml({
    subject,
    preheader: "Your speaking link needs correction.",
    badge: "Action needed",
    theme,
    background: "#eef4ff",
    children: `
      ${nameCardHtml({ eyebrow: "Action needed", name: studentFirstName, subtitle: "Your speaking part cannot be processed yet.", theme })}
      ${paragraph("Your writing was received, but your speaking part cannot be processed yet.")}
      ${statGridHtml([
        { label: "Assignment", value: assignmentKey },
        { label: "Submitted", value: submittedAt || "—" },
        { label: "Status", value: "Link needs correction" }
      ])}
      ${messageCardHtml({ title: "The submitted link is not valid.", body: "Please resend a complete SpeakPipe message link. Home-page links or Google Drive links cannot be processed for speaking review.", theme })}
      <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Your written answer:</strong></p>
      ${monoBoxHtml(writtenAnswer || "Your written answer is not displayed in this email.")}
      <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Link submitted:</strong></p>
      ${monoBoxHtml(audioLink || "No link received")}
      ${teacherButtonWithPreparedMessage_(whatsappUrl, "en", preparedMessage)}
      ${paragraph("Your written answer was received. Only the speaking link needs to be corrected.")}
    `
  });
  return { subject, bodyText, bodyHtml };
}

function badWritingStudentEmail_({ submission, student, enrollment, writingInfo }) {
  const level = clean_(submission.level || enrollment.level);
  const language = studentLanguageForLevel(level);
  const studentFirstName = studentFacingName(student.full_name || submission.student_name, language === "fr" ? "cher apprenant" : "there");
  const assignmentKey = clean_(submission.assignment_key);
  const submittedAt = studentDisplayDate_(submission.submitted_at);
  const writingAnswer = clean_(submission.writing_answer || submission.answer_text);
  const problem = writingIssueProblemKey_(writingInfo);
  const preparedMessage = preparedAssignmentHelpMessage_({ language, enrollment, assignmentKey, problem });
  const whatsappUrl = teacherWhatsapp_(enrollment, preparedMessage);
  const theme = "warning";
  const wordCount = Number(writingInfo?.word_count || 0);

  const problemFr = {
    writing_empty: "vous avez choisi une option de writing, mais vous n’avez pas écrit de réponse",
    writing_too_short: `votre réponse contient seulement ${wordCount} mot(s)`,
    writing_link_only: "la réponse writing contient un lien au lieu d’une réponse écrite",
    writing_mostly_link: "votre réponse contient surtout un lien, avec très peu de texte écrit"
  }[problem] || "votre réponse writing ne peut pas être corrigée";

  const problemEn = {
    writing_empty: "you selected a writing option, but you did not write an answer",
    writing_too_short: `your answer contains only ${wordCount} word(s)`,
    writing_link_only: "the writing answer contains a link instead of a written response",
    writing_mostly_link: "your answer is mostly a link, with very little written text"
  }[problem] || "your writing answer cannot be corrected";

  if (language === "fr") {
    const subject = problem === "writing_too_short" ? `Writing trop court — ${assignmentKey}` : `Writing à corriger — ${assignmentKey}`;
    const bodyText = textJoin_([
      `Bonjour ${studentFirstName},`,
      `Votre devoir ${assignmentKey} a été reçu, mais votre writing ne peut pas être corrigé.`,
      `Problème détecté : ${problemFr}.`,
      "Votre writing ne sera pas corrigé et aucun score writing ne sera attribué pour cette soumission. Veuillez renvoyer une réponse complète pour ce même devoir.",
      whatsappUrl ? `Contacter votre professeur : ${whatsappUrl}` : "",
      "John’s English Academy"
    ]);
    const bodyHtml = wrapEmailHtml({
      subject,
      preheader: "Votre writing doit être corrigé avant évaluation.",
      badge: "Action nécessaire",
      theme,
      background: "#eef4ff",
      children: `
        ${nameCardHtml({ eyebrow: "Action nécessaire", name: studentFirstName, subtitle: "Votre writing ne peut pas encore être corrigé.", theme })}
        ${statGridHtml([
          { label: "Devoir", value: assignmentKey },
          { label: "Date", value: submittedAt || "—" },
          { label: "Problème", value: problemFr }
        ])}
        ${messageCardHtml({ title: "Votre writing ne sera pas noté.", body: "Votre writing ne sera pas corrigé et aucun score writing ne sera attribué pour cette soumission. Veuillez renvoyer une réponse complète pour ce même devoir.", theme })}
        <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Réponse writing reçue :</strong></p>
        ${monoBoxHtml(writingAnswer || "Aucune réponse writing reçue.")}
        ${teacherButtonWithPreparedMessage_(whatsappUrl, "fr", preparedMessage)}
      `
    });
    return { subject, bodyText, bodyHtml };
  }

  const subject = problem === "writing_too_short" ? `Writing too short — ${assignmentKey}` : `Writing needs correction — ${assignmentKey}`;
  const bodyText = textJoin_([
    `Hello ${studentFirstName},`,
    `Your assignment ${assignmentKey} was received, but your writing answer cannot be corrected.`,
    `Problem detected: ${problemEn}.`,
    "Your writing will not be corrected and no writing score will be assigned for this submission. Please submit a complete written answer for the same assignment.",
    whatsappUrl ? `Contact your teacher: ${whatsappUrl}` : "",
    "John’s English Academy"
  ]);
  const bodyHtml = wrapEmailHtml({
    subject,
    preheader: "Your writing needs correction before assessment.",
    badge: "Action needed",
    theme,
    background: "#eef4ff",
    children: `
      ${nameCardHtml({ eyebrow: "Action needed", name: studentFirstName, subtitle: "Your writing cannot be corrected yet.", theme })}
      ${statGridHtml([
        { label: "Assignment", value: assignmentKey },
        { label: "Submitted", value: submittedAt || "—" },
        { label: "Problem", value: problemEn }
      ])}
      ${messageCardHtml({ title: "Your writing will not be scored.", body: "Your writing will not be corrected and no writing score will be assigned for this submission. Please submit a complete written answer for the same assignment.", theme })}
      <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Writing answer received:</strong></p>
      ${monoBoxHtml(writingAnswer || "No writing answer received.")}
      ${teacherButtonWithPreparedMessage_(whatsappUrl, "en", preparedMessage)}
    `
  });
  return { subject, bodyText, bodyHtml };
}

function teacherBadWritingAlertEmail_({ submission, student, enrollment, writingInfo }) {
  const teacherName = clean_(enrollment.teacher_name) || "Teacher";
  const studentName = clean_(student.full_name || submission.student_name || student.email || "Student");
  const studentEmail = lower_(student.email || submission.student_email);
  const assignmentKey = clean_(submission.assignment_key);
  const submittedAt = studentDisplayDate_(submission.submitted_at);
  const writingAnswer = clean_(submission.writing_answer || submission.answer_text);
  const issue = clean_(writingInfo?.issue_message) || "The writing answer cannot be assessed.";
  const wordCount = Number(writingInfo?.word_count || 0);
  const subject = `Invalid writing submission — ${studentName} — ${assignmentKey}`;
  const theme = "teacher";

  const bodyText = textJoin_([
    `Hello ${teacherName},`,
    "A student submitted an assignment, but the writing answer cannot be assessed.",
    `Student: ${studentName}`,
    `Email: ${studentEmail}`,
    `Level: ${clean_(submission.level || enrollment.level)}`,
    `Assignment: ${assignmentKey}`,
    submittedAt ? `Submitted at: ${submittedAt}` : "",
    `Detected issue: ${issue}`,
    `Word count: ${wordCount}`,
    writingAnswer ? `Writing answer received:\n${writingAnswer}` : "Writing answer unavailable.",
    "No writing correction job was created, no writing review will be generated, and no writing score will be assigned. The student has been notified.",
    "John’s English Academy"
  ]);

  const bodyHtml = wrapEmailHtml({
    subject,
    preheader: "A student may need help with a writing submission.",
    badge: "Teacher alert",
    theme,
    background: "#f4f6f8",
    children: `
      ${statGridHtml([
        { label: "Student", value: studentName || "—" },
        { label: "Student email", value: studentEmail || "—" },
        { label: "Level", value: clean_(submission.level || enrollment.level) || "—" },
        { label: "Assignment", value: assignmentKey || "—" },
        { label: "Submitted at", value: submittedAt || "—" },
        { label: "Word count", value: String(wordCount) },
        { label: "Action", value: "Follow up" }
      ])}
      ${messageCardHtml({ title: "No writing correction job was created.", body: "No writing review will be generated and no writing score will be assigned. The student has been notified and encouraged to contact you.", theme })}
      <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Detected issue:</strong> ${escapeHtml_(issue)}</p>
      <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Writing answer received:</strong></p>
      ${monoBoxHtml(writingAnswer || "Writing answer unavailable.")}
    `
  });
  return { subject, bodyText, bodyHtml };
}

function assignmentReceiptEmail_({ submission, student, enrollment }) {
  const level = clean_(submission.level || enrollment.level);
  const language = studentLanguageForLevel(level);
  const studentFirstName = studentFacingName(student.full_name || submission.student_name, language === "fr" ? "cher apprenant" : "there");
  const assignmentKey = clean_(submission.assignment_key);
  const submittedAt = studentDisplayDate_(submission.submitted_at);
  const preparedMessage = preparedAssignmentHelpMessage_({ language, enrollment, assignmentKey, problem: "assignment_receipt" });
  const whatsappUrl = teacherWhatsapp_(enrollment, preparedMessage);
  const theme = "ack";

  if (language === "fr") {
    const subject = `Devoir reçu — ${assignmentKey}`;
    const bodyText = textJoin_([
      `Bonjour ${studentFirstName},`,
      "Votre writing et votre lien SpeakPipe ont bien été reçus.",
      `Devoir : ${assignmentKey}`,
      submittedAt ? `Date de soumission : ${submittedAt}` : "",
      "Vous avez fait le nécessaire pour cette soumission. La correction va être traitée.",
      "Si vous envoyez une autre réponse pour le même devoir, seule la dernière soumission sera gardée comme version valide.",
      whatsappUrl ? `Contacter votre professeur : ${whatsappUrl}` : "",
      "John’s English Academy"
    ]);
    const bodyHtml = wrapEmailHtml({
      subject,
      preheader: "Votre devoir a bien été reçu.",
      badge: "Devoir reçu",
      theme,
      background: "#eef4ff",
      children: `
        ${nameCardHtml({ eyebrow: "Devoir reçu", name: studentFirstName, subtitle: "Votre writing et votre lien SpeakPipe ont bien été reçus.", theme })}
        ${statGridHtml([
          { label: "Devoir", value: assignmentKey },
          { label: "Date", value: submittedAt || "—" },
          { label: "Statut", value: "Reçu" }
        ])}
        ${messageCardHtml({ title: "La correction va être traitée.", body: "Vous avez fait le nécessaire pour cette soumission. Si vous envoyez une autre réponse pour le même devoir, seule la dernière soumission sera gardée comme version valide.", theme })}
        ${teacherButtonWithPreparedMessage_(whatsappUrl, "fr", preparedMessage)}
      `
    });
    return { subject, bodyText, bodyHtml };
  }

  const subject = `Assignment received — ${assignmentKey}`;
  const bodyText = textJoin_([
    `Hello ${studentFirstName},`,
    "Your writing and SpeakPipe link were received successfully.",
    `Assignment: ${assignmentKey}`,
    submittedAt ? `Submitted at: ${submittedAt}` : "",
    "Your correction will be processed.",
    "If you submit again for the same assignment, only your latest submission will remain valid.",
    whatsappUrl ? `Contact your teacher: ${whatsappUrl}` : "",
    "John’s English Academy"
  ]);
  const bodyHtml = wrapEmailHtml({
    subject,
    preheader: "Your assignment was received.",
    badge: "Assignment received",
    theme,
    background: "#eef4ff",
    children: `
      ${nameCardHtml({ eyebrow: "Assignment received", name: studentFirstName, subtitle: "Your writing and SpeakPipe link were received successfully.", theme })}
      ${statGridHtml([
        { label: "Assignment", value: assignmentKey },
        { label: "Submitted", value: submittedAt || "—" },
        { label: "Status", value: "Received" }
      ])}
      ${messageCardHtml({ title: "Your correction will be processed.", body: "If you submit again for the same assignment, only your latest submission will remain valid.", theme })}
      ${teacherButtonWithPreparedMessage_(whatsappUrl, "en", preparedMessage)}
    `
  });
  return { subject, bodyText, bodyHtml };
}

function teacherBadSpeakpipeAlertEmail_({ submission, student, enrollment, linkInfo, remediation }) {
  const teacherName = clean_(enrollment.teacher_name) || "Teacher";
  const studentName = clean_(student.full_name || submission.student_name || student.email || "Student");
  const studentEmail = lower_(student.email || submission.student_email);
  const assignmentKey = clean_(submission.assignment_key);
  const submittedAt = studentDisplayDate_(submission.submitted_at);
  const audioLink = clean_(submission.audio_link || submission.speakpipe_link);
  const writtenAnswer = clean_(submission.writing_answer || submission.answer_text);
  const issue = clean_(linkInfo?.issue_message) || "The SpeakPipe link is invalid or incomplete.";
  const correctUrl = clean_(remediation?.correct_url);
  const resolveUrl = clean_(remediation?.resolve_url);
  const subject = `Invalid SpeakPipe link — ${studentName} — ${assignmentKey}`;
  const theme = "teacher";

  const bodyText = textJoin_([
    `Hello ${teacherName},`,
    "A student submitted an assignment, but the speaking link cannot be processed.",
    `Student: ${studentName}`,
    `Email: ${studentEmail}`,
    `Level: ${clean_(submission.level || enrollment.level)}`,
    `Assignment: ${assignmentKey}`,
    submittedAt ? `Submitted at: ${submittedAt}` : "",
    `Submitted link:\n${audioLink || "No link received"}`,
    writtenAnswer ? `Written answer received:\n${writtenAnswer}` : "Written answer unavailable.",
    `Detected issue: ${issue}`,
    `Open the correction page: ${correctUrl}`,
    `If no recording can be found, resolve without speaking: ${resolveUrl}`,
    "The page remains available if you need to correct a mistake, until downstream speaking processing begins.",
    "John’s English Academy"
  ]);

  const bodyHtml = wrapEmailHtml({
    subject,
    preheader: "A student may need support with a SpeakPipe submission.",
    badge: "Teacher alert",
    theme,
    background: "#f4f6f8",
    children: `
      ${statGridHtml([
        { label: "Student", value: studentName || "—" },
        { label: "Student email", value: studentEmail || "—" },
        { label: "Level", value: clean_(submission.level || enrollment.level) || "—" },
        { label: "Assignment", value: assignmentKey || "—" },
        { label: "Submitted at", value: submittedAt || "—" },
        { label: "Action", value: "Follow up" }
      ])}
      ${messageCardHtml({ title: "Teacher action is required.", body: "Open the secure page to enter a verified SpeakPipe link. If no recording can be found, explicitly continue without speaking.", theme })}
      <div style="margin:18px 0;">
        ${remediationButtonHtml_(correctUrl, "Enter the correct speaking link")}
        ${remediationButtonHtml_(resolveUrl, "Continue without speaking", "#b42318")}
      </div>
      <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Submitted link:</strong></p>
      ${monoBoxHtml(audioLink || "No link received")}
      <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Written answer received:</strong></p>
      ${monoBoxHtml(writtenAnswer || "Written answer unavailable.")}
      <p style="margin:16px 0 8px;font-size:15px;color:#344054;"><strong>Detected issue:</strong> ${escapeHtml_(issue)}</p>
    `
  });
  return { subject, bodyText, bodyHtml };
}

function quizCompletionEmail_({ quiz, student, enrollment }) {
  const level = clean_(quiz.level || enrollment.level);
  const language = studentLanguageForLevel(level);
  const studentFirstName = studentFacingName(student.full_name, language === "fr" ? "cher apprenant" : "there");
  const percentage = Number.isFinite(Number(quiz.percentage)) ? Number(quiz.percentage) : Number(quiz.score);
  const band = scoreBandForPercentage(percentage);
  const theme = scoreTheme_(band);
  const scoreDisplay = clean_(quiz.score_display) || (clean_(quiz.score) ? `${quiz.score}/100` : language === "fr" ? "Score reçu" : "Score received");
  const quizKey = clean_(quiz.quiz_key);
  const msg = scoreMessage_(band.key, language, studentFirstName);
  const preparedMessage = preparedAssignmentHelpMessage_({ language, enrollment, quizKey, scoreDisplay, problem: quizProblemKey_(band.key) });
  const whatsappUrl = teacherWhatsapp_(enrollment, preparedMessage);

  if (language === "fr") {
    const subject = `${msg.subject} — Quiz ${quizKey}`;
    const bodyText = textJoin_([
      `Bonjour ${studentFirstName},`,
      `Votre quiz ${quizKey} a bien été reçu.`,
      `Score : ${scoreDisplay}`,
      msg.body,
      whatsappUrl ? `Contacter votre professeur : ${whatsappUrl}` : "",
      "John’s English Academy"
    ]);
    const bodyHtml = wrapEmailHtml({
      subject,
      preheader: `Score : ${scoreDisplay}`,
      badge: band.labelFr,
      theme,
      background: "#eef4ff",
      children: `
        ${nameCardHtml({ eyebrow: band.labelFr, name: studentFirstName, subtitle: msg.hero, theme })}
        ${statGridHtml([
          { label: "Score", value: scoreDisplay },
          { label: "Quiz", value: quizKey },
          { label: "Appréciation", value: band.labelFr }
        ])}
        ${messageCardHtml({ title: msg.title, body: msg.body, theme })}
        ${teacherButtonWithPreparedMessage_(whatsappUrl, "fr", preparedMessage)}
      `
    });
    return { subject, bodyText, bodyHtml };
  }

  const subject = `${msg.subject} — Quiz ${quizKey}`;
  const bodyText = textJoin_([
    `Hello ${studentFirstName},`,
    `Your quiz ${quizKey} was received.`,
    `Score: ${scoreDisplay}`,
    msg.body,
    whatsappUrl ? `Contact your teacher: ${whatsappUrl}` : "",
    "John’s English Academy"
  ]);
  const bodyHtml = wrapEmailHtml({
    subject,
    preheader: `Score: ${scoreDisplay}`,
    badge: band.labelEn,
    theme,
    background: "#eef4ff",
    children: `
      ${nameCardHtml({ eyebrow: band.labelEn, name: studentFirstName, subtitle: msg.hero, theme })}
      ${statGridHtml([
        { label: "Score", value: scoreDisplay },
        { label: "Quiz", value: quizKey },
        { label: "Meaning", value: band.labelEn }
      ])}
      ${messageCardHtml({ title: msg.title, body: msg.body, theme })}
      ${teacherButtonWithPreparedMessage_(whatsappUrl, "en", preparedMessage)}
    `
  });
  return { subject, bodyText, bodyHtml };
}

async function insertEmailQueue_(client, row) {
  const result = await client.query(
    `
      insert into email_queue (
        source_type,
        source_id,
        idempotency_key,
        status,
        recipient_role,
        recipient_email,
        recipient_name,
        teacher_id,
        student_id,
        enrollment_id,
        subject,
        body_html,
        body_text,
        payload_json,
        provider,
        created_at,
        updated_at
      ) values (
        $1,
        $2::uuid,
        $3,
        'QUEUED',
        $4,
        $5,
        $6,
        $7::uuid,
        $8::uuid,
        $9::uuid,
        $10,
        $11,
        $12,
        $13::jsonb,
        'BREVO',
        now(),
        now()
      )
      on conflict (idempotency_key) do update
      set
        updated_at = now(),
        recipient_email = case when email_queue.status = 'SENT' then email_queue.recipient_email else excluded.recipient_email end,
        recipient_name = case when email_queue.status = 'SENT' then email_queue.recipient_name else excluded.recipient_name end,
        subject = case when email_queue.status = 'SENT' then email_queue.subject else excluded.subject end,
        body_html = case when email_queue.status = 'SENT' then email_queue.body_html else excluded.body_html end,
        body_text = case when email_queue.status = 'SENT' then email_queue.body_text else excluded.body_text end,
        payload_json = case when email_queue.status = 'SENT' then email_queue.payload_json else excluded.payload_json end
      returning id, source_type, status, recipient_email, recipient_name, subject, idempotency_key, created_at, updated_at, sent_at
    `,
    [
      row.source_type,
      row.source_id,
      row.idempotency_key,
      row.recipient_role || "STUDENT",
      row.recipient_email,
      row.recipient_name,
      row.teacher_id || null,
      row.student_id || null,
      row.enrollment_id || null,
      row.subject,
      row.body_html,
      row.body_text,
      JSON.stringify(row.payload_json || {})
    ]
  );

  return result.rows[0] || null;
}

export async function queueBadSpeakpipeLinkEmails(client, { submission, student, enrollment, linkInfo, remediation } = {}) {
  if (!client || !submission || !student || !enrollment) return [];

  const queued = [];
  const teacherRendered = teacherBadSpeakpipeAlertEmail_({ submission, student, enrollment, linkInfo, remediation });
  const linkHash = hashKey_([submission.audio_link || submission.speakpipe_link || ""]);
  const headTeacherBcc = clean_(process.env.HEAD_TEACHER_EMAIL || process.env.JEA_HEAD_TEACHER_EMAIL || "");

  if (enrollment.teacher_email) {
    queued.push(await insertEmailQueue_(client, {
      source_type: EMAIL_SOURCE_TYPES.BAD_SPEAKPIPE_LINK_TEACHER_ALERT,
      source_id: submission.id,
      idempotency_key: `bad-speakpipe-teacher:${submission.id}:${linkHash}:${clean_(linkInfo.issue_code)}`,
      recipient_role: "TEACHER",
      recipient_email: lower_(enrollment.teacher_email),
      recipient_name: clean_(enrollment.teacher_name) || lower_(enrollment.teacher_email),
      teacher_id: enrollment.teacher_id,
      student_id: student.id,
      enrollment_id: enrollment.id,
      subject: teacherRendered.subject,
      body_html: teacherRendered.bodyHtml,
      body_text: teacherRendered.bodyText,
      payload_json: {
        source: "bad-speakpipe-link-teacher-alert",
        bcc_email: headTeacherBcc,
        remediation_case_id: remediation?.case?.id || null,
        submission_id: submission.id,
        assignment_key: submission.assignment_key,
        student_email: student.email,
        issue: linkInfo
      }
    }));
  }

  return queued.filter(Boolean);
}

export async function queueBadWritingSubmissionEmails(client, { submission, student, enrollment, writingInfo } = {}) {
  if (!client || !submission || !student || !enrollment || !writingInfo || writingInfo.valid) return [];

  const queued = [];
  const studentRendered = badWritingStudentEmail_({ submission, student, enrollment, writingInfo });
  const teacherRendered = teacherBadWritingAlertEmail_({ submission, student, enrollment, writingInfo });
  const issueHash = hashKey_([submission.writing_answer || submission.answer_text || "", writingInfo.issue_code || ""]);
  const headTeacherBcc = clean_(process.env.HEAD_TEACHER_EMAIL || process.env.JEA_HEAD_TEACHER_EMAIL || "");

  queued.push(await insertEmailQueue_(client, {
    source_type: EMAIL_SOURCE_TYPES.BAD_WRITING_SUBMISSION_STUDENT,
    source_id: submission.id,
    idempotency_key: `bad-writing-student:${submission.id}:${issueHash}:${clean_(writingInfo.issue_code)}`,
    recipient_role: "STUDENT",
    recipient_email: lower_(student.email),
    recipient_name: studentFacingName(student.full_name, lower_(student.email)),
    teacher_id: enrollment.teacher_id,
    student_id: student.id,
    enrollment_id: enrollment.id,
    subject: studentRendered.subject,
    body_html: studentRendered.bodyHtml,
    body_text: studentRendered.bodyText,
    payload_json: {
      source: "bad-writing-submission-student-warning",
      submission_id: submission.id,
      assignment_key: submission.assignment_key,
      writing_answer: submission.writing_answer || submission.answer_text || "",
      issue: writingInfo
    }
  }));

  if (enrollment.teacher_email) {
    queued.push(await insertEmailQueue_(client, {
      source_type: EMAIL_SOURCE_TYPES.BAD_WRITING_SUBMISSION_TEACHER_ALERT,
      source_id: submission.id,
      idempotency_key: `bad-writing-teacher:${submission.id}:${issueHash}:${clean_(writingInfo.issue_code)}`,
      recipient_role: "TEACHER",
      recipient_email: lower_(enrollment.teacher_email),
      recipient_name: clean_(enrollment.teacher_name) || lower_(enrollment.teacher_email),
      teacher_id: enrollment.teacher_id,
      student_id: student.id,
      enrollment_id: enrollment.id,
      subject: teacherRendered.subject,
      body_html: teacherRendered.bodyHtml,
      body_text: teacherRendered.bodyText,
      payload_json: {
        source: "bad-writing-submission-teacher-alert",
        bcc_email: headTeacherBcc,
        submission_id: submission.id,
        assignment_key: submission.assignment_key,
        student_email: student.email,
        issue: writingInfo
      }
    }));
  }

  return queued.filter(Boolean);
}

export async function queueAssignmentReceiptEmail(client, { submission, student, enrollment } = {}) {
  if (!client || !submission || !student || !enrollment) return null;

  const rendered = assignmentReceiptEmail_({ submission, student, enrollment });
  return insertEmailQueue_(client, {
    source_type: EMAIL_SOURCE_TYPES.ASSIGNMENT_RECEIPT_ACK,
    source_id: submission.id,
    idempotency_key: `assignment-receipt:${submission.id}`,
    recipient_role: "STUDENT",
    recipient_email: lower_(student.email),
    recipient_name: studentFacingName(student.full_name, lower_(student.email)),
    teacher_id: enrollment.teacher_id,
    student_id: student.id,
    enrollment_id: enrollment.id,
    subject: rendered.subject,
    body_html: rendered.bodyHtml,
    body_text: rendered.bodyText,
    payload_json: {
      source: "assignment-reception-acknowledgement",
      submission_id: submission.id,
      assignment_key: submission.assignment_key,
      submitted_at: submission.submitted_at
    }
  });
}

export async function queueQuizCompletionEmail(client, { quiz, student, enrollment, importEvent = null } = {}) {
  if (!client || !quiz || !student || !enrollment) return null;

  const rendered = quizCompletionEmail_({ quiz, student, enrollment });
  const attemptKey = clean_(
    importEvent?.id ||
    quiz.import_event_id ||
    quiz.submitted_at ||
    quiz.updated_at ||
    "latest"
  );

  return insertEmailQueue_(client, {
    source_type: EMAIL_SOURCE_TYPES.QUIZ_COMPLETION_ACK,
    source_id: quiz.id,
    idempotency_key: `quiz-confirmation:${quiz.id}:${attemptKey}`,
    recipient_role: "STUDENT",
    recipient_email: lower_(student.email),
    recipient_name: studentFacingName(student.full_name, lower_(student.email)),
    teacher_id: enrollment.teacher_id,
    student_id: student.id,
    enrollment_id: enrollment.id,
    subject: rendered.subject,
    body_html: rendered.bodyHtml,
    body_text: rendered.bodyText,
    payload_json: {
      source: "quiz-completion-confirmation",
      quiz_id: quiz.id,
      quiz_key: quiz.quiz_key,
      import_event_id: importEvent?.id || quiz.import_event_id || null,
      submitted_at: quiz.submitted_at || null,
      score: quiz.score,
      max_score: quiz.max_score,
      percentage: quiz.percentage,
      score_display: quiz.score_display
    }
  });
}

const EMAIL_DESIGN_SAMPLE_SOURCE_TYPES = Object.freeze({
  ASSIGNMENT_RECEIPT: "EMAIL_DESIGN_SAMPLE_ASSIGNMENT_RECEIPT",
  BAD_SPEAKPIPE_STUDENT: "EMAIL_DESIGN_SAMPLE_BAD_SPEAKPIPE_STUDENT",
  BAD_SPEAKPIPE_TEACHER: "EMAIL_DESIGN_SAMPLE_BAD_SPEAKPIPE_TEACHER",
  QUIZ_CONFIRMATION: "EMAIL_DESIGN_SAMPLE_QUIZ_CONFIRMATION"
});

function testRecipientFromOptions_(options = {}) {
  return lower_(
    options.testRecipient ||
    options.test_recipient ||
    process.env.EMAIL_DESIGN_TEST_RECIPIENT ||
    process.env.STUDENT_EMAIL_TEST_RECIPIENT ||
    process.env.EMAIL_TEST_RECIPIENT ||
    process.env.HEAD_TEACHER_EMAIL ||
    process.env.JEA_HEAD_TEACHER_EMAIL ||
    ""
  );
}

async function fetchSampleAssignment_(client) {
  const result = await client.query(
    `
      select
        si.*,
        s.id as sample_student_id,
        s.full_name as sample_student_name,
        lower(s.email) as sample_student_email,
        s.phone as sample_student_phone,
        s.whatsapp_number as sample_student_whatsapp,
        e.id as sample_enrollment_id,
        e.teacher_id as sample_teacher_id,
        e.level as sample_enrollment_level,
        t.full_name as sample_teacher_name,
        lower(t.email) as sample_teacher_email,
        t.phone as sample_teacher_phone,
        t.whatsapp_number as sample_teacher_whatsapp_number
      from submission_inbox si
      join students s on s.id = si.student_id
      left join enrollments e on e.student_id = s.id and coalesce(e.active, true) is true
      left join teachers t on t.id = coalesce(si.teacher_id, e.teacher_id)
      where lower(coalesce(s.email, '')) <> ''
        and coalesce(si.assignment_key, '') <> ''
        and coalesce(si.writing_answer, si.answer_text, '') <> ''
      order by random()
      limit 1
    `
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    submission: row,
    student: {
      id: row.sample_student_id,
      full_name: row.sample_student_name,
      email: row.sample_student_email,
      phone: row.sample_student_phone,
      whatsapp_number: row.sample_student_whatsapp
    },
    enrollment: {
      id: row.sample_enrollment_id,
      teacher_id: row.sample_teacher_id || row.teacher_id,
      level: row.sample_enrollment_level || row.level,
      teacher_name: row.sample_teacher_name,
      teacher_email: row.sample_teacher_email,
      teacher_phone: row.sample_teacher_phone,
      teacher_whatsapp_number: row.sample_teacher_whatsapp_number
    }
  };
}

async function fetchSampleQuiz_(client) {
  const result = await client.query(
    `
      select
        qs.*,
        s.id as sample_student_id,
        s.full_name as sample_student_name,
        lower(s.email) as sample_student_email,
        s.phone as sample_student_phone,
        s.whatsapp_number as sample_student_whatsapp,
        e.id as sample_enrollment_id,
        e.teacher_id as sample_teacher_id,
        e.level as sample_enrollment_level,
        t.full_name as sample_teacher_name,
        lower(t.email) as sample_teacher_email,
        t.phone as sample_teacher_phone,
        t.whatsapp_number as sample_teacher_whatsapp_number
      from quiz_scores qs
      join students s on s.id = qs.student_id
      left join enrollments e on e.student_id = s.id and coalesce(e.active, true) is true
      left join teachers t on t.id = coalesce(qs.teacher_id, e.teacher_id)
      where lower(coalesce(s.email, '')) <> ''
        and coalesce(qs.quiz_key, '') <> ''
      order by random()
      limit 1
    `
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    quiz: row,
    student: {
      id: row.sample_student_id,
      full_name: row.sample_student_name,
      email: row.sample_student_email,
      phone: row.sample_student_phone,
      whatsapp_number: row.sample_student_whatsapp
    },
    enrollment: {
      id: row.sample_enrollment_id,
      teacher_id: row.sample_teacher_id || row.teacher_id,
      level: row.sample_enrollment_level || row.level,
      teacher_name: row.sample_teacher_name,
      teacher_email: row.sample_teacher_email,
      teacher_phone: row.sample_teacher_phone,
      teacher_whatsapp_number: row.sample_teacher_whatsapp_number
    }
  };
}

async function insertDesignSampleEmail_(client, { sourceType, sampleKey, rendered, testRecipient, recipientRole = "STUDENT", sourceId = null, student = {}, enrollment = {}, payload = {} }) {
  return insertEmailQueue_(client, {
    source_type: sourceType,
    source_id: sourceId,
    idempotency_key: `email-design-sample:${sampleKey}:${testRecipient}`,
    recipient_role: recipientRole,
    recipient_email: testRecipient,
    recipient_name: clean_(process.env.EMAIL_DESIGN_TEST_RECIPIENT_NAME || process.env.STUDENT_EMAIL_TEST_RECIPIENT_NAME || "Head Teacher"),
    teacher_id: enrollment.teacher_id || null,
    student_id: student.id || null,
    enrollment_id: enrollment.id || null,
    subject: rendered.subject,
    body_html: rendered.bodyHtml,
    body_text: rendered.bodyText,
    payload_json: {
      source: "email-design-sample",
      sample_key: sampleKey,
      original_student_email: student.email || "",
      original_teacher_email: enrollment.teacher_email || "",
      ...payload
    }
  });
}

export async function queueEmailDesignSamples(options = {}) {
  const testRecipient = testRecipientFromOptions_(options);
  if (!testRecipient) {
    throw new Error("No email design test recipient configured. Set EMAIL_DESIGN_TEST_RECIPIENT, STUDENT_EMAIL_TEST_RECIPIENT, EMAIL_TEST_RECIPIENT, or HEAD_TEACHER_EMAIL.");
  }

  return withSupabaseClient(async (client) => {
    const queued = [];
    const warnings = [];

    const assignmentSample = await fetchSampleAssignment_(client);
    if (assignmentSample) {
      const receipt = assignmentReceiptEmail_(assignmentSample);
      queued.push(await insertDesignSampleEmail_(client, {
        sourceType: EMAIL_DESIGN_SAMPLE_SOURCE_TYPES.ASSIGNMENT_RECEIPT,
        sampleKey: `assignment-receipt:${assignmentSample.submission.id}`,
        rendered: receipt,
        testRecipient,
        recipientRole: "STUDENT",
        sourceId: assignmentSample.submission.id,
        student: assignmentSample.student,
        enrollment: assignmentSample.enrollment,
        payload: { design_type: "assignment_receipt" }
      }));

      const badSpeakpipeSubmission = {
        ...assignmentSample.submission,
        audio_link: "https://www.speakpipe.com/voice-recorder",
        speakpipe_link: "https://www.speakpipe.com/voice-recorder"
      };
      const linkInfo = {
        issue_code: "BAD_SPEAKPIPE_INCOMPLETE_URL",
        issue_message: "Le lien SpeakPipe semble incomplet. Il doit contenir le message audio complet."
      };
      const badStudent = badSpeakpipeStudentEmail_({
        submission: badSpeakpipeSubmission,
        student: assignmentSample.student,
        enrollment: assignmentSample.enrollment,
        linkInfo
      });
      queued.push(await insertDesignSampleEmail_(client, {
        sourceType: EMAIL_DESIGN_SAMPLE_SOURCE_TYPES.BAD_SPEAKPIPE_STUDENT,
        sampleKey: `bad-speakpipe-student:${assignmentSample.submission.id}`,
        rendered: badStudent,
        testRecipient,
        recipientRole: "STUDENT",
        sourceId: assignmentSample.submission.id,
        student: assignmentSample.student,
        enrollment: assignmentSample.enrollment,
        payload: { design_type: "bad_speakpipe_student", issue: linkInfo }
      }));

      const badTeacher = teacherBadSpeakpipeAlertEmail_({
        submission: badSpeakpipeSubmission,
        student: assignmentSample.student,
        enrollment: assignmentSample.enrollment,
        linkInfo
      });
      queued.push(await insertDesignSampleEmail_(client, {
        sourceType: EMAIL_DESIGN_SAMPLE_SOURCE_TYPES.BAD_SPEAKPIPE_TEACHER,
        sampleKey: `bad-speakpipe-teacher:${assignmentSample.submission.id}`,
        rendered: badTeacher,
        testRecipient,
        recipientRole: "TEACHER",
        sourceId: assignmentSample.submission.id,
        student: assignmentSample.student,
        enrollment: assignmentSample.enrollment,
        payload: { design_type: "bad_speakpipe_teacher", issue: linkInfo }
      }));

    } else {
      warnings.push("No assignment sample found for assignment receipt / bad SpeakPipe designs.");
    }

    const quizSample = await fetchSampleQuiz_(client);
    if (quizSample) {
      const quizVariants = [
        { key: "excellent", percentage: 95, score_display: "95/100" },
        { key: "very-good", percentage: 85, score_display: "85/100" },
        { key: "good", percentage: 71, score_display: "71/100" },
        { key: "revision", percentage: 58, score_display: "58/100" },
        { key: "support", percentage: 38, score_display: "38/100" }
      ];

      for (const variant of quizVariants) {
        const quizData = {
          ...quizSample.quiz,
          percentage: variant.percentage,
          score: variant.percentage,
          score_display: variant.score_display
        };
        const quiz = quizCompletionEmail_({
          quiz: quizData,
          student: quizSample.student,
          enrollment: quizSample.enrollment
        });
        queued.push(await insertDesignSampleEmail_(client, {
          sourceType: EMAIL_DESIGN_SAMPLE_SOURCE_TYPES.QUIZ_CONFIRMATION,
          sampleKey: `quiz-confirmation-${variant.key}:${quizSample.quiz.id}`,
          rendered: quiz,
          testRecipient,
          recipientRole: "STUDENT",
          sourceId: quizSample.quiz.id,
          student: quizSample.student,
          enrollment: quizSample.enrollment,
          payload: { design_type: "quiz_confirmation", score_band: variant.key, quiz_key: quizSample.quiz.quiz_key }
        }));
      }
    } else {
      warnings.push("No quiz sample found for quiz confirmation design.");
    }

    return {
      ok: true,
      test_recipient: testRecipient,
      queued_count: queued.filter(Boolean).length,
      queued: queued.filter(Boolean).map((row) => ({
        id: row.id,
        source_type: row.source_type,
        subject: row.subject,
        recipient_email: row.recipient_email,
        status: row.status
      })),
      warnings
    };
  });
}
