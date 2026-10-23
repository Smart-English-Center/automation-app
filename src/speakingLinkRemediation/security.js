import crypto from "node:crypto";

function clean(value) {
  return String(value ?? "").trim();
}

export function createRemediationToken() {
  const raw = crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashRemediationToken(raw) };
}

export function hashRemediationToken(raw) {
  return crypto.createHash("sha256").update(clean(raw)).digest("hex");
}
