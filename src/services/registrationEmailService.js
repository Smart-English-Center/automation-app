import crypto from "node:crypto";
import { sendBrevoTransactionalEmail } from "../brevoClient.js";
import {
  escapeHtml,
  messageCardHtml,
  monoBoxHtml,
  nameCardHtml,
  paragraph,
  statGridHtml,
  whatsappButtonHtml,
  wrapEmailHtml
} from "../emailDesign.js";
import { logRegistrationEmailAttempt } from "../supabase/registrationRepository.js";
import { studentFacingName } from "../studentFacingName.js";

function clean_(value) {
  return String(value ?? "").trim();
}

function lower_(value) {
  return clean_(value).toLowerCase();
}

function upper_(value) {
  return clean_(value).toUpperCase();
}

function boolEnv_(name) {
  return ["1", "true", "yes", "on"].includes(lower_(process.env[name]));
}

function normaliseBaseUrl_(value) {
  return clean_(value).replace(/\/+$/, "");
}

function getRequiredEnv_(name) {
  const value = clean_(process.env[name]);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function getDecisionLinkSecret_() {
  return clean_(process.env.REGISTRATION_DECISION_LINK_SECRET) || getRequiredEnv_("REGISTRATION_WEBHOOK_SECRET");
}

function getPublicBaseUrl_() {
  return normaliseBaseUrl_(getRequiredEnv_("REGISTRATION_PUBLIC_BASE_URL"));
}

export function getRegistrationApproverEmails() {
  return clean_(process.env.REGISTRATION_APPROVER_EMAILS)
    .split(",")
    .map((item) => lower_(item))
    .filter(Boolean);
}

export function isRegistrationApprover(email) {
  const approvers = getRegistrationApproverEmails();
  return approvers.includes(lower_(email));
}

function hmac_(message) {
  return crypto.createHmac("sha256", getDecisionLinkSecret_()).update(message).digest("hex");
}

function safeEqual_(expected, provided) {
  const cleanExpected = clean_(expected);
  const cleanProvided = clean_(provided);
  if (!cleanExpected || !cleanProvided) return false;

  try {
    return crypto.timingSafeEqual(Buffer.from(cleanExpected), Buffer.from(cleanProvided));
  } catch {
    return false;
  }
}

function signReviewLink_({ token, approverEmail }) {
  return hmac_(`${clean_(token)}|review|${lower_(approverEmail)}`);
}

export function verifyDecisionLinkSignature({ token, approverEmail, signature }) {
  return safeEqual_(signReviewLink_({ token, approverEmail }), signature);
}

export function signDecisionConfirmation({ token, action, approverEmail }) {
  return hmac_(`${clean_(token)}|confirm|${lower_(action)}|${lower_(approverEmail)}`);
}

export function verifyDecisionConfirmationSignature({ token, action, approverEmail, signature }) {
  return safeEqual_(signDecisionConfirmation({ token, action, approverEmail }), signature);
}

export function signTeacherCreationLink({ token, approverEmail }) {
  return hmac_(`${clean_(token)}|teacher-create|${lower_(approverEmail)}`);
}

export function verifyTeacherCreationLink({ token, approverEmail, signature }) {
  return safeEqual_(signTeacherCreationLink({ token, approverEmail }), signature);
}

function buildTeacherCreationLink_({ token, approverEmail }) {
  const params = new URLSearchParams({
    token: clean_(token),
    approver_email: lower_(approverEmail),
    sig: signTeacherCreationLink({ token, approverEmail })
  });
  return `${getPublicBaseUrl_()}/api/registration/teacher/create?${params.toString()}`;
}

function buildReviewLink_({ token, approverEmail }) {
  const params = new URLSearchParams({
    token: clean_(token),
    approver_email: lower_(approverEmail),
    sig: signReviewLink_({ token, approverEmail })
  });

  return `${getPublicBaseUrl_()}/api/registration/decision?${params.toString()}`;
}

export function getClassDocumentUrlForLevel(level) {
  const key = `REGISTRATION_CLASS_DOC_${upper_(level)}_URL`;
  return clean_(process.env[key]);
}

function normalisePhoneForWhatsApp_(value) {
  return clean_(value).replace(/[^0-9]/g, "");
}

function whatsappUrlFromPhone_(phone) {
  const number = normalisePhoneForWhatsApp_(phone);
  return number ? `https://wa.me/${number}` : "";
}

function getAcademyWhatsAppPhone_() {
  return clean_(process.env.REGISTRATION_ACADEMY_WHATSAPP_PHONE) ||
    clean_(process.env.JEA_SUPPORT_WHATSAPP_NUMBER) ||
    clean_(process.env.DEFAULT_ACADEMY_WHATSAPP);
}

function getTrialEndCtaUrl_() {
  const configured = clean_(process.env.REGISTRATION_TRIAL_END_CTA_URL);
  if (configured) return configured;

  const academyContact = academyContact_();
  return academyContact.url;
}

function academyContact_() {
  const phone = getAcademyWhatsAppPhone_();
  const url = whatsappUrlFromPhone_(phone);
  return {
    phone,
    url,
    warning: url ? "" : "REGISTRATION_ACADEMY_WHATSAPP_PHONE is missing or invalid. Students will not receive an academy WhatsApp contact link."
  };
}

function teacherContact_(teacher = {}) {
  const teacherPhone = clean_(teacher.teacher_phone);
  const teacherWhatsappUrl = whatsappUrlFromPhone_(teacherPhone);
  if (teacherWhatsappUrl) {
    return {
      source: "teacher",
      phone: teacherPhone,
      url: teacherWhatsappUrl,
      warning: ""
    };
  }

  const fallbackPhone = getAcademyWhatsAppPhone_();
  return {
    source: "academy_fallback",
    phone: fallbackPhone,
    url: whatsappUrlFromPhone_(fallbackPhone),
    warning: `Teacher WhatsApp phone is missing for ${clean_(teacher.teacher_email)}. Academy fallback was used.`
  };
}

function maybeRedirectForTestMode_(message = {}) {
  if (!boolEnv_("REGISTRATION_EMAIL_TEST_MODE")) return { ...message, test_redirected: false };

  const testRecipient = lower_(process.env.REGISTRATION_EMAIL_TEST_RECIPIENT || process.env.BREVO_TEST_EMAIL_TO);
  if (!testRecipient) {
    throw new Error("REGISTRATION_EMAIL_TEST_MODE is enabled but REGISTRATION_EMAIL_TEST_RECIPIENT is missing.");
  }

  const originalRecipient = clean_(message.toEmail);
  const originalName = clean_(message.toName);
  return {
    ...message,
    toEmail: testRecipient,
    toName: "JEA Registration Test Recipient",
    subject: `[TEST] ${clean_(message.subject)}`,
    htmlContent: String(message.htmlContent || "").replace(
      "</body>",
      `<div style=\"max-width:700px;margin:0 auto 18px;padding:0 14px;font-family:Arial,Helvetica,sans-serif;color:#667085;font-size:12px;\">Original recipient: ${escapeHtml(originalRecipient)}${originalName ? ` (${escapeHtml(originalName)})` : ""}</div></body>`
    ),
    test_redirected: true,
    original_recipient_email: originalRecipient,
    original_recipient_name: originalName
  };
}

async function sendAndLogEmail_(requestId, emailType, message) {
  const prepared = maybeRedirectForTestMode_(message);
  const toEmail = lower_(prepared.toEmail);
  const toName = clean_(prepared.toName);

  try {
    const result = await sendBrevoTransactionalEmail(prepared);
    await logRegistrationEmailAttempt({
      registration_request_id: requestId,
      email_type: emailType,
      recipient_email: toEmail,
      recipient_name: toName,
      status: "sent",
      brevo_message_id: result.message_id || "",
      metadata_json: {
        subject: prepared.subject || "",
        tags: prepared.tags || [],
        test_redirected: Boolean(prepared.test_redirected),
        original_recipient_email: prepared.original_recipient_email || "",
        original_recipient_name: prepared.original_recipient_name || ""
      }
    });

    return {
      ok: true,
      email_type: emailType,
      recipient_email: toEmail,
      message_id: result.message_id || ""
    };
  } catch (error) {
    await logRegistrationEmailAttempt({
      registration_request_id: requestId,
      email_type: emailType,
      recipient_email: toEmail,
      recipient_name: toName,
      status: "failed",
      error_message: String(error && error.message ? error.message : error),
      metadata_json: {
        subject: prepared.subject || "",
        tags: prepared.tags || [],
        test_redirected: Boolean(prepared.test_redirected),
        original_recipient_email: prepared.original_recipient_email || "",
        original_recipient_name: prepared.original_recipient_name || ""
      }
    }).catch(() => {});

    return {
      ok: false,
      email_type: emailType,
      recipient_email: toEmail,
      error: String(error && error.message ? error.message : error)
    };
  }
}

function deliverySummary_(results) {
  const failures = results.filter((result) => !result.ok);
  if (!results.length) return "not_sent";
  if (!failures.length) return "sent";
  if (failures.length === results.length) return "failed";
  return "partially_failed";
}

function actionButtonHtml_(url, label, color = "#2563eb") {
  const cleanUrl = clean_(url);
  if (!cleanUrl) return "";

  return `
    <div style="margin:20px 0 4px;text-align:left;">
      <a href="${escapeHtml(cleanUrl)}" style="display:inline-block;background:${escapeHtml(color)};color:#ffffff;text-decoration:none;font-weight:bold;border-radius:10px;padding:11px 15px;font-size:14px;line-height:1.2;">
        ${escapeHtml(label)}
      </a>
    </div>
  `;
}

function detailsStats_(rows = []) {
  return statGridHtml(rows.map(([label, value]) => ({
    label,
    value: clean_(value) || "—"
  })));
}

function activeEnrollmentsSummary_(activeEnrollments = []) {
  if (!Array.isArray(activeEnrollments) || !activeEnrollments.length) return "No active enrollment found.";

  return activeEnrollments.map((enrollment) => {
    const parts = [
      clean_(enrollment.teacher_name) || clean_(enrollment.teacher_email) || "Unknown teacher",
      clean_(enrollment.level) ? `Level ${clean_(enrollment.level)}` : "Level not set",
      clean_(enrollment.registration_end_at) ? `ends ${clean_(enrollment.registration_end_at)}` : "no exact end time"
    ];
    return parts.join(" — ");
  }).join("\n");
}

function requestDetailsHtml_(data = {}) {
  const request = data.request || {};
  const existingStudent = data.existing_student || data.existingStudent || null;
  const activeEnrollments = data.active_enrollments || request.active_enrollments || [];

  return [
    detailsStats_([
      ["Student name submitted", request.student_name],
      ["Student email submitted", request.student_email],
      ["Student phone submitted", request.student_phone],
      ["Country submitted", request.country],
      ["Requested level", request.level],
      ["Requested teacher email", request.teacher_email],
      ["Submitted at", request.submitted_at],
      ["Source sheet", `${request.sheet_name || ""}${request.row_number ? ` — row ${request.row_number}` : ""}`],
      ["Existing student found", existingStudent ? "Yes" : "No"],
      ["Existing student status", existingStudent?.status || ""],
      ["Existing student ID", existingStudent?.id || ""],
      ["Existing active enrollment under same teacher", request.has_active_enrollment_same_teacher ? "Yes" : "No"],
      ["Active enrollment count", String(activeEnrollments.length || 0)]
    ]),
    monoBoxHtml(activeEnrollmentsSummary_(activeEnrollments))
  ].join("\n");
}

function emailHtml_({ subject, preheader, badge, theme, children }) {
  return wrapEmailHtml({
    subject,
    preheader,
    badge,
    theme,
    children
  });
}

function textFromLines_(lines = []) {
  return lines.map(clean_).filter(Boolean).join("\n\n");
}

function adminMessage_(toEmail, subject, htmlContent, textContent, tags = []) {
  return {
    toEmail,
    toName: toEmail,
    subject,
    htmlContent,
    textContent,
    tags: ["jea-registration", ...tags]
  };
}

function studentDisplayName_(value) {
  return studentFacingName(value);
}

function formatFrenchDate_(value) {
  const raw = clean_(value);
  if (!raw) return "—";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  try {
    return new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Africa/Douala"
    }).format(date);
  } catch {
    return raw;
  }
}

function studentEmailShellHtml_({ subject, badge, badgeTone = "blue", title, children }) {
  const tagStyles = {
    blue: "background:#eff6ff;color:#1d4ed8;",
    green: "background:#ecfdf5;color:#0f766e;",
    amber: "background:#fffbeb;color:#b45309;",
    red: "background:#fef2f2;color:#b91c1c;"
  };
  const tagStyle = tagStyles[badgeTone] || tagStyles.blue;

  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:32px 16px;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#1f2937;line-height:1.55;">
  <div style="max-width:660px;margin:0 auto;background:#eef2f7;border:1px solid #dbe3ef;border-radius:18px;padding:22px;">
    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(15,23,42,0.06);">
      <div style="padding:26px 28px 20px;border-top:5px solid #2563eb;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:700;font-size:14px;color:#374151;margin-bottom:14px;">John’s English Academy</div>
        <span style="display:inline-block;padding:5px 10px;border-radius:999px;${tagStyle}font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;margin-bottom:12px;">${escapeHtml(badge)}</span>
        <h2 style="margin:0;font-size:23px;line-height:1.25;color:#111827;">${escapeHtml(title)}</h2>
      </div>
      <div style="padding:26px 28px 30px;font-size:15px;">
        ${children}
      </div>
    </div>
  </div>
</body>
</html>`;
}

function studentParagraphHtml_(body) {
  return `<p style="margin:0 0 16px;">${escapeHtml(body)}</p>`;
}

function studentGreetingHtml_(name) {
  const displayName = studentDisplayName_(name);
  return `<p style="margin:0 0 16px;">Salut${displayName ? ` <strong>${escapeHtml(displayName)}</strong>` : ""},</p>`;
}

function studentSignatureHtml_() {
  return `<p style="margin:24px 0 0;color:#374151;">L’équipe de John’s English Academy</p>`;
}

function studentButtonHtml_(url, label, variant = "primary") {
  const cleanUrl = clean_(url);
  if (!cleanUrl) return "";

  const isSecondary = variant === "secondary";
  const background = isSecondary ? "#ffffff" : "#2563eb";
  const color = isSecondary ? "#1d4ed8" : "#ffffff";
  const border = isSecondary ? "1px solid #93c5fd" : "1px solid #2563eb";
  const padding = isSecondary ? "11px 17px" : "12px 18px";

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;margin:22px 0 18px;">
      <tr>
        <td bgcolor="${background}" style="background:${background};border:${border};border-radius:9px;mso-padding-alt:${padding};">
          <a href="${escapeHtml(cleanUrl)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;color:${color};text-decoration:none;padding:${padding};border-radius:9px;font-weight:700;font-size:14px;line-height:1.2;font-family:Arial,Helvetica,sans-serif;">
            ${escapeHtml(label)}
          </a>
        </td>
      </tr>
    </table>
  `;
}

function studentInfoBoxHtml_(body) {
  return `<div style="padding:14px 16px;border-radius:12px;margin:18px 0;font-size:14px;background:#eff6ff;border:1px solid #bfdbfe;color:#1e3a8a;">${body}</div>`;
}

function studentReasonBoxHtml_(reason) {
  return `<div style="padding:14px 16px;border-radius:12px;margin:18px 0;font-size:14px;background:#fffbeb;border:1px solid #fde68a;color:#78350f;"><strong>Raison :</strong> ${escapeHtml(reason)}</div>`;
}

function studentWhatsAppBlock_(academyContact, variant = "primary") {
  return academyContact.url
    ? studentButtonHtml_(academyContact.url, "Contacter l’académie sur WhatsApp", variant)
    : studentInfoBoxHtml_("Le contact WhatsApp de l’académie n’est pas encore disponible dans le système.");
}

function getRegistrationClassTutorialUrl_() {
  return clean_(process.env.REGISTRATION_CLASS_TUTORIAL_URL || process.env.JEA_CLASS_TUTORIAL_URL);
}

function whatsappUrlWithText_(phone, message) {
  const number = normalisePhoneForWhatsApp_(phone);
  const text = clean_(message);
  if (!number || !text) return "";
  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

function registrationStudentPhone_(request = {}, student = {}) {
  return clean_(request.student_phone) || clean_(student.whatsapp_number) || clean_(student.phone);
}

function buildApprovedStudentTextLines_({
  studentName = "",
  isOneWeekAccess = false,
  classDocumentUrl = "",
  tutorialUrl = "",
  registrationStartAt = "",
  registrationEndAt = "",
  includeWhatsAppContactGuidance = true,
  academyContact = {}
} = {}) {
  const displayName = studentDisplayName_(studentName);
  const lines = [
    displayName ? `Salut ${displayName},` : "Salut,",
    isOneWeekAccess
      ? "Votre demande a été validée. Vous pouvez maintenant accéder aux cours de John’s English Academy."
      : "Votre inscription à John’s English Academy est validée.",
    classDocumentUrl ? `Lien de cours: ${classDocumentUrl}` : "Lien de cours: non configuré",
    tutorialUrl ? `Tutoriel d’utilisation des cours: ${tutorialUrl}` : "Tutoriel d’utilisation des cours: non configuré"
  ];

  if (isOneWeekAccess) {
    lines.push(
      `Votre accès gratuit est valable du ${formatFrenchDate_(registrationStartAt)} au ${formatFrenchDate_(registrationEndAt)}.`,
      "Pendant cette période, vos exercices envoyés dans les délais pourront être corrigés les mercredi, vendredi et dimanche.",
      "Après la fin de votre semaine d’essai, les nouveaux exercices ne seront plus corrigés gratuitement."
    );
  } else {
    lines.push("Votre enseignant vous communiquera les informations utiles pour la suite des cours.");
  }

  lines.push("Prenez d’abord le temps d’ouvrir le document de cours, puis regardez le tutoriel afin de comprendre comment naviguer dans les classes et retrouver les activités à faire.");

  if (includeWhatsAppContactGuidance) {
    lines.push(academyContact.url ? `Contact WhatsApp de l’académie: ${academyContact.url}` : "Contact WhatsApp de l’académie: non configuré");
  }

  return lines;
}

function buildTrialExpiredStudentTextLines_({
  studentName = "",
  includeWhatsAppContactGuidance = true,
  academyContact = {}
} = {}) {
  const displayName = studentDisplayName_(studentName);
  const lines = [
    displayName ? `Salut ${displayName},` : "Salut,",
    "Votre semaine d’essai à John’s English Academy est maintenant terminée.",
    includeWhatsAppContactGuidance
      ? "Si vous souhaitez continuer les cours, contactez l’académie sur WhatsApp. Notre équipe vous expliquera comment finaliser votre inscription et comment procéder au paiement."
      : "Si vous souhaitez continuer les cours, notre équipe peut vous expliquer comment finaliser votre inscription et comment procéder au paiement.",
  ];

  if (includeWhatsAppContactGuidance) {
    lines.push(academyContact.url ? `Contact WhatsApp de l’académie: ${academyContact.url}` : "Contact WhatsApp de l’académie: non configuré");
  }

  lines.push("Nous serons heureux de vous accompagner dans la suite de votre progression en anglais.");

  return lines;
}

export async function sendRegistrationReceivedEmail({ registrationResult } = {}) {
  const request = registrationResult?.request || {};
  const academyContact = academyContact_();
  const subject = "Nous avons reçu vos informations";
  const studentName = request.student_name || request.student_email || "";
  const displayName = studentDisplayName_(studentName);
  const html = studentEmailShellHtml_({
    subject,
    badge: "Demande reçue",
    badgeTone: "blue",
    title: "Nous avons reçu vos informations",
    children: [
      studentGreetingHtml_(studentName),
      studentParagraphHtml_("Nous avons bien reçu vos informations d’inscription."),
      studentParagraphHtml_("Votre demande va être vérifiée. Si elle est validée, vous recevrez les informations nécessaires sous 24 heures."),
      studentParagraphHtml_("Pour toute question, contactez l’académie sur WhatsApp."),
      studentWhatsAppBlock_(academyContact),
      studentSignatureHtml_()
    ].join("\n")
  });

  const result = await sendAndLogEmail_(request.id, "student_registration_received", {
    toEmail: request.student_email,
    toName: displayName || request.student_name || request.student_email,
    subject,
    htmlContent: html,
    textContent: textFromLines_([
      displayName ? `Salut ${displayName},` : "Salut,",
      "Nous avons bien reçu vos informations d’inscription.",
      "Votre demande va être vérifiée. Si elle est validée, vous recevrez les informations nécessaires sous 24 heures.",
      "Pour toute question, contactez l’académie sur WhatsApp.",
      academyContact.url ? `Contact WhatsApp de l’académie: ${academyContact.url}` : "Contact WhatsApp de l’académie: non configuré"
    ]),
    tags: ["jea-registration", "registration-received-student"]
  });

  return {
    notification_status: deliverySummary_([result]),
    results: [result]
  };
}


export async function sendRegistrationApprovalEmails({ registrationResult } = {}) {
  const approvers = getRegistrationApproverEmails();
  const request = registrationResult.request;
  const token = registrationResult.token_raw;
  if (!token) {
    throw new Error("Missing registration decision token.");
  }

  const reviewRecipients = [];
  for (const approverEmail of approvers) {
    if (approverEmail && !reviewRecipients.includes(approverEmail)) reviewRecipients.push(approverEmail);
  }

  const assignedTeacherEmail = lower_(request.teacher_email);
  if (assignedTeacherEmail && !reviewRecipients.includes(assignedTeacherEmail)) {
    reviewRecipients.push(assignedTeacherEmail);
  }

  if (!reviewRecipients.length) {
    throw new Error("No registration reviewer email is available. Configure REGISTRATION_APPROVER_EMAILS or a valid assigned teacher email.");
  }

  const results = [];

  for (const reviewerEmail of reviewRecipients) {
    const isTeacherReviewer = reviewerEmail === assignedTeacherEmail && !approvers.includes(reviewerEmail);
    const reviewUrl = buildReviewLink_({ token, approverEmail: reviewerEmail });
    const subject = isTeacherReviewer
      ? "New student registration assigned to you"
      : "New registration request to review";
    const html = emailHtml_({
      subject,
      preheader: "Open the review page, adjust the data if needed, then approve or reject the request.",
      badge: isTeacherReviewer ? "Teacher review" : "Registration approval",
      theme: "teacher",
      children: [
        nameCardHtml({
          eyebrow: isTeacherReviewer ? "Student assigned to you" : "Pending registration",
          name: request.student_name || request.student_email,
          subtitle: `${request.level || "Level not set"} — ${request.teacher_email || "Teacher not set"}`,
          theme: "teacher"
        }),
        paragraph("A new registration request is waiting for review. You can open the review page, correct simple information if needed, then approve the student or reject the request with a short reason."),
        requestDetailsHtml_(registrationResult),
        actionButtonHtml_(reviewUrl, "Review registration request", "#475467"),
        messageCardHtml({
          title: "Security note",
          body: "The review link is valid for 7 days and can be used only while the request is still pending. The final decision is made only from the review page, not directly from this email.",
          theme: "warning"
        })
      ].join("\n")
    });

    const emailType = isTeacherReviewer ? "teacher_approval_request" : "admin_approval_request";
    const tags = isTeacherReviewer ? ["registration-approval-request-teacher"] : ["registration-approval-request"];

    results.push(await sendAndLogEmail_(request.id, emailType, adminMessage_(
      reviewerEmail,
      subject,
      html,
      textFromLines_([
        "New registration request to review.",
        `Student: ${request.student_name || request.student_email}`,
        `Email: ${request.student_email}`,
        `Level: ${request.level}`,
        `Teacher: ${request.teacher_email}`,
        "You can adjust simple information before approving or rejecting.",
        `Review link: ${reviewUrl}`
      ]),
      tags
    )));
  }

  return {
    notification_status: deliverySummary_(results),
    results
  };
}

export async function sendInvalidRegistrationAlert({ registrationResult } = {}) {
  const approvers = getRegistrationApproverEmails();
  const request = registrationResult.request;
  const results = [];
  const subject = "Registration request needs admin review";

  for (const approverEmail of approvers) {
    const html = emailHtml_({
      subject,
      preheader: "A registration request could not be sent for normal approval.",
      badge: "Registration alert",
      theme: "maintainer",
      children: [
        nameCardHtml({
          eyebrow: "Request not approved automatically",
          name: request.student_name || request.student_email,
          subtitle: `Status: ${request.status}`,
          theme: "maintainer"
        }),
        paragraph("A registration request was received, but it could not enter the normal approval flow. Please check the details below."),
        requestDetailsHtml_(registrationResult),
        messageCardHtml({
          title: "Reason",
          body: request.decision_error || registrationResult.validation_errors?.join("\n") || "The request failed validation.",
          theme: "maintainer"
        })
      ].join("\n")
    });

    results.push(await sendAndLogEmail_(request.id, "admin_invalid_registration_alert", adminMessage_(
      approverEmail,
      subject,
      html,
      textFromLines_([
        "Registration request needs admin review.",
        `Student: ${request.student_name || request.student_email}`,
        `Status: ${request.status}`,
        `Reason: ${request.decision_error || registrationResult.validation_errors?.join("; ") || "Validation failed"}`
      ]),
      ["registration-invalid-alert"]
    )));
  }

  return {
    notification_status: deliverySummary_(results),
    results
  };
}

export async function sendApprovalOutcomeEmails({ decisionResult } = {}) {
  const request = decisionResult.request || {};
  const student = decisionResult.student || {};
  const teacher = decisionResult.teacher || {};
  const contact = teacherContact_(teacher);
  const academyContact = academyContact_();
  const classDocumentUrl = getClassDocumentUrlForLevel(request.level);
  const tutorialUrl = getRegistrationClassTutorialUrl_();
  const approvers = getRegistrationApproverEmails();
  const results = [];
  const isOneWeekAccess = request.access_type === "one_week";
  const studentName = student.full_name || request.student_name || request.student_email;
  const displayName = studentDisplayName_(studentName);

  const studentSubject = isOneWeekAccess ? "Votre accès est prêt" : "Bienvenue à John’s English Academy";
  const studentHtml = isOneWeekAccess
    ? studentEmailShellHtml_({
        subject: studentSubject,
        badge: "Inscription validée",
        badgeTone: "green",
        title: "Votre accès est prêt",
        children: [
          studentGreetingHtml_(studentName),
          studentParagraphHtml_("Votre demande a été validée. Vous pouvez maintenant accéder aux cours de John’s English Academy."),
          classDocumentUrl
            ? studentButtonHtml_(classDocumentUrl, "Accéder à mes cours")
            : studentInfoBoxHtml_("Le lien du document de cours n’a pas été trouvé. L’administration vous l’enverra séparément."),
          tutorialUrl
            ? studentButtonHtml_(tutorialUrl, "Voir le tutoriel", "secondary")
            : studentInfoBoxHtml_("Le lien du tutoriel d’utilisation des cours n’est pas encore configuré."),
          studentInfoBoxHtml_(`Votre accès gratuit est valable du <strong>${escapeHtml(formatFrenchDate_(request.registration_start_at))}</strong> au <strong>${escapeHtml(formatFrenchDate_(request.registration_end_at))}</strong>.`),
          `<p style="margin:0 0 16px;">Pendant cette période, vos exercices envoyés dans les délais pourront être corrigés les <strong>mercredi</strong>, <strong>vendredi</strong> et <strong>dimanche</strong>.</p>`,
          studentParagraphHtml_("Après la fin de votre semaine d’essai, les nouveaux exercices ne seront plus corrigés gratuitement."),
          studentParagraphHtml_("Prenez d’abord le temps d’ouvrir le document de cours, puis regardez le tutoriel afin de comprendre comment naviguer dans les classes et retrouver les activités à faire."),
          studentParagraphHtml_("Pour toute question ou difficulté, contactez l’académie sur WhatsApp."),
          studentWhatsAppBlock_(academyContact, "secondary"),
          studentSignatureHtml_()
        ].join("\n")
      })
    : studentEmailShellHtml_({
        subject: studentSubject,
        badge: "Inscription validée",
        badgeTone: "green",
        title: "Bienvenue à John’s English Academy",
        children: [
          studentGreetingHtml_(studentName),
          studentParagraphHtml_("Votre inscription à John’s English Academy est validée."),
          classDocumentUrl
            ? studentButtonHtml_(classDocumentUrl, "Accéder à mes cours")
            : studentInfoBoxHtml_("Le lien du document de cours n’a pas été trouvé. L’administration vous l’enverra séparément."),
          tutorialUrl
            ? studentButtonHtml_(tutorialUrl, "Voir le tutoriel", "secondary")
            : studentInfoBoxHtml_("Le lien du tutoriel d’utilisation des cours n’est pas encore configuré."),
          studentParagraphHtml_("Votre enseignant vous communiquera les informations utiles pour la suite des cours."),
          studentParagraphHtml_("Prenez d’abord le temps d’ouvrir le document de cours, puis regardez le tutoriel afin de comprendre comment naviguer dans les classes et retrouver les activités à faire."),
          studentParagraphHtml_("Pour toute question, contactez l’académie sur WhatsApp."),
          studentWhatsAppBlock_(academyContact),
          studentSignatureHtml_()
        ].join("\n")
      });

  const studentTextLines = buildApprovedStudentTextLines_({
    studentName,
    isOneWeekAccess,
    classDocumentUrl,
    tutorialUrl,
    registrationStartAt: request.registration_start_at,
    registrationEndAt: request.registration_end_at,
    includeWhatsAppContactGuidance: true,
    academyContact
  });

  const studentWhatsAppText = textFromLines_(buildApprovedStudentTextLines_({
    studentName,
    isOneWeekAccess,
    classDocumentUrl,
    tutorialUrl,
    registrationStartAt: request.registration_start_at,
    registrationEndAt: request.registration_end_at,
    includeWhatsAppContactGuidance: false,
    academyContact
  }));
  const studentWhatsAppUrl = whatsappUrlWithText_(registrationStudentPhone_(request, student), studentWhatsAppText);

  results.push(await sendAndLogEmail_(request.id, "student_approval_confirmation", {
    toEmail: request.student_email || student.email,
    toName: displayName || studentName,
    subject: studentSubject,
    htmlContent: studentHtml,
    textContent: textFromLines_(studentTextLines),
    tags: ["jea-registration", "registration-approved-student"]
  }));

  const teacherSubject = "New student registration approved";
  const teacherHtml = emailHtml_({
    subject: teacherSubject,
    preheader: "A student has been added under your responsibility.",
    badge: "Teacher notice",
    theme: "teacher",
    children: [
      nameCardHtml({
        eyebrow: "Approved student",
        name: student.full_name || request.student_name || request.student_email,
        subtitle: `${request.student_email || ""} — Level ${request.level || "—"}`,
        theme: "teacher"
      }),
      paragraph("A registration request has been approved and the student is now active under your teacher profile."),
      detailsStats_([
        ["Student", student.full_name || request.student_name],
        ["Email", request.student_email],
        ["Phone", request.student_phone],
        ["Country", request.country],
        ["Level", request.level],
        ["Access type", request.access_type],
        ["Start UTC", request.registration_start_at],
        ["End UTC", request.registration_end_at || "No fixed end date"]
      ])
    ].join("\n")
  });

  results.push(await sendAndLogEmail_(request.id, "teacher_approval_notice", {
    toEmail: teacher.teacher_email,
    toName: teacher.teacher_name || teacher.teacher_email,
    subject: teacherSubject,
    htmlContent: teacherHtml,
    textContent: textFromLines_([
      "A registration request has been approved.",
      `Student: ${student.full_name || request.student_name}`,
      `Email: ${request.student_email}`,
      `Level: ${request.level}`,
      `Access type: ${request.access_type}`
    ]),
    tags: ["jea-registration", "registration-approved-teacher"]
  }));

  for (const approverEmail of approvers) {
    const adminSubject = "Registration approved";
    const html = emailHtml_({
      subject: adminSubject,
      preheader: "A registration request has been approved and logged.",
      badge: "Admin log",
      theme: "good",
      children: [
        nameCardHtml({
          eyebrow: "Approved registration",
          name: student.full_name || request.student_name || request.student_email,
          subtitle: `${request.level || "—"} — ${teacher.teacher_email || "teacher not set"}`,
          theme: "good"
        }),
        detailsStats_([
          ["Approved by", request.approved_by_email],
          ["Approved at", request.approved_at],
          ["Access type", request.access_type],
          ["Enrollment ID", request.enrollment_id],
          ["Student ID", student.id],
          ["Teacher", teacher.teacher_email]
        ]),
        studentWhatsAppUrl
          ? actionButtonHtml_(studentWhatsAppUrl, "Send the same message on WhatsApp", "#16a34a")
          : messageCardHtml({
              title: "WhatsApp button unavailable",
              body: "The student phone number is missing or invalid, so no WhatsApp button could be generated.",
              theme: "warning"
            }),
        contact.warning ? messageCardHtml({ title: "Teacher contact warning", body: contact.warning, theme: "warning" }) : "",
        academyContact.warning ? messageCardHtml({ title: "Academy contact warning", body: academyContact.warning, theme: "warning" }) : ""
      ].join("\n")
    });

    results.push(await sendAndLogEmail_(request.id, "admin_approval_log", adminMessage_(
      approverEmail,
      adminSubject,
      html,
      textFromLines_([
        "Registration approved.",
        `Student: ${student.full_name || request.student_name || request.student_email}`,
        `Teacher: ${teacher.teacher_email}`,
        `Approved by: ${request.approved_by_email}`,
        contact.warning || "",
        academyContact.warning || ""
      ]),
      ["registration-approved-admin-log"]
    )));
  }

  return {
    notification_status: deliverySummary_(results),
    results
  };
}


export async function sendRejectionOutcomeEmails({ decisionResult } = {}) {
  const request = decisionResult.request || {};
  const approvers = getRegistrationApproverEmails();
  const results = [];
  const rejectionReason = clean_(request.rejection_reason) || "Votre demande n’a pas pu être validée dans sa forme actuelle.";
  const academyContact = academyContact_();
  const studentSubject = "Votre demande d’inscription";
  const studentName = request.student_name || request.student_email;
  const displayName = studentDisplayName_(studentName);

  const studentHtml = studentEmailShellHtml_({
    subject: studentSubject,
    badge: "Non validée",
    badgeTone: "red",
    title: "Votre demande n’a pas été validée",
    children: [
      studentGreetingHtml_(studentName),
      studentParagraphHtml_("Après vérification, nous ne pouvons pas valider votre demande d’inscription pour le moment."),
      studentReasonBoxHtml_(rejectionReason),
      studentParagraphHtml_("Si vous souhaitez corriger votre demande ou obtenir de l’aide, contactez l’académie sur WhatsApp."),
      studentWhatsAppBlock_(academyContact),
      studentSignatureHtml_()
    ].join("\n")
  });

  results.push(await sendAndLogEmail_(request.id, "student_rejection_notice", {
    toEmail: request.student_email,
    toName: displayName || request.student_name || request.student_email,
    subject: studentSubject,
    htmlContent: studentHtml,
    textContent: textFromLines_([
      displayName ? `Salut ${displayName},` : "Salut,",
      "Après vérification, nous ne pouvons pas valider votre demande d’inscription pour le moment.",
      `Raison: ${rejectionReason}`,
      "Si vous souhaitez corriger votre demande ou obtenir de l’aide, contactez l’académie sur WhatsApp.",
      academyContact.url ? `Contact WhatsApp de l’académie: ${academyContact.url}` : "Contact WhatsApp de l’académie: non configuré"
    ]),
    tags: ["jea-registration", "registration-rejected-student"]
  }));

  for (const approverEmail of approvers) {
    const adminSubject = "Registration rejected";
    const html = emailHtml_({
      subject: adminSubject,
      preheader: "A registration request has been rejected and logged.",
      badge: "Admin log",
      theme: "warning",
      children: [
        nameCardHtml({
          eyebrow: "Rejected registration",
          name: request.student_name || request.student_email,
          subtitle: `${request.level || "—"} — ${request.teacher_email || "teacher not set"}`,
          theme: "warning"
        }),
        detailsStats_([
          ["Rejected by", request.rejected_by_email],
          ["Rejected at", request.rejected_at],
          ["Student email", request.student_email],
          ["Teacher email", request.teacher_email],
          ["Level", request.level],
          ["Reason sent to student", rejectionReason || "—"]
        ])
      ].join("\n")
    });

    results.push(await sendAndLogEmail_(request.id, "admin_rejection_log", adminMessage_(
      approverEmail,
      adminSubject,
      html,
      textFromLines_([
        "Registration rejected.",
        `Student: ${request.student_name || request.student_email}`,
        `Rejected by: ${request.rejected_by_email}`,
        `Reason: ${rejectionReason || "—"}`
      ]),
      ["registration-rejected-admin-log"]
    )));
  }

  return {
    notification_status: deliverySummary_(results),
    results
  };
}


export async function sendAlreadyActiveAdminLog({ decisionResult } = {}) {
  const request = decisionResult.request || {};
  const approvers = getRegistrationApproverEmails();
  const results = [];

  for (const approverEmail of approvers) {
    const subject = "Registration blocked: student already active";
    const html = emailHtml_({
      subject,
      preheader: "The approval was blocked because the student is already active under the same teacher.",
      badge: "Admin log",
      theme: "warning",
      children: [
        nameCardHtml({
          eyebrow: "Already active under same teacher",
          name: request.student_name || request.student_email,
          subtitle: request.teacher_email || "Teacher not set",
          theme: "warning"
        }),
        paragraph("No duplicate enrollment was created. The request was recorded as already active under the same teacher."),
        detailsStats_([
          ["Student email", request.student_email],
          ["Teacher email", request.teacher_email],
          ["Same-teacher active enrollment ID", request.same_teacher_active_enrollment_id],
          ["Decision attempted by", request.approved_by_email],
          ["Decision attempted at", request.approved_at]
        ])
      ].join("\n")
    });

    results.push(await sendAndLogEmail_(request.id, "admin_already_active_log", adminMessage_(
      approverEmail,
      subject,
      html,
      textFromLines_([
        "Registration blocked: student already active under the same teacher.",
        `Student: ${request.student_email}`,
        `Teacher: ${request.teacher_email}`
      ]),
      ["registration-already-active"]
    )));
  }

  return {
    notification_status: deliverySummary_(results),
    results
  };
}

export async function sendTrialExpiredEmails({ expiryResult } = {}) {
  const expiredTrials = Array.isArray(expiryResult?.expired_trials) ? expiryResult.expired_trials : [];
  if (!expiredTrials.length) {
    return { notification_status: "not_sent", results: [] };
  }

  const academyContact = academyContact_();
  const approvers = getRegistrationApproverEmails();
  const results = [];

  for (const trial of expiredTrials) {
    const request = trial.request || {};
    const student = trial.student || {};
    const enrollment = trial.enrollment || {};
    const teacher = trial.teacher || {};
    const studentEmail = lower_(student.email || request.student_email || request.student_email_submitted);
    const subject = "Votre semaine d’essai est terminée";
    const studentName = student.full_name || request.student_name || request.student_email || studentEmail;
    const displayName = studentDisplayName_(studentName);
    const studentTextLines = buildTrialExpiredStudentTextLines_({
      studentName,
      includeWhatsAppContactGuidance: true,
      academyContact
    });
    const adminWhatsAppText = textFromLines_(buildTrialExpiredStudentTextLines_({
      studentName,
      includeWhatsAppContactGuidance: false,
      academyContact
    }));
    const adminWhatsAppUrl = whatsappUrlWithText_(registrationStudentPhone_(request, student), adminWhatsAppText);

    if (!studentEmail) {
      results.push({
        ok: false,
        email_type: "student_trial_expired_notice",
        recipient_email: "",
        error: "Cannot send trial-ended email because student email is missing."
      });
    } else {
      const html = studentEmailShellHtml_({
        subject,
        badge: "Semaine d’essai terminée",
        badgeTone: "amber",
        title: "Votre semaine d’essai est terminée",
        children: [
          studentGreetingHtml_(studentName),
          studentParagraphHtml_("Votre semaine d’essai à John’s English Academy est maintenant terminée."),
          studentParagraphHtml_("Si vous souhaitez continuer les cours, contactez l’académie sur WhatsApp. Notre équipe vous expliquera comment finaliser votre inscription et comment procéder au paiement."),
          studentWhatsAppBlock_(academyContact),
          studentParagraphHtml_("Nous serons heureux de vous accompagner dans la suite de votre progression en anglais."),
          studentSignatureHtml_()
        ].join("\n")
      });

      results.push(await sendAndLogEmail_(request.id, "student_trial_expired_notice", {
        toEmail: studentEmail,
        toName: displayName || studentName,
        subject,
        htmlContent: html,
        textContent: textFromLines_(studentTextLines),
        tags: ["jea-registration", "registration-trial-expired-student"]
      }));
    }

    for (const approverEmail of approvers) {
      const adminSubject = "Trial ended: invite student to register";
      const adminHtml = emailHtml_({
        subject: adminSubject,
        preheader: "The student trial has ended. Send the same follow-up message by WhatsApp if a phone number is available.",
        badge: "Trial follow-up",
        theme: "warning",
        children: [
          nameCardHtml({
            eyebrow: "Trial ended",
            name: student.full_name || request.student_name || request.student_email || studentEmail,
            subtitle: `${request.level || enrollment.level || "Level not set"} — ${request.student_email || student.email || "email not set"}`,
            theme: "warning"
          }),
          paragraph("The student’s one-week trial has ended. The system sent the trial-ended email to the student. Use the WhatsApp button below to send the same follow-up message directly to the student by WhatsApp."),
          detailsStats_([
            ["Student", student.full_name || request.student_name || studentEmail],
            ["Email", request.student_email || student.email || studentEmail],
            ["Phone", request.student_phone || student.phone],
            ["Level", request.level || enrollment.level],
            ["Teacher", teacher.teacher_email || request.teacher_email],
            ["Trial ended at", enrollment.registration_end_at || request.registration_end_at]
          ]),
          adminWhatsAppUrl
            ? actionButtonHtml_(adminWhatsAppUrl, "Send trial-ended message on WhatsApp", "#16a34a")
            : messageCardHtml({
                title: "WhatsApp button unavailable",
                body: "The student phone number is missing or invalid, so no WhatsApp follow-up button could be generated.",
                theme: "warning"
              }),
          academyContact.warning ? messageCardHtml({ title: "Academy contact warning", body: academyContact.warning, theme: "warning" }) : ""
        ].join("\n")
      });

      results.push(await sendAndLogEmail_(request.id, "admin_trial_expired_followup", adminMessage_(
        approverEmail,
        adminSubject,
        adminHtml,
        textFromLines_([
          "The student’s one-week trial has ended.",
          `Student: ${student.full_name || request.student_name || studentEmail}`,
          `Email: ${request.student_email || student.email || studentEmail}`,
          `Level: ${request.level || enrollment.level || "—"}`,
          adminWhatsAppUrl ? `WhatsApp follow-up link: ${adminWhatsAppUrl}` : "WhatsApp follow-up link: unavailable"
        ]),
        ["registration-trial-expired-admin-followup"]
      )));
    }
  }

  return {
    notification_status: deliverySummary_(results),
    results
  };
}


export async function sendMissingTeacherCreationEmail({ decisionResult, token } = {}) {
  const request = decisionResult?.request || {};
  const teacherEmail = request.reviewed_teacher_email || decisionResult.teacher_email || request.teacher_email;
  const results = [];
  for (const approverEmail of getRegistrationApproverEmails()) {
    const url = buildTeacherCreationLink_({ token, approverEmail });
    const subject = "Create the assigned teacher before approving registration";
    const html = emailHtml_({
      subject,
      preheader: "The registration remains pending until the teacher profile is created.",
      badge: "Teacher profile required",
      theme: "warning",
      children: [
        nameCardHtml({ eyebrow:"Pending registration",name:request.student_name || request.student_email,subtitle:teacherEmail,theme:"warning" }),
        paragraph("The assigned teacher does not exist in the database. The student's registration remains pending."),
        actionButtonHtml_(url,"Create teacher and approve student","#2563eb")
      ].join("\n")
    });
    results.push(await sendAndLogEmail_(request.id,"admin_missing_teacher_creation",adminMessage_(approverEmail,subject,html,textFromLines_(["The registration remains pending until the assigned teacher is created.",`Student: ${request.student_name || request.student_email}`,`Teacher email: ${teacherEmail}`,`Create teacher: ${url}`]),["registration-missing-teacher"])));
  }
  return { notification_status:deliverySummary_(results),results };
}

export async function sendEmailFailureAlert({ requestId, context, failures } = {}) {
  const approvers = getRegistrationApproverEmails();
  if (!approvers.length || !(failures || []).length) {
    return { notification_status: "not_sent", results: [] };
  }

  const failureText = (failures || [])
    .map((failure) => `${failure.email_type} → ${failure.recipient_email}: ${failure.error || "Unknown error"}`)
    .join("\n");

  const results = [];

  for (const approverEmail of approvers) {
    const subject = "Registration email delivery failed";
    const html = emailHtml_({
      subject,
      preheader: "One or more registration emails could not be sent.",
      badge: "Technical alert",
      theme: "maintainer",
      children: [
        messageCardHtml({
          title: "Delivery problem",
          body: `Context: ${context || "registration workflow"}`,
          theme: "maintainer"
        }),
        monoBoxHtml(failureText)
      ].join("\n")
    });

    results.push(await sendAndLogEmail_(requestId, "admin_email_failure_alert", adminMessage_(
      approverEmail,
      subject,
      html,
      textFromLines_([
        "One or more registration emails could not be sent.",
        `Context: ${context || "registration workflow"}`,
        failureText
      ]),
      ["registration-email-failure"]
    )));
  }

  return {
    notification_status: deliverySummary_(results),
    results
  };
}
