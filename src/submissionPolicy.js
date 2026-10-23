import crypto from "node:crypto";
import { studentFacingName } from "./studentFacingName.js";

function clean_(value) {
  return String(value ?? "").trim();
}

function lower_(value) {
  return clean_(value).toLowerCase();
}

export function normalizeImportHeader(value) {
  // IMPORTANT: normalise BEFORE lowercasing.
  // Google Forms headers sometimes use mathematical bold Unicode characters
  // such as "𝐖𝐫𝐢𝐭𝐢𝐧𝐠 𝐎𝐩𝐭𝐢𝐨𝐧". Lowercasing first can turn them into
  // non-ASCII glyphs that are later stripped, producing "riting ption".
  // NFKC/NFKD first converts them to plain "Writing Option".
  return clean_(value)
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function scalarNamedValue(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const cleaned = clean_(item);
      if (cleaned) return cleaned;
    }
    return "";
  }

  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "value")) return clean_(value.value);
    if (Object.prototype.hasOwnProperty.call(value, "formattedValue")) return clean_(value.formattedValue);
  }

  return clean_(value);
}

function valueFromNamedByAliases_(named, aliases = []) {
  if (!named || typeof named !== "object") return "";

  const entries = Object.entries(named);
  const normalizedAliases = aliases.map((alias) => normalizeImportHeader(alias)).filter(Boolean);

  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(named, alias)) {
      const value = scalarNamedValue(named[alias]);
      if (value) return value;
    }
  }

  for (const normalizedAlias of normalizedAliases) {
    const found = entries.find(([key]) => normalizeImportHeader(key) === normalizedAlias);
    if (found) {
      const value = scalarNamedValue(found[1]);
      if (value) return value;
    }
  }

  for (const normalizedAlias of normalizedAliases) {
    const found = entries.find(([key]) => {
      const normalizedKey = normalizeImportHeader(key);
      return normalizedAlias && normalizedKey.includes(normalizedAlias);
    });
    if (found) {
      const value = scalarNamedValue(found[1]);
      if (value) return value;
    }
  }

  return "";
}

function configuredColumn_(sourceConfig = {}, fieldName = "") {
  const value = Number(sourceConfig?.[fieldName] || 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function rawValueByOneBasedColumn_(rawValues = [], columnNumber = 0) {
  const index = Number(columnNumber || 0) - 1;
  if (index < 0 || !Array.isArray(rawValues)) return "";
  return clean_(rawValues[index]);
}

function headerLooksLikeHelper_(header = "") {
  const normalized = normalizeImportHeader(header);
  if (!normalized) return false;

  return [
    "master intake status",
    "master record type",
    "master record id",
    "master intake result",
    "master intake at",
    "result",
    "status",
    "helper",
    "record id",
    "record type"
  ].includes(normalized) || normalized.includes("master intake") || normalized.includes("master record");
}

function configuredColumnLooksSafe_(named = {}, sourceConfig = {}, fieldName = "") {
  const col = configuredColumn_(sourceConfig, fieldName);
  if (!col) return false;

  const header = Object.keys(named || {})[col - 1] || "";
  if (headerLooksLikeHelper_(header)) return false;

  return true;
}

export function valueFromNamedOrConfiguredColumn({
  named = {},
  rawValues = [],
  aliases = [],
  sourceConfig = null,
  fieldName = ""
} = {}) {
  const aliasValue = valueFromNamedByAliases_(named, aliases);
  if (aliasValue) {
    return {
      value: aliasValue,
      source: "HEADER_ALIAS"
    };
  }

  if (sourceConfig && configuredColumnLooksSafe_(named, sourceConfig, fieldName)) {
    const col = configuredColumn_(sourceConfig, fieldName);
    const configuredValue = rawValueByOneBasedColumn_(rawValues, col);
    if (configuredValue) {
      return {
        value: configuredValue,
        source: `CONFIGURED_COLUMN_${col}`
      };
    }

    return {
      value: "",
      source: `CONFIGURED_COLUMN_${col}_EMPTY`
    };
  }

  return {
    value: "",
    source: "MISSING"
  };
}

export function hashShort(value, length = 24) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, length);
}

function fixedOffsetMinutesForTimezone_(timezone) {
  const clean = clean_(timezone) || "Africa/Douala";

  // Cameroon uses UTC+1 and does not normally use daylight saving time.
  if (["Africa/Douala", "Africa/Lagos", "Africa/Libreville", "Africa/Brazzaville"].includes(clean)) return 60;
  if (["UTC", "Etc/UTC", "GMT", "Z"].includes(clean)) return 0;

  const offsetMatch = /^([+-])(\d{2}):?(\d{2})?$/.exec(clean);
  if (offsetMatch) {
    const sign = offsetMatch[1] === "-" ? -1 : 1;
    const hours = Number(offsetMatch[2]);
    const minutes = Number(offsetMatch[3] || 0);
    return sign * ((hours * 60) + minutes);
  }

  return 60;
}

export function parseSourceTimestampToUtc(value, timezone = "Africa/Douala") {
  const raw = clean_(value);
  if (!raw) return "";

  // ISO strings with an explicit timezone/offset are already absolute instants.
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw) && /(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }

  const normalized = raw
    .replace(/\//g, "-")
    .replace(/\s+/g, " ")
    .trim();

  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(normalized);

  if (match) {
    const [, y, m, d, hh = "0", mm = "0", ss = "0"] = match;
    const offsetMinutes = fixedOffsetMinutesForTimezone_(timezone);
    const utcMs = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss)) - offsetMinutes * 60 * 1000;
    return new Date(utcMs).toISOString();
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? "" : fallback.toISOString();
}

export function formatDateTimeForTimezone(value, timezone = "Africa/Douala") {
  const raw = clean_(value);
  if (!raw) return "";

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;

  try {
    return new Intl.DateTimeFormat("fr-FR", {
      timeZone: timezone || "Africa/Douala",
      year: "numeric",
      month: "long",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  } catch {
    return raw;
  }
}

export function studentLanguageForLevel(level) {
  const clean = clean_(level).toUpperCase();
  if (clean === "A1" || clean === "A2") return "fr";
  return "en";
}

export function firstNameFromFullName(value) {
  return studentFacingName(value, "cher apprenant");
}

function parseSpeakPipeMessageLink_(value) {
  const link = clean_(value);

  if (!link) {
    return {
      valid: false,
      issue_code: "AUDIO_LINK_EMPTY",
      issue_message: "Aucun lien SpeakPipe n’a été envoyé."
    };
  }

  let candidate = link;
  if (/^\/\/(?:www\.)?speakpipe\.com(?:\/|$)/i.test(candidate)) {
    candidate = `https:${candidate}`;
  } else if (/^(?:www\.)?speakpipe\.com(?:\/|$)/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  let url = null;
  try {
    url = new URL(candidate);
  } catch {
    return {
      valid: false,
      issue_code: "BAD_SPEAKPIPE_NOT_A_URL",
      issue_message: "Le texte envoyé n’est pas un lien valide."
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      valid: false,
      issue_code: "BAD_SPEAKPIPE_UNSUPPORTED_PROTOCOL",
      issue_message: "Le lien SpeakPipe doit utiliser http ou https."
    };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/g, "");

  if (host !== "speakpipe.com") {
    return {
      valid: false,
      issue_code: "BAD_SPEAKPIPE_NON_SPEAKPIPE_LINK",
      issue_message: "Le lien envoyé n’est pas un lien SpeakPipe."
    };
  }

  const recorderMessage = /^\/voice-recorder\/msg\/([A-Za-z0-9_-]+)$/i.exec(path);
  const shareMessage = /^\/msg\/s\/([0-9]+)\/([0-9]+)\/([A-Za-z0-9_-]+)$/i.exec(path);

  if (!recorderMessage && !shareMessage) {
    // Browsers can copy a recording URL inside a text-highlight fragment.
    // Accept only one complete highlighted URL on SpeakPipe itself; never
    // guess an ID or extract links from arbitrary text or another host.
    if (path === "/voice-recorder" && url.hash.startsWith("#:~:")) {
      const highlights = new URLSearchParams(url.hash.slice(4)).getAll("text");
      if (highlights.length === 1) {
        const highlighted = clean_(highlights[0]);
        if (/^https?:\/\/(?:www\.)?speakpipe\.com\/(?:voice-recorder\/msg\/|msg\/s\/)[A-Za-z0-9_/-]+\/?$/i.test(highlighted)) {
          const embedded = parseSpeakPipeMessageLink_(highlighted);
          if (embedded.valid) return embedded;
        }
      }
    }
    return {
      valid: false,
      issue_code: "BAD_SPEAKPIPE_INCOMPLETE_LINK",
      issue_message: "Le lien SpeakPipe semble incomplet. Il doit contenir l’identifiant du message audio."
    };
  }

  const canonicalPath = recorderMessage
    ? `/voice-recorder/msg/${recorderMessage[1]}`
    : `/msg/s/${shareMessage[1]}/${shareMessage[2]}/${shareMessage[3]}`;

  return {
    valid: true,
    issue_code: "",
    issue_message: "",
    normalized_url: `https://www.speakpipe.com${canonicalPath}`
  };
}

export function classifySpeakPipeLink(value) {
  return parseSpeakPipeMessageLink_(value);
}

export function normaliseSpeakPipeLink(value) {
  const result = parseSpeakPipeMessageLink_(value);
  return result.valid ? result.normalized_url : clean_(value);
}

function withWhatsappMessage_(url, message = "") {
  const cleanUrl = clean_(url);
  const cleanMessage = clean_(message);
  if (!cleanUrl || !cleanMessage) return cleanUrl;

  try {
    const parsed = new URL(cleanUrl);
    parsed.searchParams.set("text", cleanMessage);
    return parsed.toString();
  } catch {
    const separator = cleanUrl.includes("?") ? "&" : "?";
    return `${cleanUrl}${separator}text=${encodeURIComponent(cleanMessage)}`;
  }
}

export function whatsappUrlForTeacher(teacher = {}, fallbackNumber = "", message = "") {
  const defaultMessage = "Bonjour Professeur, j’ai besoin d’aide concernant mon devoir sur John’s English Academy.";
  const configuredUrl = clean_(teacher.teacher_whatsapp_url || teacher.whatsapp_url);
  if (configuredUrl) return withWhatsappMessage_(configuredUrl, message);

  const number = clean_(teacher.teacher_whatsapp || teacher.whatsapp_number || teacher.phone || fallbackNumber)
    .replace(/[^0-9]/g, "");
  if (!number) return "";

  const text = encodeURIComponent(clean_(message) || defaultMessage);
  return `https://wa.me/${number}?text=${text}`;
}

function stripUrls_(value) {
  return clean_(value).replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ").trim();
}

function wordCount_(value) {
  const text = stripUrls_(value);
  const matches = text.match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

function urlMatches_(value) {
  return clean_(value).match(/\b(?:https?:\/\/|www\.)\S+/gi) || [];
}

export function classifyWritingAnswer(value) {
  const answer = clean_(value);
  const urls = urlMatches_(answer);
  const withoutUrls = stripUrls_(answer).replace(/[\s.,;:!?()\[\]{}"'“”‘’\-–—_/\\|]+/g, "").trim();
  const words = wordCount_(answer);

  if (!answer) {
    return {
      valid: false,
      issue_code: "BAD_WRITING_EMPTY",
      issue_message: "The writing answer is empty.",
      word_count: 0
    };
  }

  if (urls.length && !withoutUrls) {
    return {
      valid: false,
      issue_code: "BAD_WRITING_LINK_ONLY",
      issue_message: "The writing answer is a link instead of a written response.",
      word_count: words,
      url_count: urls.length
    };
  }

  if (urls.length && words <= 3) {
    return {
      valid: false,
      issue_code: "BAD_WRITING_MOSTLY_LINK",
      issue_message: "The writing answer mostly contains a link, with too little written text.",
      word_count: words,
      url_count: urls.length
    };
  }

  if (words <= 3) {
    return {
      valid: false,
      issue_code: "BAD_WRITING_TOO_SHORT",
      issue_message: "The writing answer is too short to assess.",
      word_count: words
    };
  }

  return {
    valid: true,
    issue_code: "",
    issue_message: "",
    word_count: words,
    url_count: urls.length
  };
}

export function scoreBandForPercentage(value) {
  const percentage = Number(value);
  if (!Number.isFinite(percentage)) {
    return { key: "unknown", labelFr: "Score reçu", labelEn: "Score received", color: "#4338ca", background: "#eef2ff", theme: "good" };
  }
  if (percentage >= 90) return { key: "excellent", labelFr: "Excellent travail", labelEn: "Excellent work", color: "#0f766e", background: "#ecfdf5", theme: "excellent" };
  if (percentage >= 80) return { key: "very_good", labelFr: "Très bon résultat", labelEn: "Very good result", color: "#2563eb", background: "#eff6ff", theme: "veryGood" };
  if (percentage >= 70) return { key: "good", labelFr: "Bon progrès", labelEn: "Good progress", color: "#4338ca", background: "#eef2ff", theme: "good" };
  if (percentage >= 50) return { key: "needs_revision", labelFr: "Révision recommandée", labelEn: "Revision recommended", color: "#7c3aed", background: "#faf5ff", theme: "revision" };
  return { key: "support_needed", labelFr: "Aide recommandée", labelEn: "Support recommended", color: "#0f172a", background: "#fff1f2", theme: "support" };
}
