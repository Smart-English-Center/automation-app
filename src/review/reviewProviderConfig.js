const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com";

function clean_(value) {
  return String(value ?? "").trim();
}

function parsePositiveInteger_(value, fallback, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export function getReviewProvider() {
  return "deepseek";
}

export function getDeepSeekReviewConfig() {
  return {
    provider: "deepseek",
    baseUrl: clean_(process.env.DEEPSEEK_BASE_URL) || DEEPSEEK_DEFAULT_BASE_URL,
    model: clean_(process.env.DEEPSEEK_REVIEW_MODEL) || clean_(process.env.DEEPSEEK_MODEL) || "deepseek-v4-pro",
    endpoint: "/chat/completions",
    thinkingMode: clean_(process.env.DEEPSEEK_THINKING_MODE) || "enabled",
    reasoningEffort: clean_(process.env.DEEPSEEK_REASONING_EFFORT) || "high",
    maxDraftsPerRun: parsePositiveInteger_(process.env.DEEPSEEK_REVIEW_DRAFTS_PER_RUN, 1, 5)
  };
}

export function getActiveReviewConfig() {
  return getDeepSeekReviewConfig();
}

export function requireReviewApiKey() {
  const apiKey = clean_(process.env.DEEPSEEK_API_KEY);
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured.");
  return apiKey;
}

// Kept only so older unused files still pass syntax/import checks.
// New review execution must not use OpenAI batch review.
export function getOpenAiReviewConfig() {
  return {
    provider: "openai_disabled",
    baseUrl: "",
    model: "",
    endpoint: "/v1/responses",
    completionWindow: "24h",
    reasoningEffort: "medium"
  };
}
