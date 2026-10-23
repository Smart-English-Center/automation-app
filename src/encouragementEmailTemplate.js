/******************************************************************
 * encouragementEmailTemplate.js
 *
 * Branded, mobile-friendly HTML renderer for Supabase-stored
 * encouragement/reactivation messages.
 *
 * Important:
 * - The message content comes from Supabase encouragement_messages.
 * - This file provides layout/style and placeholder rendering only.
 * - Do not use external web fonts; many email clients block them.
 ******************************************************************/

import { studentFacingName } from "./studentFacingName.js";

function clean_(value) {
  return String(value ?? "").trim();
}

function shortenDisplayName_(value, maxParts = 2) {
  const parts = clean_(value)
    .split(/\s+/g)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= maxParts) {
    return parts.join(" ");
  }

  return parts.slice(0, maxParts).join(" ");
}

function escapeHtml_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function replacePlaceholders_(value, replacements) {
  let output = String(value ?? "");

  for (const [key, replacement] of Object.entries(replacements || {})) {
    output = output.replaceAll(`{{${key}}}`, clean_(replacement));
  }

  return output;
}

function getWhatsAppNumber_() {
  return clean_(process.env.JEA_SUPPORT_WHATSAPP_NUMBER || process.env.WHATSAPP_SUPPORT_NUMBER || "237693470708")
    .replace(/[^0-9]/g, "");
}

function getWhatsAppUrl_() {
  const configuredUrl = clean_(process.env.JEA_SUPPORT_WHATSAPP_URL || process.env.WHATSAPP_SUPPORT_URL);
  if (configuredUrl) return configuredUrl;

  const number = getWhatsAppNumber_();
  return number ? `https://wa.me/${number}` : "";
}

function formatWhatsAppNumber_() {
  const number = getWhatsAppNumber_();

  if (number === "237693470708") {
    return "+237 693 470 708";
  }

  return number ? `+${number}` : "";
}

function splitParagraphs_(bodyText) {
  return clean_(bodyText)
    .split(/\n\s*\n/g)
    .map((paragraph) => clean_(paragraph))
    .filter(Boolean);
}

function stripGreetingAndSignature_(paragraphs, audienceType) {
  const copy = [...paragraphs];

  if (copy.length) {
    const first = copy[0].toLowerCase();
    if (first.startsWith("bonjour ") || first.startsWith("hello ")) {
      copy.shift();
    }
  }

  if (audienceType === "STUDENT" && copy.length) {
    const last = copy[copy.length - 1].toLowerCase().replace(/\s+/g, " ");
    if (last.includes("cordialement") && last.includes("john")) {
      copy.pop();
    }
  }

  return copy;
}

function paragraphHtml_(paragraph) {
  const text = clean_(paragraph);
  const normalised = text.replace(/\s+/g, " ");
  const looksLikeQuote = /^([“\"])/.test(normalised) || /^([«])/.test(normalised);

  if (looksLikeQuote) {
    return `
      <div style="margin: 22px 0; padding: 18px 20px; background: #eff6ff; border-left: 5px solid #2563eb; border-radius: 14px;">
        <div style="font-family: Georgia, 'Times New Roman', serif; font-size: 18px; line-height: 1.65; color: #1e3a8a; font-style: italic;">
          ${escapeHtml_(text)}
        </div>
      </div>
    `.trim();
  }

  return `<p style="margin: 0 0 16px; font-size: 15px; line-height: 1.72; color: #1f2937;">${escapeHtml_(text).replace(/\n/g, "<br>")}</p>`;
}

function actionCardFor_(messageType, audienceType) {
  if (audienceType === "TEACHER") {
    return {
      title: "Focus for this week",
      text: "Keep your feedback clear, kind, and practical. A precise correction plus one encouraging sentence can help a learner continue.",
      badge: "Teacher care"
    };
  }

  return {
    title: "Votre petit objectif cette semaine",
    text: "Gardez un moment fixe pour apprendre, faites vos activités régulièrement et posez vos questions dès qu’une difficulté apparaît.",
    badge: "Cette semaine"
  };
}

function greetingFor_(audienceType) {
  return audienceType === "TEACHER" ? "Hello" : "Bonjour";
}

function footerFor_(audienceType) {
  if (audienceType === "TEACHER") {
    return "Thank you for helping learners feel supported, respected, and capable of progress.";
  }

  return "Nous croyons en votre progression. Continuez avec courage, régularité et confiance.";
}

function whatsAppCtaFor_(audienceType) {
  const whatsappUrl = getWhatsAppUrl_();
  const whatsappNumber = formatWhatsAppNumber_();

  if (audienceType === "TEACHER") {
    return {
      eyebrow: "Need support?",
      title: "Do you have a concern?",
      text: `Get in touch with us on WhatsApp${whatsappNumber ? ` at ${whatsappNumber}` : ""}.`,
      button: "Contact John on WhatsApp",
      url: whatsappUrl
    };
  }

  return {
    eyebrow: "Besoin d’aide ?",
    title: "Vous avez une préoccupation ?",
    text: `Contactez-nous directement sur WhatsApp${whatsappNumber ? ` au ${whatsappNumber}` : ""}.`,
    button: "Nous écrire sur WhatsApp",
    url: whatsappUrl
  };
}

export function renderEncouragementEmail({ message, recipient, messageType, sourceType, testRecipientEmail = "" }) {
  const audienceType = clean_(message?.audience_type || recipient?.audience_type || "STUDENT").toUpperCase();
  const recipientName = clean_(recipient?.recipient_name || recipient?.name || recipient?.full_name || recipient?.teacher_name || "there");
  const displayName = audienceType === "STUDENT"
    ? studentFacingName(recipientName, "there")
    : shortenDisplayName_(recipientName, 2);
  const recipientEmail = clean_(recipient?.recipient_email || recipient?.email);
  const subject = replacePlaceholders_(message?.subject || "John's English Academy", {
    student_name: displayName,
    teacher_name: displayName,
    recipient_name: displayName
  });
  const renderedText = replacePlaceholders_(message?.body_text || "", {
    student_name: displayName,
    teacher_name: displayName,
    recipient_name: displayName
  });
  const paragraphs = stripGreetingAndSignature_(splitParagraphs_(renderedText), audienceType);
  const actionCard = actionCardFor_(messageType, audienceType);
  const whatsappCta = whatsAppCtaFor_(audienceType);
  const greeting = greetingFor_(audienceType);

  const bodyHtml = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml_(subject)}</title>
  </head>
  <body style="margin: 0; padding: 0; background: #eef4ff; font-family: Arial, Helvetica, sans-serif; color: #111827;">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0;">
      ${escapeHtml_(subject)} - John's English Academy
    </div>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background: #eef4ff; margin: 0; padding: 28px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width: 680px; background: #ffffff; border-radius: 24px; overflow: hidden; border: 1px solid #dbeafe; box-shadow: 0 18px 45px rgba(29, 78, 216, 0.12);">
            <tr>
              <td style="background: #1d4ed8; background: linear-gradient(135deg, #1d4ed8 0%, #1e3a8a 100%); padding: 30px 28px 26px; color: #ffffff;">
                <div style="font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: #dbeafe; font-weight: 700;">
                  John's English Academy
                </div>
                <div style="font-family: 'Trebuchet MS', Arial, Helvetica, sans-serif; font-size: 29px; line-height: 1.25; font-weight: 800; margin-top: 10px; letter-spacing: -0.2px;">
                  ${escapeHtml_(subject)}
                </div>
              </td>
            </tr>

            <tr>
              <td style="padding: 28px;">
                <div style="margin: 0 0 24px; padding: 22px 18px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 20px; text-align: center;">
                  <div style="font-size: 14px; color: #1d4ed8; margin-bottom: 4px; font-weight: 700;">${escapeHtml_(greeting)}</div>
                  <div style="font-family: Georgia, 'Times New Roman', serif; font-size: 34px; line-height: 1.2; color: #1e3a8a; font-style: italic; letter-spacing: 0.4px;">
                    ${escapeHtml_(displayName)}
                  </div>
                </div>

                ${paragraphs.map(paragraphHtml_).join("\n")}

                <div style="margin: 26px 0; padding: 18px 18px; background: #f8fafc; border: 1px solid #dbeafe; border-radius: 18px;">
                  <div style="display: inline-block; padding: 5px 10px; background: #2563eb; color: #ffffff; border-radius: 999px; font-size: 12px; font-weight: 700; margin-bottom: 10px;">
                    ${escapeHtml_(actionCard.badge)}
                  </div>
                  <div style="font-family: 'Trebuchet MS', Arial, Helvetica, sans-serif; font-size: 16px; font-weight: 800; color: #111827; margin-bottom: 6px;">
                    ${escapeHtml_(actionCard.title)}
                  </div>
                  <div style="font-size: 14px; line-height: 1.65; color: #374151;">
                    ${escapeHtml_(actionCard.text)}
                  </div>
                </div>

                <div style="margin: 26px 0; padding: 20px 18px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 20px; text-align: center;">
                  <div style="font-size: 12px; letter-spacing: 1.4px; text-transform: uppercase; color: #047857; font-weight: 700; margin-bottom: 6px;">
                    ${escapeHtml_(whatsappCta.eyebrow)}
                  </div>
                  <div style="font-family: 'Trebuchet MS', Arial, Helvetica, sans-serif; font-size: 20px; line-height: 1.35; color: #064e3b; font-weight: 800; margin-bottom: 8px;">
                    ${escapeHtml_(whatsappCta.title)}
                  </div>
                  <div style="font-size: 14px; line-height: 1.65; color: #065f46; margin-bottom: 16px;">
                    ${escapeHtml_(whatsappCta.text)}
                  </div>
                  ${whatsappCta.url ? `<a href="${escapeHtml_(whatsappCta.url)}" style="display: inline-block; background: #047857; color: #ffffff; text-decoration: none; padding: 12px 18px; border-radius: 999px; font-size: 14px; font-weight: 700;">${escapeHtml_(whatsappCta.button)}</a>` : ""}
                </div>

                <p style="margin: 0 0 8px; font-size: 15px; line-height: 1.7; color: #1f2937;">
                  ${escapeHtml_(footerFor_(audienceType))}
                </p>

                <div style="margin-top: 24px; padding-top: 18px; border-top: 1px solid #e5e7eb; font-size: 13px; line-height: 1.6; color: #6b7280;">
                  <strong style="color: #111827;">John's English Academy</strong><br>
                  Learning with structure, support, and consistency.
                </div>
              </td>
            </tr>
          </table>

          <div style="max-width: 680px; margin: 12px auto 0; font-size: 11px; line-height: 1.5; color: #64748b; text-align: center;">
            This message was sent to ${escapeHtml_(recipientEmail || "your email address")} by John's English Academy.
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>
`.trim();

  return {
    subject,
    body_html: bodyHtml,
    body_text: [
      renderedText,
      audienceType === "TEACHER"
        ? `${whatsappCta.title} ${whatsappCta.text}${whatsappCta.url ? ` ${whatsappCta.url}` : ""}`
        : `${whatsappCta.title} ${whatsappCta.text}${whatsappCta.url ? ` ${whatsappCta.url}` : ""}`
    ].filter(Boolean).join("\n\n")
  };
}
