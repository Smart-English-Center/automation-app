import { hashSpeakingTopicResponseToken } from "./security.js";
import {
  loadSpeakingTopicResponseSession,
  saveSpeakingTopicResponses
} from "../supabase/speakingTopicResponseRepository.js";

function clean(value) { return String(value ?? "").trim(); }

export class SpeakingTopicResponseError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = "SpeakingTopicResponseError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function speakingTopicResponseUrl(rawToken) {
  const base = clean(process.env.REGISTRATION_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL).replace(/\/+$/, "");
  if (!base) {
    throw new SpeakingTopicResponseError(
      "MISSING_PUBLIC_BASE_URL",
      "REGISTRATION_PUBLIC_BASE_URL is required for speaking-topic response links.",
      500
    );
  }
  const query = new URLSearchParams({ token: clean(rawToken) });
  return `${base}/api/speaking-topic-response?${query.toString()}`;
}

function requireToken_(value) {
  const token = clean(value);
  if (!token) throw new SpeakingTopicResponseError("INVALID_TOKEN", "This speaking-topic link is invalid.", 404);
  return token;
}

function normaliseAnswers_(input = {}, topicIds = []) {
  const source = input.answers && typeof input.answers === "object" ? input.answers : input;
  const answers = {};
  for (const topicId of topicIds) {
    const value = clean(source[`topic_${topicId}`] ?? source[topicId]).toUpperCase();
    if (!value) {
      throw new SpeakingTopicResponseError(
        "ALL_TOPICS_REQUIRED",
        "Please answer the question for every topic before submitting."
      );
    }
    if (!["DISCUSSED", "NOT_YET"].includes(value)) {
      throw new SpeakingTopicResponseError("INVALID_TOPIC_RESPONSE", "One of the topic responses is invalid.");
    }
    answers[topicId] = value;
  }
  return answers;
}

export async function loadSpeakingTopicResponsePage(token, dependencies = {}) {
  const raw = requireToken_(token);
  const load = dependencies.loadSpeakingTopicResponseSession || loadSpeakingTopicResponseSession;
  const row = await load(hashSpeakingTopicResponseToken(raw));
  if (!row) throw new SpeakingTopicResponseError("TOPIC_RESPONSE_NOT_FOUND", "This speaking-topic response page was not found.", 404);
  return row;
}

export async function submitSpeakingTopicResponse(input = {}, dependencies = {}) {
  const raw = requireToken_(input.token);
  const load = dependencies.loadSpeakingTopicResponseSession || loadSpeakingTopicResponseSession;
  const save = dependencies.saveSpeakingTopicResponses || saveSpeakingTopicResponses;
  const current = await load(hashSpeakingTopicResponseToken(raw));
  if (!current) throw new SpeakingTopicResponseError("TOPIC_RESPONSE_NOT_FOUND", "This speaking-topic response page was not found.", 404);
  if (!current.editable) {
    throw new SpeakingTopicResponseError("TOPIC_RESPONSE_LOCKED", "These answers can no longer be changed because the next topic cycle has already started.", 409);
  }
  const version = Number(input.version);
  if (!Number.isInteger(version) || version !== Number(current.version)) {
    throw new SpeakingTopicResponseError("TOPIC_RESPONSE_CHANGED", "This page has changed. Reload it before submitting again.", 409);
  }
  const topicIds = current.topics.map((topic) => clean(topic.id));
  if (topicIds.length !== 3) {
    throw new SpeakingTopicResponseError("TOPIC_SET_INCOMPLETE", "This speaking-topic set is incomplete.", 409);
  }
  const answers = normaliseAnswers_(input, topicIds);
  return save({
    tokenHash: hashSpeakingTopicResponseToken(raw),
    version,
    answers
  });
}
