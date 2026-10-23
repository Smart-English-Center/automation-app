import { buildSpeakingTopicRequestBody } from "./prompt.js";

function clean(value) { return String(value ?? "").trim(); }

function parseJson(content) {
  const raw = clean(content).replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(raw); } catch (firstError) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error(`DeepSeek returned invalid JSON: ${firstError.message}`);
  }
}

export async function generateSpeakingTopics(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const apiKey = clean(process.env.DEEPSEEK_API_KEY);
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY.");
  const requestBody = buildSpeakingTopicRequestBody(input);
  // Deliberately no max_tokens/max_completion_tokens: the approved design lets
  // DeepSeek complete the structured response without a client-side token cap.
  const response = await fetchImpl(`${clean(process.env.DEEPSEEK_BASE_URL) || "https://api.deepseek.com"}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody)
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const error = new Error(`DeepSeek topic generation failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    error.providerBody = body || text.slice(0, 1200);
    throw error;
  }
  const content = clean(body?.choices?.[0]?.message?.content);
  return {
    parsed: parseJson(content),
    model: clean(body?.model) || input.model,
    usage: body?.usage || {},
    reasoningAvailable: Boolean(body?.choices?.[0]?.message?.reasoning_content)
  };
}

export function buildProfileSummaryRequestBody({ answers, currentSummary = "", revisionInstructions = "", model, thinkingMode, reasoningEffort }) {
  const isRevision = Boolean(clean(currentSummary));
  const system = isRevision
    ? "Revise the learner speaking profile summary using the administrator's instructions. Return one valid JSON object containing only a summary key. Write one concise prose paragraph in English. Preserve accurate learner information and do not invent facts."
    : "Create a learner speaking profile summary from the submitted answers. Return one valid JSON object containing only a summary key. Write one concise prose paragraph in English. Include useful speaking interests, needs, goals, contexts and preferences without inventing facts.";
  return {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify({ answers, current_summary: currentSummary || undefined, revision_instructions: revisionInstructions || undefined }) }
    ],
    response_format: { type: "json_object" },
    thinking: { type: thinkingMode, reasoning_effort: reasoningEffort },
    stream: false
  };
}

export async function generateProfileSummary(input, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const apiKey = clean(process.env.DEEPSEEK_API_KEY);
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY.");
  const requestBody = buildProfileSummaryRequestBody(input);
  const response = await fetchImpl(`${clean(process.env.DEEPSEEK_BASE_URL) || "https://api.deepseek.com"}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody)
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const error = new Error(`DeepSeek profile summary failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
    throw error;
  }
  const parsed = parseJson(body?.choices?.[0]?.message?.content || "");
  const summary = clean(parsed.summary);
  if (!summary) throw new Error("DeepSeek profile summary was empty.");
  return { summary, model: clean(body?.model) || input.model, usage: body?.usage || {} };
}
