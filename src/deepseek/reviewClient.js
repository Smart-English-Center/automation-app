import { buildDeepSeekReviewChatBody } from "../review/reviewRequestBuilder.js";
import { getDeepSeekReviewConfig, requireReviewApiKey } from "../review/reviewProviderConfig.js";

function getDeepSeekBaseUrl_() {
  return getDeepSeekReviewConfig().baseUrl.replace(/\/$/, "");
}

export function getDeepSeekReviewModel() {
  return getDeepSeekReviewConfig().model;
}

async function parseDeepSeekResponse_(response) {
  const text = await response.text();

  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!response.ok) {
    const message = json?.error?.message || json?.message || text || `DeepSeek HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.body = json || text;
    throw error;
  }

  return json;
}

export function buildDeepSeekReviewRequestBody({ draft, model = getDeepSeekReviewModel() }) {
  return buildDeepSeekReviewChatBody({ draft, model });
}

export async function callDeepSeekReview({ draft, model = getDeepSeekReviewModel() }) {
  const apiKey = requireReviewApiKey("deepseek");
  const requestBody = buildDeepSeekReviewRequestBody({ draft, model });

  const response = await fetch(`${getDeepSeekBaseUrl_()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const body = await parseDeepSeekResponse_(response);

  return {
    provider: "deepseek",
    model,
    request_body: requestBody,
    response_body: body,
    content: body?.choices?.[0]?.message?.content || "",
    reasoning_content: body?.choices?.[0]?.message?.reasoning_content || "",
    usage: body?.usage || null
  };
}

export async function callDeepSeekReviewItems({ items, model = getDeepSeekReviewModel(), parseResult }) {
  const config = getDeepSeekReviewConfig();
  const concurrency = config.concurrency;
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      const item = items[currentIndex];

      try {
        const response = await callDeepSeekReview({ draft: item, model });
        const parsed = parseResult({ customId: item.custom_id, response });

        results[currentIndex] = {
          ok: parsed.ok,
          item,
          parsed,
          provider_response: {
            provider: response.provider,
            model: response.model,
            content: response.content,
            reasoning_content_available: Boolean(response.reasoning_content),
            usage: response.usage
          },
          error_code: parsed.ok ? null : parsed.error_code,
          error_message: parsed.ok ? null : parsed.error_message
        };
      } catch (error) {
        results[currentIndex] = {
          ok: false,
          item,
          error_code: error.status ? `DEEPSEEK_HTTP_${error.status}` : "DEEPSEEK_REVIEW_ERROR",
          error_message: String(error && error.message ? error.message : error),
          error_body: error.body || null
        };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}
