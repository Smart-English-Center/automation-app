/******************************************************************
 * brevoClient.js
 *
 * Brevo transactional email client for JEA Master.
 *
 * Safety:
 * - API key is read only from Sliplane environment variables.
 * - API key is never logged.
 * - This client sends real emails.
 ******************************************************************/

const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

export async function sendBrevoTransactionalEmail(options = {}) {
  const apiKey = requireEnv("BREVO_API_KEY");

  const senderName = String(
    options.senderName ||
    process.env.BREVO_SENDER_NAME ||
    "John's English Academy"
  ).trim();

  const senderEmail = String(
    options.senderEmail ||
    process.env.BREVO_SENDER_EMAIL ||
    ""
  ).trim();

  const replyToEmail = String(
    options.replyToEmail ||
    options.replyTo ||
    process.env.BREVO_REPLY_TO ||
    ""
  ).trim();

  const toEmail = String(options.toEmail || "").trim();
  const toName = String(options.toName || "").trim();

  const subject = String(options.subject || "").trim();

  const htmlContent = String(options.htmlContent || "").trim();
  const textContent = String(options.textContent || "").trim();

  const tags = Array.isArray(options.tags)
    ? options.tags
        .map((tag) => String(tag || "").trim())
        .filter(Boolean)
    : [];

  const cc = uniqueEmailList(options.cc || options.ccEmail || "", [toEmail]);
  const bcc = uniqueEmailList(options.bcc || options.bccEmail || "", [toEmail, ...cc]);

  if (!senderEmail) {
    throw new Error("Missing BREVO_SENDER_EMAIL.");
  }

  if (!toEmail) {
    throw new Error("Missing recipient email.");
  }

  if (!subject) {
    throw new Error("Missing email subject.");
  }

  if (!htmlContent && !textContent) {
    throw new Error("Missing email content. Provide htmlContent or textContent.");
  }

  const body = {
    sender: {
      name: senderName,
      email: senderEmail
    },
    to: [
      {
        email: toEmail,
        name: toName || toEmail
      }
    ],
    subject
  };

  if (replyToEmail) {
    body.replyTo = {
      email: replyToEmail,
      name: senderName
    };
  }

  if (cc.length) {
    body.cc = cc.map((email) => ({ email }));
  }

  if (bcc.length) {
    body.bcc = bcc.map((email) => ({ email }));
  }

  if (htmlContent) {
    body.htmlContent = htmlContent;
  } else {
    body.textContent = textContent;
  }

  if (tags.length) {
    body.tags = tags;
  }

  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "api-key": apiKey,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseText = await response.text();

  let json = null;

  try {
    json = responseText ? JSON.parse(responseText) : {};
  } catch (error) {
    throw new Error(
      `Brevo returned non-JSON response. HTTP ${response.status}: ${responseText.slice(0, 1000)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `Brevo email send failed. HTTP ${response.status}: ${JSON.stringify(redactBrevoError(json))}`
    );
  }

  return {
    ok: true,
    provider: "brevo",
    status_code: response.status,
    message_id: json.messageId || "",
    raw_response: json
  };
}


function normalizeEmailList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}


function uniqueEmailList(value, excludedEmails = []) {
  const excluded = new Set(
    (excludedEmails || [])
      .map((email) => String(email || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const seen = new Set();
  const output = [];

  for (const email of normalizeEmailList(value)) {
    const key = email.toLowerCase();
    if (!key || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    output.push(email);
  }

  return output;
}


function requireEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}


function redactBrevoError(errorJson) {
  if (!errorJson || typeof errorJson !== "object") {
    return errorJson;
  }

  const clone = JSON.parse(JSON.stringify(errorJson));

  if (clone.apiKey) clone.apiKey = "[REDACTED]";
  if (clone.api_key) clone.api_key = "[REDACTED]";
  if (clone.key) clone.key = "[REDACTED]";

  return clone;
}
