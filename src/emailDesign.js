/******************************************************************
 * Shared email design helpers for JEA transactional emails.
 * Approved style: Clean Receipt.
 *
 * This file intentionally changes layout/styling only. Message text,
 * language logic, queueing logic, and delivery logic live elsewhere.
 ******************************************************************/

export function clean(value) {
  return String(value ?? "").trim();
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

export function textJoin(parts) {
  return (parts || []).map(clean).filter(Boolean).join("\n\n");
}

export function paragraph(value) {
  return `<p style="margin:0 0 15px;font-size:15px;line-height:1.65;color:#344054;">${escapeHtml(value).replace(/\n/g, "<br>")}</p>`;
}

export function academyWhatsappUrl() {
  const explicit = clean(process.env.ACADEMY_WHATSAPP_URL || process.env.JEA_ACADEMY_WHATSAPP_URL);
  if (explicit) return explicit;

  const number = clean(process.env.DEFAULT_ACADEMY_WHATSAPP || process.env.JEA_SUPPORT_WHATSAPP_NUMBER)
    .replace(/\D+/g, "");

  return number ? `https://wa.me/${number}` : "";
}

export function whatsappButtonHtml(url, label = "Contact your teacher") {
  const cleanUrl = clean(url);
  if (!cleanUrl) return "";

  return `
    <div style="margin:20px 0 4px;text-align:left;">
      <a href="${escapeHtml(cleanUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:bold;border-radius:10px;padding:11px 15px;font-size:14px;line-height:1.2;">
        ${escapeHtml(label)}
      </a>
    </div>
  `;
}

export function academyWhatsappButtonHtml(label = "Contact the academy") {
  return whatsappButtonHtml(academyWhatsappUrl(), label);
}

export function testModeBannerHtml() {
  // Design-test emails are silently redirected by the delivery worker.
  // They must look exactly like production emails, so no visible banner is rendered.
  return "";
}

export const EMAIL_THEMES = Object.freeze({
  excellent: {
    accent: "#16a34a",
    button: "#16a34a",
    background: "#ecfdf3",
    border: "#bbf7d0",
    text: "#166534",
    badge: "Excellent"
  },
  veryGood: {
    accent: "#16a34a",
    button: "#16a34a",
    background: "#ecfdf3",
    border: "#bbf7d0",
    text: "#166534",
    badge: "Very good"
  },
  good: {
    accent: "#2563eb",
    button: "#2563eb",
    background: "#eff6ff",
    border: "#bfdbfe",
    text: "#1e3a8a",
    badge: "Good progress"
  },
  revision: {
    accent: "#d97706",
    button: "#d97706",
    background: "#fffbeb",
    border: "#fde68a",
    text: "#92400e",
    badge: "Revision recommended"
  },
  support: {
    accent: "#be123c",
    button: "#be123c",
    background: "#fff1f2",
    border: "#fecdd3",
    text: "#9f1239",
    badge: "Support recommended"
  },
  ack: {
    accent: "#2563eb",
    button: "#2563eb",
    background: "#eff6ff",
    border: "#bfdbfe",
    text: "#1e3a8a",
    badge: "Assignment received"
  },
  warning: {
    accent: "#d97706",
    button: "#d97706",
    background: "#fffbeb",
    border: "#fde68a",
    text: "#92400e",
    badge: "Action needed"
  },
  weekly: {
    accent: "#7c3aed",
    button: "#7c3aed",
    background: "#f5f3ff",
    border: "#ddd6fe",
    text: "#5b21b6",
    badge: "Stay consistent"
  },
  progressGood: {
    accent: "#16a34a",
    button: "#16a34a",
    background: "#ecfdf3",
    border: "#bbf7d0",
    text: "#166534",
    badge: "Progress report"
  },
  progressLow: {
    accent: "#d97706",
    button: "#d97706",
    background: "#fffbeb",
    border: "#fde68a",
    text: "#92400e",
    badge: "Progress report"
  },
  teacher: {
    accent: "#475467",
    button: "#475467",
    background: "#f8fafc",
    border: "#cbd5e1",
    text: "#344054",
    badge: "Teacher alert"
  },
  maintainer: {
    accent: "#b42318",
    button: "#b42318",
    background: "#fef3f2",
    border: "#fecdca",
    text: "#912018",
    badge: "Technical alert"
  }
});

function themeValue(theme, fallback = EMAIL_THEMES.good) {
  if (!theme) return fallback;
  if (typeof theme === "string") return EMAIL_THEMES[theme] || fallback;
  return { ...fallback, ...theme };
}

function borderTopForTheme_(selected, headerColor) {
  const accent = clean(headerColor) || clean(selected.accent) || "#2563eb";
  return `border-top:5px solid ${escapeHtml(accent)};`;
}

export function wrapEmailHtml({
  subject,
  preheader = "",
  badge = "",
  theme = "good",
  headerColor = "",
  background = "#f4f6f8",
  logoText = "John's English Academy",
  children = "",
  testBanner = ""
} = {}) {
  const selected = themeValue(theme);
  const visibleBadge = badge || selected.badge || "";

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background:${escapeHtml(background)};font-family:Arial,Helvetica,sans-serif;color:#172033;line-height:1.55;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}</div>
    <div style="max-width:700px;margin:0 auto;padding:26px 14px;">
      <div style="background:#ffffff;border:1px solid #e4e7ec;${borderTopForTheme_(selected, headerColor)}border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(16,24,40,0.08);">
        <div style="padding:22px 26px;border-bottom:1px solid #eef2f6;background:#ffffff;">
          <div style="font-size:14px;font-weight:bold;color:#344054;margin-bottom:12px;">${escapeHtml(logoText)}</div>
          ${visibleBadge ? `<div style="font-size:12px;font-weight:bold;color:#667085;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">${escapeHtml(visibleBadge)}</div>` : ""}
          <h1 style="font-size:22px;line-height:1.25;margin:0;color:#101828;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(subject)}</h1>
          ${preheader ? `<p style="font-size:14px;color:#667085;margin:8px 0 0;line-height:1.55;">${escapeHtml(preheader)}</p>` : ""}
        </div>
        <div style="padding:24px 26px;">
          ${testBanner || ""}
          ${children}
        </div>
        <div style="padding:16px 26px;border-top:1px solid #eef2f6;color:#667085;font-size:12px;background:#fbfcfe;">
          John's English Academy
        </div>
      </div>
    </div>
  </body>
</html>
`.trim();
}

export function nameCardHtml({ eyebrow = "", name = "", theme = "good", subtitle = "" } = {}) {
  const selected = themeValue(theme);
  const items = [
    eyebrow ? `<div style="font-size:13px;color:#667085;margin-bottom:3px;">${escapeHtml(eyebrow)}</div>` : "",
    name ? `<div style="font-size:18px;font-weight:bold;color:#101828;line-height:1.35;">${escapeHtml(name)}</div>` : "",
    subtitle ? `<div style="font-size:14px;color:#344054;line-height:1.55;margin-top:4px;">${escapeHtml(subtitle)}</div>` : ""
  ].filter(Boolean);

  if (!items.length) return "";

  return `
    <div style="background:#f8fafc;border:1px solid #e6eaf0;border-left:4px solid ${escapeHtml(selected.accent || "#2563eb")};border-radius:12px;padding:14px 16px;margin:0 0 18px;">
      ${items.join("\n")}
    </div>
  `;
}

export function messageCardHtml({ title = "", body = "", theme = "good" } = {}) {
  const selected = themeValue(theme);
  return `
    <div style="background:${escapeHtml(selected.background)};border:1px solid ${escapeHtml(selected.border)};border-radius:12px;padding:15px 16px;margin:20px 0;color:${escapeHtml(selected.text)};">
      ${title ? `<h2 style="font-size:15px;line-height:1.35;margin:0 0 6px;color:${escapeHtml(selected.text)};font-family:Arial,Helvetica,sans-serif;">${escapeHtml(title)}</h2>` : ""}
      ${body ? `<p style="margin:0;font-size:14px;line-height:1.6;color:${escapeHtml(selected.text)};">${escapeHtml(body).replace(/\n/g, "<br>")}</p>` : ""}
    </div>
  `;
}

export function statGridHtml(stats = []) {
  const filtered = (stats || []).filter((item) => clean(item?.label) || clean(item?.value));
  if (!filtered.length) return "";

  return `
    <div style="margin:18px 0;border-top:1px solid #eef2f6;">
      ${filtered.map((item) => `
        <div style="padding:11px 0;border-bottom:1px solid #eef2f6;">
          <div style="display:inline-block;vertical-align:top;width:42%;font-size:13px;color:#667085;">${escapeHtml(item.label)}</div>
          <div style="display:inline-block;vertical-align:top;width:56%;font-size:14px;font-weight:bold;color:#101828;text-align:right;">${escapeHtml(item.value)}</div>
        </div>
      `).join("")}
    </div>
  `;
}

export function monoBoxHtml(value) {
  return `<div style="background:#f8fafc;border:1px solid #e6eaf0;border-radius:10px;padding:11px;color:#344054;font-size:13px;word-break:break-word;line-height:1.55;margin:8px 0 12px;">${escapeHtml(value).replace(/\n/g, "<br>")}</div>`;
}

export function scoreCardHtml({ label, value, color = "#2563eb", background = "#eff6ff" } = {}) {
  return `
    <div style="background:${escapeHtml(background)};border:1px solid #bfdbfe;border-radius:12px;padding:16px;text-align:left;margin:18px 0;">
      <div style="font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#667085;font-weight:bold;">${escapeHtml(label)}</div>
      <div style="font-size:28px;line-height:1.2;font-weight:bold;color:${escapeHtml(color)};margin-top:5px;">${escapeHtml(value)}</div>
    </div>
  `;
}
