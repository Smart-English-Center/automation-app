import { LOCKED_TEACHER_DIGEST_PROMPT } from "../teacherDigest/deepseekPrompt.js";

function clean(value) { return String(value ?? "").trim(); }

export function buildDeepSeekDigestRequestBody({ batch, model, thinkingMode = "enabled", reasoningEffort = "high" } = {}) {
  if (!batch || typeof batch !== "object" || !Array.isArray(batch.students)) {
    throw new Error("A valid DeepSeek digest batch is required.");
  }
  return {
    model,
    messages: [
      { role: "system", content: LOCKED_TEACHER_DIGEST_PROMPT },
      { role: "user", content: JSON.stringify(batch) }
    ],
    response_format: { type: "json_object" },
    thinking: { type: thinkingMode, reasoning_effort: reasoningEffort },
    stream: false
  };
}

export async function generateDigestMessages(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const apiKey = clean(dependencies.apiKey || process.env.DEEPSEEK_API_KEY);
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY.");
  const requestBody = buildDeepSeekDigestRequestBody(input);
  const baseUrl = clean(dependencies.baseUrl || process.env.DEEPSEEK_BASE_URL) || "https://api.deepseek.com";
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody)
  });
  const responseText = await response.text();
  let body = null;
  try { body = responseText ? JSON.parse(responseText) : null; } catch { body = null; }
  if (!response.ok) {
    const error = new Error(`DeepSeek digest generation failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    error.providerCode = clean(body?.error?.code) || `HTTP_${response.status}`;
    error.sanitisedMessage = clean(body?.error?.message || body?.message || response.statusText).slice(0, 500);
    throw error;
  }
  const content = String(body?.choices?.[0]?.message?.content ?? "");
  if (!clean(content)) {
    const error = new Error("DeepSeek digest generation returned empty content.");
    error.retryable = true;
    error.providerCode = "EMPTY_PROVIDER_CONTENT";
    throw error;
  }
  return {
    content,
    provider: "deepseek",
    model: clean(body?.model) || clean(input.model),
    usage: body?.usage && typeof body.usage === "object" ? body.usage : {},
    provider_request_id: clean(response.headers?.get?.("x-request-id") || body?.id),
    reasoning_available: Boolean(body?.choices?.[0]?.message?.reasoning_content)
  };
}
