import crypto from "node:crypto";

function clean(value) { return String(value ?? "").trim(); }
function base64url(buffer) { return Buffer.from(buffer).toString("base64url"); }
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

function encryptionKey() {
  const secret = clean(process.env.SPEAKING_PROFILE_PAYLOAD_ENCRYPTION_KEY);
  if (secret.length < 32) throw new Error("SPEAKING_PROFILE_PAYLOAD_ENCRYPTION_KEY must contain at least 32 characters.");
  return crypto.createHash("sha256").update(secret).digest();
}

export function createReviewToken() {
  const raw = base64url(crypto.randomBytes(32));
  return { raw, hash: hash(raw) };
}

export function hashReviewToken(raw) { return hash(raw); }
export function hashEventId(eventId) { return hash(eventId); }

export function encryptReviewPayload(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ["v1", base64url(iv), base64url(cipher.getAuthTag()), base64url(ciphertext)].join(".");
}

export function decryptReviewPayload(value) {
  const [version, ivText, tagText, ciphertextText] = clean(value).split(".");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Invalid encrypted review payload.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function verifyWebhook({ rawBody, eventId, timestamp, signature }) {
  const secret = clean(process.env.SPEAKING_PROFILE_WEBHOOK_SECRET);
  if (secret.length < 32) throw new Error("SPEAKING_PROFILE_WEBHOOK_SECRET must contain at least 32 characters.");
  const timestampNumber = Number(timestamp);
  if (!Number.isInteger(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;
  const supplied = clean(signature).replace(/^v1=/, "");
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${eventId}.${rawBody}`).digest("base64url");
  if (!supplied || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}
