import { buildReviewResponseBody } from "./reviewPrompt.js";
import { getDeepSeekReviewConfig, getOpenAiReviewConfig } from "./reviewProviderConfig.js";

function normaliseContent_(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        if (typeof part?.content === "string") return part.content;
        return JSON.stringify(part);
      })
      .join("\n");
  }
  if (content === null || content === undefined) return "";
  return JSON.stringify(content);
}

export function buildOpenAiReviewResponseBody({ draft, model } = {}) {
  const config = getOpenAiReviewConfig();
  const body = buildReviewResponseBody({ draft, model: model || config.model });

  return {
    ...body,
    model: model || config.model,
    reasoning: {
      effort: config.reasoningEffort
    }
  };
}

export function openAiResponseInputToChatMessages(responseBody) {
  const input = Array.isArray(responseBody?.input) ? responseBody.input : [];

  return input.map((message) => ({
    role: message.role,
    content: normaliseContent_(message.content)
  }));
}

export function buildDeepSeekReviewChatBody({ draft, model } = {}) {
  const config = getDeepSeekReviewConfig();
  const responseBody = buildOpenAiReviewResponseBody({ draft, model: model || config.model });

  return {
    model: model || config.model,
    messages: openAiResponseInputToChatMessages(responseBody),
    response_format: { type: "json_object" },
    thinking: {
      type: config.thinkingMode,
      reasoning_effort: config.reasoningEffort
    },
    stream: false
  };
}
