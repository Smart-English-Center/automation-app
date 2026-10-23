/******************************************************************
 * pdfmonkeyClient.js
 *
 * Production PDFMonkey client for JEA PDFs.
 *
 * Fixes in this replacement:
 * - Does not require the student template ID at module import time.
 *   Teacher digest PDF generation can now work with only
 *   PDFMONKEY_TEACHER_DIGEST_TEMPLATE_ID.
 * - Accepts PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID as an alias for
 *   PDFMONKEY_TEMPLATE_ID.
 * - Returns clearer configuration errors at the exact time a PDF is created.
 ******************************************************************/

const PDFMONKEY_BASE_URL =
  process.env.PDFMONKEY_BASE_URL || "https://api.pdfmonkey.io/api/v1";

export async function createPdfMonkeyDocument(templateData, options = {}) {
  if (!templateData || typeof templateData !== "object" || Array.isArray(templateData)) {
    throw new Error("PDFMonkey templateData must be a JSON object.");
  }

  const templateId = resolvePdfMonkeyTemplateId(options);
  const filename = options.filename || buildDefaultPdfFilename(templateData);

  const requestBody = {
    document: {
      document_template_id: templateId,
      status: "pending",
      payload: templateData,
      meta: {
        _filename: filename,
        source: "JEA Master V2",
        ...(options.meta || {})
      }
    }
  };

  const response = await pdfMonkeyFetch("/documents", {
    method: "POST",
    body: JSON.stringify(requestBody)
  });

  const document =
    response.document ||
    response.document_card ||
    response.data ||
    response;

  const documentId =
    document.id ||
    response.id ||
    "";

  if (!documentId) {
    throw new Error(
      "PDFMonkey did not return a document ID: " + JSON.stringify(response)
    );
  }

  return {
    ok: true,
    document_id: documentId,
    document,
    raw_response: response
  };
}

export async function getPdfMonkeyDocumentCard(documentId) {
  if (!documentId) {
    throw new Error("Missing PDFMonkey document ID.");
  }

  const response = await pdfMonkeyFetch(
    `/document_cards/${encodeURIComponent(documentId)}`,
    {
      method: "GET"
    }
  );

  const documentCard =
    response.document_card ||
    response.document ||
    response.data ||
    response;

  return {
    ok: true,
    document_id: documentId,
    document_card: documentCard,
    raw_response: response
  };
}

export async function waitForPdfMonkeyDocument(documentId, options = {}) {
  const timeoutMs = Number(
    options.timeoutMs ||
    process.env.PDFMONKEY_WAIT_TIMEOUT_MS ||
    180000
  );

  const intervalMs = Number(
    options.intervalMs ||
    process.env.PDFMONKEY_WAIT_INTERVAL_MS ||
    5000
  );

  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const cardResult = await getPdfMonkeyDocumentCard(documentId);
    const card = cardResult.document_card || {};

    const status = String(card.status || "").toLowerCase();

    const downloadUrl = String(card.download_url || "").trim();
    const previewUrl = String(card.preview_url || "").trim();
    const publicShareLink = String(card.public_share_link || "").trim();

    if (status === "success" && downloadUrl) {
      return {
        ok: true,
        document_id: documentId,
        status,
        download_url: downloadUrl,
        preview_url: previewUrl,
        public_share_link: publicShareLink,
        filename: card.filename || "",
        document_card: card
      };
    }

    if (status === "failure" || status === "failed" || status === "error") {
      throw new Error(
        "PDFMonkey generation failed: " +
        JSON.stringify({
          document_id: documentId,
          status,
          failure_cause: card.failure_cause || "",
          generation_logs: card.generation_logs || []
        })
      );
    }

    await sleep(intervalMs);
  }

  throw new Error(
    `Timed out waiting for PDFMonkey document ${documentId} after ${timeoutMs}ms.`
  );
}

export function getPdfMonkeyConfigStatus() {
  return {
    api_key_configured: Boolean(clean(process.env.PDFMONKEY_API_KEY)),
    student_feedback_template_configured: Boolean(
      clean(process.env.PDFMONKEY_TEMPLATE_ID) ||
      clean(process.env.PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID)
    ),
    student_feedback_template_source: clean(process.env.PDFMONKEY_TEMPLATE_ID)
      ? "PDFMONKEY_TEMPLATE_ID"
      : clean(process.env.PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID)
        ? "PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID"
        : "",
    teacher_digest_template_configured: Boolean(clean(process.env.PDFMONKEY_TEACHER_DIGEST_TEMPLATE_ID)),
    base_url: PDFMONKEY_BASE_URL,
    wait_timeout_ms: Number(process.env.PDFMONKEY_WAIT_TIMEOUT_MS || 180000),
    wait_interval_ms: Number(process.env.PDFMONKEY_WAIT_INTERVAL_MS || 5000)
  };
}

async function pdfMonkeyFetch(path, options = {}) {
  const apiKey = clean(process.env.PDFMONKEY_API_KEY);

  if (!apiKey) {
    throw new Error("Missing required environment variable: PDFMONKEY_API_KEY");
  }

  const response = await fetch(PDFMONKEY_BASE_URL + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let json;

  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(
      `PDFMonkey returned non-JSON response. HTTP ${response.status}: ${text.slice(0, 1000)}`
    );
  }

  if (!response.ok) {
    throw new Error(
      `PDFMonkey request failed. HTTP ${response.status}: ${JSON.stringify(json)}`
    );
  }

  return json;
}

function resolvePdfMonkeyTemplateId(options = {}) {
  const explicitTemplateId = clean(
    options.templateId ||
    options.documentTemplateId ||
    ""
  );

  if (options.requireExplicitTemplateId && !explicitTemplateId) {
    throw new Error(
      "Missing explicit PDFMonkey template ID. This PDF type is not allowed to fall back to the student feedback template."
    );
  }

  const templateId = clean(
    explicitTemplateId ||
    process.env.PDFMONKEY_TEMPLATE_ID ||
    process.env.PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID ||
    ""
  );

  if (!templateId) {
    throw new Error(
      "Missing PDFMonkey template ID. For student feedback PDFs set PDFMONKEY_TEMPLATE_ID or PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID. For teacher digest PDFs pass options.templateId from PDFMONKEY_TEACHER_DIGEST_TEMPLATE_ID."
    );
  }

  return templateId;
}

function buildDefaultPdfFilename(templateData) {
  if (templateData.teacher && templateData.document) {
    const teacherName = templateData.teacher.teacher_name || "Teacher";
    const cycleDate = templateData.document.cycle_date || new Date().toISOString().slice(0, 10);

    return sanitizeFilename(
      `JEA Teacher Progress Digest - ${teacherName} - ${cycleDate}.pdf`
    );
  }

  const studentName =
    templateData.student && templateData.student.name
      ? String(templateData.student.name)
      : "Student";

  const deliveryDate =
    templateData.document && templateData.document.target_delivery_date
      ? String(templateData.document.target_delivery_date)
      : new Date().toISOString().slice(0, 10);

  const assignmentKeys =
    templateData.summary && Array.isArray(templateData.summary.assignment_keys)
      ? templateData.summary.assignment_keys.join("_")
      : "feedback";

  return sanitizeFilename(
    `JEA Feedback - ${studentName} - ${deliveryDate} - ${assignmentKeys}.pdf`
  );
}

function sanitizeFilename(value) {
  return String(value || "JEA Document.pdf")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function clean(value) {
  return String(value || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
