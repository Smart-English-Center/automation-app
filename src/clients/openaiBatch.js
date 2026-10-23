// src/clients/openaiBatch.js

import { getConfig } from "../config.js";

const OPENAI_FILES_URL = "https://api.openai.com/v1/files";
const OPENAI_BATCHES_URL = "https://api.openai.com/v1/batches";

export function buildBatchLine({
  customId,
  url,
  body
}) {
  if (!customId || !String(customId).trim()) {
    throw new Error("Batch customId is required.");
  }

  if (!url || !String(url).trim()) {
    throw new Error("Batch url is required.");
  }

  if (!body || typeof body !== "object") {
    throw new Error("Batch body must be an object.");
  }

  return JSON.stringify({
    custom_id: String(customId).trim(),
    method: "POST",
    url,
    body
  });
}

export function buildJsonl(lines) {
  const cleanLines = Array.isArray(lines)
    ? lines.map(line => String(line || "").trim()).filter(Boolean)
    : [];

  if (!cleanLines.length) {
    throw new Error("Cannot create OpenAI Batch JSONL with zero lines.");
  }

  return cleanLines.join("\n") + "\n";
}

export function getUtf8ByteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

export function assertBatchLimits({
  jsonl,
  maxRequests,
  maxFileBytes,
  label = "batch"
}) {
  const text = String(jsonl || "");
  const lines = text.trim() ? text.trim().split(/\n+/) : [];
  const bytes = getUtf8ByteLength(text);

  if (!lines.length) {
    throw new Error(`${label}: no batch requests found.`);
  }

  if (lines.length > maxRequests) {
    throw new Error(
      `${label}: too many requests. Found ${lines.length}, max allowed ${maxRequests}.`
    );
  }

  if (bytes > maxFileBytes) {
    throw new Error(
      `${label}: file too large. Found ${bytes} bytes, max allowed ${maxFileBytes} bytes.`
    );
  }

  return {
    request_count: lines.length,
    file_size_bytes: bytes
  };
}

export async function createOpenAiBatchFromJsonl({
  jsonl,
  endpoint,
  metadata = {},
  fileName = ""
}) {
  if (!jsonl || !String(jsonl).trim()) {
    throw new Error("jsonl is required.");
  }

  if (!endpoint || !String(endpoint).trim()) {
    throw new Error("endpoint is required.");
  }

  const inputFile = await uploadBatchInputFile({
    jsonl,
    fileName
  });

  const batch = await createBatch({
    inputFileId: inputFile.id,
    endpoint,
    metadata
  });

  return {
    ok: true,
    input_file: inputFile,
    batch
  };
}

export async function uploadBatchInputFile({
  jsonl,
  fileName = ""
}) {
  const config = getConfig();

  if (!config.openai || !config.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI Batch API.");
  }

  const safeFileName =
    fileName && String(fileName).trim()
      ? String(fileName).trim()
      : `jea-openai-batch-${Date.now()}.jsonl`;

  const formData = new FormData();

  formData.append(
    "file",
    new Blob([Buffer.from(jsonl, "utf8")], {
      type: "application/jsonl"
    }),
    safeFileName
  );

  formData.append("purpose", "batch");

  const response = await fetch(OPENAI_FILES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`
    },
    body: formData
  });

  const text = await response.text();
  const data = parseJsonOrThrow(
    text,
    `OpenAI file upload returned non-JSON. HTTP ${response.status}.`
  );

  if (!response.ok) {
    throw new Error(
      `OpenAI file upload failed. HTTP ${response.status}. Body: ${JSON.stringify(data).slice(0, 1600)}`
    );
  }

  return data;
}

export async function createBatch({
  inputFileId,
  endpoint,
  metadata = {}
}) {
  const config = getConfig();

  if (!config.openai || !config.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI Batch API.");
  }

  if (!inputFileId) {
    throw new Error("inputFileId is required.");
  }

  const response = await fetch(OPENAI_BATCHES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      input_file_id: inputFileId,
      endpoint,
      completion_window: "24h",
      metadata
    })
  });

  const text = await response.text();
  const data = parseJsonOrThrow(
    text,
    `OpenAI batch creation returned non-JSON. HTTP ${response.status}.`
  );

  if (!response.ok) {
    throw new Error(
      `OpenAI batch creation failed. HTTP ${response.status}. Body: ${JSON.stringify(data).slice(0, 1600)}`
    );
  }

  return data;
}

export async function retrieveOpenAiBatch(batchId) {
  const config = getConfig();

  if (!config.openai || !config.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI Batch API.");
  }

  if (!batchId) {
    throw new Error("batchId is required.");
  }

  const response = await fetch(`${OPENAI_BATCHES_URL}/${encodeURIComponent(batchId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`
    }
  });

  const text = await response.text();
  const data = parseJsonOrThrow(
    text,
    `OpenAI batch retrieve returned non-JSON. HTTP ${response.status}.`
  );

  if (!response.ok) {
    throw new Error(
      `OpenAI batch retrieve failed. HTTP ${response.status}. Body: ${JSON.stringify(data).slice(0, 1600)}`
    );
  }

  return data;
}

export async function downloadOpenAiFileContent(fileId) {
  const config = getConfig();

  if (!config.openai || !config.openai.apiKey) {
    throw new Error("OPENAI_API_KEY is required for OpenAI file download.");
  }

  if (!fileId) {
    throw new Error("fileId is required.");
  }

  const response = await fetch(`${OPENAI_FILES_URL}/${encodeURIComponent(fileId)}/content`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `OpenAI file content download failed. HTTP ${response.status}. Body: ${text.slice(0, 1600)}`
    );
  }

  return text;
}

export function parseBatchOutputJsonl(jsonlText) {
  const lines = String(jsonlText || "")
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(
        `Could not parse batch output JSONL line ${index + 1}: ${error.message}. Line preview: ${line.slice(0, 500)}`
      );
    }
  });
}

export function extractChatCompletionTextFromBatchResult(row) {
  const body = row &&
    row.response &&
    row.response.body
      ? row.response.body
      : null;

  if (
    body &&
    Array.isArray(body.choices) &&
    body.choices.length &&
    body.choices[0].message &&
    typeof body.choices[0].message.content === "string"
  ) {
    return String(body.choices[0].message.content || "").trim();
  }

  return "";
}

export function parseJsonFromModelText(text) {
  const raw = String(text || "").trim();

  if (!raw) {
    throw new Error("Cannot parse empty model text.");
  }

  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");

    if (start >= 0 && end > start) {
      const possibleJson = cleaned.slice(start, end + 1);

      try {
        return JSON.parse(possibleJson);
      } catch (secondError) {
        throw new Error(
          `Model output looked like JSON but could not be parsed. Error: ${secondError.message}. Preview: ${cleaned.slice(0, 1000)}`
        );
      }
    }

    throw new Error(
      `Model output was not valid JSON. Error: ${firstError.message}. Preview: ${cleaned.slice(0, 1000)}`
    );
  }
}

function parseJsonOrThrow(text, message) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${message} Body: ${String(text || "").slice(0, 1000)}`);
  }
}
