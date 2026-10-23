import crypto from "node:crypto";

function clean(value) { return String(value ?? "").trim(); }

export function createSpeakingTopicResponseToken() {
  const raw = crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashSpeakingTopicResponseToken(raw) };
}

export function hashSpeakingTopicResponseToken(raw) {
  return crypto.createHash("sha256").update(clean(raw)).digest("hex");
}
