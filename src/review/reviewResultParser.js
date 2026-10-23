import { convertPronunciationInFeedback } from "./pronunciationConverter.js";

const VALID_REVIEW_STATUSES = new Set([
  "APPROVED",
  "FIXED",
  "REGENERATED",
  "PARTIAL_FEEDBACK",
  "BAD_SUBMISSION",
  "TEACHER_REVIEW"
]);

const VALID_SECTION_STATUSES = new Set([
  "ASSESSED",
  "NOT_ASSESSED",
  "NEEDS_TEACHER_REVIEW"
]);

function asString_(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function asNumberOrNull_(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanJsonText_(text) {
  let value = asString_(text).trim();

  if (value.startsWith("```")) {
    value = value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  }

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    value = value.slice(firstBrace, lastBrace + 1);
  }

  return value;
}

function extractTextFromResponsesBody_(body) {
  if (!body) return "";

  if (typeof body.output_text === "string") return body.output_text;

  if (Array.isArray(body.output)) {
    const chunks = [];

    for (const outputItem of body.output) {
      if (!Array.isArray(outputItem?.content)) continue;

      for (const contentItem of outputItem.content) {
        if (typeof contentItem?.text === "string") chunks.push(contentItem.text);
        else if (typeof contentItem?.content === "string") chunks.push(contentItem.content);
      }
    }

    return chunks.join("\n").trim();
  }

  if (Array.isArray(body.choices)) {
    return body.choices
      .map((choice) => choice?.message?.content || choice?.text || "")
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  return "";
}

export function parseOpenAiBatchOutputJsonl(jsonlText) {
  return asString_(jsonlText)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        const wrapped = new Error(`Invalid OpenAI batch output JSONL line ${index + 1}: ${error.message}`);
        wrapped.line = line;
        throw wrapped;
      }
    });
}

export function parseReviewResultFromBatchLine(line) {
  const customId = line?.custom_id || line?.customId || null;
  const response = line?.response || null;
  const statusCode = response?.status_code ?? response?.statusCode ?? null;
  const body = response?.body || line?.body || null;
  const error = line?.error || response?.error || body?.error || null;

  if (error || (statusCode && Number(statusCode) >= 400)) {
    return {
      custom_id: customId,
      ok: false,
      status_code: statusCode,
      error_code: error?.code || "OPENAI_BATCH_ITEM_ERROR",
      error_message: error?.message || JSON.stringify(error || body || line).slice(0, 2000),
      raw_line: line
    };
  }

  return parseReviewJsonText({
    customId,
    statusCode,
    text: extractTextFromResponsesBody_(body),
    rawLine: line
  });
}

export function parseDeepSeekReviewResponse({ customId, response }) {
  const text = response?.content || response?.response_body?.choices?.[0]?.message?.content || "";

  return parseReviewJsonText({
    customId,
    statusCode: 200,
    text,
    rawLine: response
  });
}

export function parseReviewJsonText({ customId, statusCode = 200, text, rawLine = null }) {
  const cleaned = cleanJsonText_(text);

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    return {
      custom_id: customId,
      ok: false,
      status_code: statusCode,
      error_code: "REVIEW_JSON_PARSE_FAILED",
      error_message: `Could not parse review JSON: ${error.message}`,
      raw_text: text,
      raw_line: rawLine
    };
  }

  return normaliseReviewJson({ customId, statusCode, parsed, rawText: text, rawLine });
}

export function normaliseReviewJson({ customId, statusCode, parsed, rawText = "", rawLine = null }) {
  const reviewStatus = asString_(parsed.review_status, "TEACHER_REVIEW").trim().toUpperCase();
  const writingStatus = asString_(parsed.writing_status, "NEEDS_TEACHER_REVIEW").trim().toUpperCase();
  const speakingStatus = asString_(parsed.speaking_status, "NEEDS_TEACHER_REVIEW").trim().toUpperCase();
  const correctedFeedback = convertPronunciationInFeedback(asString_(parsed.corrected_feedback_markdown, ""));

  return {
    custom_id: customId,
    ok: true,
    status_code: statusCode,
    review_status: VALID_REVIEW_STATUSES.has(reviewStatus) ? reviewStatus : "TEACHER_REVIEW",
    writing_status: VALID_SECTION_STATUSES.has(writingStatus) ? writingStatus : "NEEDS_TEACHER_REVIEW",
    speaking_status: VALID_SECTION_STATUSES.has(speakingStatus) ? speakingStatus : "NEEDS_TEACHER_REVIEW",
    writing_score: asNumberOrNull_(parsed.writing_score),
    speaking_score: asNumberOrNull_(parsed.speaking_score),
    speaking_score_display: asString_(parsed.speaking_score_display, ""),
    final_score: asNumberOrNull_(parsed.final_score),
    final_score_display: asString_(parsed.final_score_display, ""),
    corrected_feedback_markdown: correctedFeedback,
    review_note: asString_(parsed.review_note, "").slice(0, 2000),
    teacher_review_reason: asString_(parsed.teacher_review_reason, "").slice(0, 2000),
    email_subject: asString_(parsed.email_subject, "").slice(0, 300),
    raw_review_json: parsed,
    raw_text: rawText,
    raw_line: rawLine
  };
}

export function buildReviewedStudentFeedback({ originalFeedback, parsedReview }) {
  if (!parsedReview?.ok) return null;

  if (parsedReview.review_status === "APPROVED") {
    return convertPronunciationInFeedback(originalFeedback || "");
  }

  return convertPronunciationInFeedback(parsedReview.corrected_feedback_markdown || "");
}
