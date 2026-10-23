import crypto from "node:crypto";
import { getSpreadsheetTabs, getSpreadsheetValues, rowsToObjects } from "../google/sheetsClient.js";
import {
  classifySpeakPipeLink,
  classifyWritingAnswer,
  normaliseSpeakPipeLink,
  parseSourceTimestampToUtc,
  scalarNamedValue as scalarNamedValueFromPolicy,
  valueFromNamedOrConfiguredColumn
} from "../submissionPolicy.js";
import {
  queueAssignmentReceiptEmail,
  queueBadSpeakpipeLinkEmails,
  queueBadWritingSubmissionEmails,
  queueQuizCompletionEmail
} from "./interventionEmailRepository.js";
import { withSupabaseClient } from "./client.js";
import { createAndQueueMaintainerAlert } from "./maintainerAlertRepository.js";
import { sendOneQueuedStudentFeedbackEmail } from "../studentEmailDeliveryWorker.js";
import { createInvalidLinkRemediation } from "../speakingLinkRemediation/service.js";
import {
  claimSpeakingAudioLinkForAssignment,
  SpeakingAudioLinkOwnershipError
} from "./speakingAudioLinkRepository.js";

function nowIso_() { return new Date().toISOString(); }
function clean_(value) { return String(value ?? "").trim(); }
function lower_(value) { return clean_(value).toLowerCase(); }
function upper_(value) { return clean_(value).toUpperCase(); }
function intOrNull_(value) { const n = Number(value); return Number.isFinite(n) ? Math.trunc(n) : null; }
function numOrNull_(value) { const m = clean_(value).match(/-?\d+(?:[.,]\d+)?/); return m ? Number(m[0].replace(",", ".")) : null; }
function hash_(value) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24); }
function hash16_(value) { return crypto.createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 16); }
function normalizeChoice_(value) {
  return clean_(value)
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeSubmissionIdentityText_(value) {
  return clean_(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}
function stripChoicePrefix_(value) {
  return clean_(value)
    .replace(/^\s*(?:[\p{Emoji_Presentation}\p{Extended_Pictographic}]\s*)?(?:option|choix)\s*(\d+)\s*[-–—:.)]?\s*/iu, "")
    .trim();
}
function choiceNumberFromText_(value) {
  const text = clean_(value);
  const optionMatch = /(?:^|\b)(?:option|choix)\s*(\d+)\b/i.exec(text);
  if (optionMatch) return intOrNull_(optionMatch[1]);
  const leadingMatch = /^\s*(\d+)\s*[-–—:.)]/.exec(text);
  return leadingMatch ? intOrNull_(leadingMatch[1]) : null;
}
function uniqueNonEmpty_(values) {
  return [...new Set(values.map((value) => clean_(value)).filter(Boolean))];
}
function truthy_(value) { return ["1", "true", "yes", "y", "on"].includes(lower_(value)); }
function normalizeLimit_(value, fallback = 50, max = 1000) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), max) : fallback; }

const SOURCE_HEADER_ALIASES = {
  timestamp_col: [
    "timestamp",
    "horodateur",
    "submitted at",
    "date"
  ],
  email_col: [
    "email address",
    "adresse e-mail",
    "adresse email",
    "email",
    "e-mail",
    "e mail",
    "mail"
  ],
  name_col: [
    "full name",
    "student name",
    "name",
    "nom complet",
    "nom et prenom",
    "nom et prénom"
  ],
  writing_choice_col: [
    "choose one writing option",
    "choose one writing question",
    "choose your writing task",
    "choose your writing option",
    "writing option",
    "writing options",
    "writing option option",
    "writing question",
    "choose one writing q",
    "writing task",
    "selected writing option",
    "selected writing question",
    "question ecrite",
    "question écrite",
    "option d'écriture",
    "option ecriture",
    "option écrite"
  ],
  writing_answer_col: [
    "write your writing answer here",
    "write your answer here",
    "write your answer here.",
    "write your answer",
    "write your full response here",
    "write your full answer here",
    "write your response here",
    "write your written answer here",
    "your writing answer",
    "your full response",
    "your full answer",
    "writing answer",
    "written answer",
    "full response",
    "full answer",
    "answer",
    "reponse ecrite",
    "réponse écrite",
    "writing response",
    "written response",
    "student writing answer"
  ],
  speaking_choice_col: [
    "choose one speaking option",
    "choose one speaking question",
    "choose your speaking task",
    "choose your speaking option",
    "speaking option",
    "speaking options",
    "speaking option option",
    "speaking question",
    "choose one speaking q",
    "speaking task",
    "selected speaking option",
    "selected speaking question",
    "question orale",
    "option orale",
    "option speaking"
  ],
  audio_link_col: [
    "collez ici le lien de votre audio",
    "google drive link",
    "speakpipe link",
    "speaking audio",
    "audio link",
    "paste your audio link here",
    "recording link",
    "voice note",
    "lien audio",
    "lien speakpipe",
    "upload audio",
    "audio",
    "speakpipe"
  ],
  quiz_score_col: [
    "score",
    "quiz score",
    "points",
    "note"
  ],
  max_score_col: [
    "max score",
    "total points",
    "total point",
    "total"
  ]
};


const SUCCESSFUL_IMPORT_STATUSES = new Set([
  "IMPORTED",
  "FORM_SUBMISSION_IMPORTED",
  "IMPORTED_WITH_WARNINGS",
  "QUIZ_SCORE_IMPORTED",
  "QUIZ_SCORE_IMPORTED_WITH_WARNINGS"
]);

function importStatusIsSuccessful_(value) {
  return SUCCESSFUL_IMPORT_STATUSES.has(upper_(value));
}

function eventNamedValues_(payload) {
  return payload.raw_named_values || payload.namedValues || payload.named_values || {};
}

function normalizeHeader_(value) {
  // Match the import policy normalisation: convert stylised Unicode letters
  // to plain ASCII before lowercasing. This is required for headers like
  // "🧾 𝐖𝐫𝐢𝐭𝐢𝐧𝐠 𝐎𝐩𝐭𝐢𝐨𝐧" and "🎧 𝐒𝐩𝐞𝐚𝐤𝐢𝐧𝐠 𝐎𝐩𝐭𝐢𝐨𝐧".
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

function scalarNamedValue_(value) {
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

function valueFromNamed_(named, aliases) {
  if (!named || typeof named !== "object") return "";

  const entries = Object.entries(named);
  const normalizedAliases = aliases.map((alias) => normalizeHeader_(alias)).filter(Boolean);

  // 1. Exact raw-key match, preserving caller priority.
  for (const alias of aliases) {
    if (Object.prototype.hasOwnProperty.call(named, alias)) {
      const value = scalarNamedValue_(named[alias]);
      if (value) return value;
    }
  }

  // 2. Exact normalized-header match, same behaviour as Apps Script's first pass.
  for (const normalizedAlias of normalizedAliases) {
    const found = entries.find(([key]) => normalizeHeader_(key) === normalizedAlias);
    if (found) {
      const value = scalarNamedValue_(found[1]);
      if (value) return value;
    }
  }

  // 3. Header contains alias, same behaviour as Apps Script's second pass.
  // This lets "Write your Writing answer here" match "writing answer" safely.
  for (const normalizedAlias of normalizedAliases) {
    const found = entries.find(([key]) => {
      const normalizedKey = normalizeHeader_(key);
      return normalizedAlias && normalizedKey.includes(normalizedAlias);
    });
    if (found) {
      const value = scalarNamedValue_(found[1]);
      if (value) return value;
    }
  }

  return "";
}

function normaliseEmailCandidate_(value) {
  const raw = clean_(value).toLowerCase();
  if (!raw) return "";

  const compact = raw.replace(/\s+/g, "");
  const validEmailPattern = /^[^\s@<>()[\],;:]+@[^\s@<>()[\],;:]+\.[^\s@<>()[\],;:]+$/;

  if (validEmailPattern.test(raw)) return raw;
  if (compact !== raw && validEmailPattern.test(compact)) return compact;

  return "";
}

function configuredColumnNumber_(sourceConfig = {}, fieldName = "") {
  const value = Number(sourceConfig?.[fieldName] || 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function rawValueByOneBasedColumn_(rawValues = [], columnNumber = 0) {
  const index = Number(columnNumber || 0) - 1;
  if (index < 0 || !Array.isArray(rawValues)) return "";
  return clean_(rawValues[index]);
}

function exactEmailFromNamed_(named) {
  if (!named || typeof named !== "object") {
    return { value: "", source: "MISSING" };
  }

  const entries = Object.entries(named);
  const exactAliases = SOURCE_HEADER_ALIASES.email_col.map((alias) => normalizeHeader_(alias)).filter(Boolean);

  for (const alias of SOURCE_HEADER_ALIASES.email_col) {
    if (Object.prototype.hasOwnProperty.call(named, alias)) {
      const email = normaliseEmailCandidate_(scalarNamedValue_(named[alias]));
      if (email) return { value: email, source: `EMAIL_EXACT_RAW_HEADER:${alias}` };
    }
  }

  for (const normalizedAlias of exactAliases) {
    const found = entries.find(([key]) => normalizeHeader_(key) === normalizedAlias);
    if (found) {
      const email = normaliseEmailCandidate_(scalarNamedValue_(found[1]));
      if (email) return { value: email, source: `EMAIL_EXACT_HEADER:${found[0]}` };
    }
  }

  return { value: "", source: "MISSING" };
}

function configuredEmailFromRawValues_(payload = {}, sourceConfig = null) {
  const col = configuredColumnNumber_(sourceConfig, "email_col");
  if (!col) return { value: "", source: "MISSING" };

  const email = normaliseEmailCandidate_(rawValueByOneBasedColumn_(rawValues_(payload), col));
  if (email) return { value: email, source: `EMAIL_CONFIGURED_COLUMN_${col}` };

  return { value: "", source: `EMAIL_CONFIGURED_COLUMN_${col}_INVALID_OR_EMPTY` };
}

function scanEmailValuesFromNamed_(named) {
  if (!named || typeof named !== "object") return { value: "", source: "MISSING" };

  for (const [key, value] of Object.entries(named)) {
    const email = normaliseEmailCandidate_(scalarNamedValue_(value));
    if (email) return { value: email, source: `EMAIL_VALUE_SCAN:${key}` };
  }

  return { value: "", source: "MISSING" };
}

function scanEmailValuesFromRawValues_(payload = {}) {
  const values = rawValues_(payload);
  if (!Array.isArray(values) || !values.length) return { value: "", source: "MISSING" };

  for (let index = 0; index < values.length; index += 1) {
    const email = normaliseEmailCandidate_(values[index]);
    if (email) return { value: email, source: `EMAIL_RAW_VALUE_SCAN:column_${index + 1}` };
  }

  return { value: "", source: "MISSING" };
}

function extractRespondentEmail_(payload = {}, named = {}, sourceConfig = null) {
  const directCandidates = [
    ["payload.google_respondent_email", payload.google_respondent_email],
    ["payload.googleRespondentEmail", payload.googleRespondentEmail],
    ["payload.collected_email", payload.collected_email],
    ["payload.collectedEmail", payload.collectedEmail],
    ["payload.respondent_email", payload.respondent_email],
    ["payload.respondentEmail", payload.respondentEmail],
    ["payload.student_email", payload.student_email],
    ["payload.studentEmail", payload.studentEmail],
    ["payload.email", payload.email]
  ];

  for (const [source, value] of directCandidates) {
    const email = normaliseEmailCandidate_(value);
    if (email) return { value: email, source };
  }

  const exactNamed = exactEmailFromNamed_(named);
  if (exactNamed.value) return exactNamed;

  const configured = configuredEmailFromRawValues_(payload, sourceConfig);
  if (configured.value) return configured;

  const scannedNamed = scanEmailValuesFromNamed_(named);
  if (scannedNamed.value) return scannedNamed;

  const scannedRaw = scanEmailValuesFromRawValues_(payload);
  if (scannedRaw.value) return scannedRaw;

  return { value: "", source: "EMAIL_NOT_FOUND" };
}

function rawValues_(payload) {
  return Array.isArray(payload.raw_values) ? payload.raw_values : [];
}

function fieldValue_(payload, sourceConfig, fieldName) {
  const named = eventNamedValues_(payload);
  const aliases = SOURCE_HEADER_ALIASES[fieldName] || [];
  return valueFromNamedOrConfiguredColumn({
    named,
    rawValues: rawValues_(payload),
    aliases,
    sourceConfig,
    fieldName
  });
}

function sourceTimezone_(payload = {}, sourceConfig = {}) {
  return clean_(
    payload.spreadsheet?.timezone ||
    payload.source_timezone ||
    sourceConfig?.source_timezone ||
    sourceConfig?.timezone ||
    process.env.DEFAULT_SOURCE_TIMEZONE ||
    process.env.APP_TIMEZONE ||
    process.env.TZ ||
    process.env.SCHEDULER_TIMEZONE ||
    "Africa/Douala"
  );
}

function addImportExtractionMeta_(fields, key, info) {
  fields.extraction = fields.extraction || {};
  fields.extraction[key] = info?.source || "MISSING";
}

function payloadSpreadsheet_(payload) {
  const spreadsheet = payload.spreadsheet || {};
  const sheet = payload.sheet || {};
  return {
    google_spreadsheet_id: clean_(spreadsheet.id || payload.spreadsheet_id || payload.google_spreadsheet_id),
    spreadsheet_name: clean_(spreadsheet.name || payload.spreadsheet_name),
    sheet_name: clean_(sheet.name || payload.sheet_name || payload.tab_name || "Form Responses 1"),
    source_row_number: intOrNull_(sheet.row_number || payload.source_row_number || payload.row_number)
  };
}

function submittedAt_(payload, named, sourceConfig = null) {
  const timezone = sourceTimezone_(payload, sourceConfig || {});
  const rawValue = clean_(payload.submitted_at) || fieldValue_(payload, sourceConfig, "timestamp_col").value || valueFromNamed_(named, SOURCE_HEADER_ALIASES.timestamp_col);
  return {
    raw: rawValue,
    utc: parseSourceTimestampToUtc(rawValue, timezone),
    timezone
  };
}

function respondentEmail_(payload, named, sourceConfig = null) {
  return extractRespondentEmail_(payload, named, sourceConfig).value;
}

function sourceIdentityKey_(payload, source) {
  return clean_(payload.source_identity_key) || [source.google_spreadsheet_id, source.sheet_name, source.source_row_number || hash_(JSON.stringify(payload.raw_values || []) + JSON.stringify(payload.raw_named_values || {}))].join("|");
}

function extractFields_(payload, sourceConfig = null) {
  const named = eventNamedValues_(payload);
  const source = payloadSpreadsheet_(payload);
  const emailInfo = extractRespondentEmail_(payload, named, sourceConfig);
  const email = emailInfo.value;
  const submittedAtInfo = submittedAt_(payload, named, sourceConfig);
  const writingChoiceInfo = fieldValue_(payload, sourceConfig, "writing_choice_col");
  const speakingChoiceInfo = fieldValue_(payload, sourceConfig, "speaking_choice_col");
  const writingAnswerInfo = fieldValue_(payload, sourceConfig, "writing_answer_col");
  const audioLinkInfo = fieldValue_(payload, sourceConfig, "audio_link_col");
  const quizScoreInfo = fieldValue_(payload, sourceConfig, "quiz_score_col");
  const maxScoreInfo = fieldValue_(payload, sourceConfig, "max_score_col");
  const sourceTypeHint = upper_(payload.source_type || payload.source?.source_type || sourceConfig?.source_type || "");
  const fields = {
    named, source, email,
    submittedAt: submittedAtInfo.utc || null,
    submittedAtRaw: submittedAtInfo.raw || "",
    sourceTimezone: submittedAtInfo.timezone || "Africa/Douala",
    writingChoice: writingChoiceInfo.value,
    speakingChoice: speakingChoiceInfo.value,
    writingAnswer: writingAnswerInfo.value,
    audioLink: normaliseSpeakPipeLink(audioLinkInfo.value),
    quizScoreRaw: quizScoreInfo.value,
    maxScoreRaw: maxScoreInfo.value,
    sourceTypeHint,
    sourceIdentityKey: sourceIdentityKey_(payload, source),
    extraction: {}
  };
  addImportExtractionMeta_(fields, "timestamp_col", { source: submittedAtInfo.raw ? "SOURCE_TIMESTAMP" : "MISSING" });
  addImportExtractionMeta_(fields, "email_col", emailInfo);
  addImportExtractionMeta_(fields, "writing_choice_col", writingChoiceInfo);
  addImportExtractionMeta_(fields, "speaking_choice_col", speakingChoiceInfo);
  addImportExtractionMeta_(fields, "writing_answer_col", writingAnswerInfo);
  addImportExtractionMeta_(fields, "audio_link_col", audioLinkInfo);
  addImportExtractionMeta_(fields, "quiz_score_col", quizScoreInfo);
  addImportExtractionMeta_(fields, "max_score_col", maxScoreInfo);
  return fields;
}

async function upsertImportEvent_(client, fields, sourceRow, payload, options = {}) {
  const existing = await client.query(`select * from submission_import_events where source_identity_key = $1 limit 1`, [fields.sourceIdentityKey]);
  const values = [
    sourceRow?.id || null,
    fields.sourceIdentityKey,
    fields.source.google_spreadsheet_id,
    fields.source.sheet_name,
    fields.source.source_row_number,
    fields.submittedAt,
    fields.email,
    JSON.stringify(fields.named || {}),
    JSON.stringify(payload.raw_values || []),
    Boolean(payload.test_import),
    options.import_status || "IMPORTED",
    options.import_error || null
  ];
  if (existing.rows[0]) {
    const result = await client.query(`
      update submission_import_events
      set source_id=$1, google_spreadsheet_id=$3, sheet_name=$4, source_row_number=$5, submitted_at=$6,
          respondent_email=$7, raw_named_values=$8::jsonb, raw_values=$9::jsonb, test_import=$10,
          import_status=$11, import_error=$12, updated_at=now()
      where source_identity_key=$2
      returning *`, values);
    return result.rows[0];
  }
  const result = await client.query(`
    insert into submission_import_events(source_id, source_identity_key, google_spreadsheet_id, sheet_name, source_row_number, submitted_at, respondent_email, raw_named_values, raw_values, test_import, import_status, import_error)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
    returning *`, values);
  return result.rows[0];
}

async function updateImportEventStatus_(client, importEventId, status, errorMessage = null) {
  const result = await client.query(`
    update submission_import_events
    set import_status=$2, import_error=$3, updated_at=now()
    where id=$1
    returning *`,
    [importEventId, status, errorMessage]
  );
  return result.rows[0] || null;
}

async function findSource_(client, fields) {
  const result = await client.query(`
    select * from google_response_sources
    where google_spreadsheet_id = $1
      and active is true
      and upper(coalesce(status, 'ACTIVE')) not in ('INACTIVE','ARCHIVED','DISABLED')
    order by case when sheet_name = $2 then 0 else 1 end, created_at nulls last
    limit 1`, [fields.source.google_spreadsheet_id, fields.source.sheet_name]);
  return result.rows[0] || null;
}

async function findStudent_(client, email) {
  if (!email) return null;
  const result = await client.query(`select * from students where lower(trim(email)) = $1 limit 1`, [lower_(email)]);
  return result.rows[0] || null;
}

function statusIsInactive_(value) {
  return ["INACTIVE", "ARCHIVED", "DROPPED", "ENDED", "DISABLED", "SUSPENDED"].includes(upper_(value));
}

function rowIsActive_(row) {
  if (!row) return false;
  if (row.active === false) return false;
  if (statusIsInactive_(row.status)) return false;
  return true;
}

function sourceContext_(source = {}, fields = {}) {
  const tabKey = parseSheetTabKey_(fields?.source?.sheet_name || source.sheet_name || "");
  const sourceNameKey = sourceLevelModuleFromName_(source);
  return {
    level: upper_(tabKey?.level || source.level || sourceNameKey.level || ""),
    module: intOrNull_(tabKey?.module || source.module || sourceNameKey.module),
    unit: intOrNull_(tabKey?.unit || source.unit),
    day: intOrNull_(tabKey?.day || source.day),
    is_quiz: Boolean(tabKey?.is_quiz)
  };
}

function applySourceContext_(source = {}, context = {}) {
  return {
    ...source,
    level: context.level || source.level || null,
    module: context.module || source.module || null,
    unit: context.unit || source.unit || null,
    day: context.day || source.day || null
  };
}

async function findEnrollment_(client, studentId, context = {}) {
  if (!studentId) return null;
  const params = [studentId];
  const where = [
    `e.student_id = $1`,
    `e.active is true`,
    `e.teacher_id is not null`,
    `upper(coalesce(e.status,'ACTIVE')) not in ('INACTIVE','ARCHIVED','DROPPED','ENDED','DISABLED','SUSPENDED')`
  ];
  if (context.level) {
    params.push(upper_(context.level));
    where.push(`upper(coalesce(e.level,'')) = $${params.length}`);
  }
  const result = await client.query(`
    select e.*,
           t.full_name as teacher_name,
           t.email as teacher_email,
           t.phone as teacher_phone,
           t.whatsapp_number as teacher_whatsapp_number
    from enrollments e
    left join teachers t on t.id = e.teacher_id
    where ${where.join(" and ")}
    order by e.start_date desc nulls last, e.created_at desc nulls last
    limit 1`, params);
  return result.rows[0] || null;
}

function ineligibleReason_(fields, student, enrollment, context) {
  if (!fields.email) return "Missing respondent email. Submission was not imported.";
  if (!student) return `No student found for email ${fields.email}. Submission was not imported.`;
  if (!rowIsActive_(student)) return `Student ${fields.email} is inactive. Submission was not imported.`;
  if (!enrollment) {
    const levelNote = context.level ? ` for level ${context.level}` : "";
    return `No active enrollment${levelNote} found for student ${fields.email}. Submission was not imported.`;
  }
  return "";
}

async function queryTask_(client, { source, enrollment, skillType, extraWhere = [], extraParams = [], orderBy = "day nulls last, choice_number nulls last" }) {
  const level = upper_(source?.level || enrollment?.level || "");
  const moduleNo = intOrNull_(source?.module);
  const unitNo = intOrNull_(source?.unit);
  const dayNo = intOrNull_(source?.day);
  const skill = upper_(skillType);

  const params = [skill];
  const where = [`upper(skill_type) = $1`, `active is true`];

  if (level) { params.push(level); where.push(`upper(level) = $${params.length}`); }
  if (moduleNo) { params.push(moduleNo); where.push(`module = $${params.length}`); }
  if (unitNo) { params.push(unitNo); where.push(`unit = $${params.length}`); }
  if (dayNo) { params.push(dayNo); where.push(`day = $${params.length}`); }

  for (const clause of extraWhere) where.push(clause(params.length));
  params.push(...extraParams);

  const result = await client.query(
    `select * from task_catalog where ${where.join(" and ")} order by ${orderBy} limit 1`,
    params
  );
  return result.rows[0] || null;
}

async function findTask_(client, { source, enrollment, skillType, choiceText, choiceNumber }) {
  const parsedChoiceNumber = intOrNull_(choiceNumber) || choiceNumberFromText_(choiceText);
  const strippedChoiceText = stripChoicePrefix_(choiceText);
  const normalizedCandidates = uniqueNonEmpty_([
    normalizeChoice_(strippedChoiceText),
    normalizeChoice_(choiceText)
  ]);
  const rawTextCandidates = uniqueNonEmpty_([strippedChoiceText, choiceText]);

  // Production-safe primary match: Google Forms choices often look like
  // "Option 2 - Le rapport au manager", while task_catalog stores both the
  // stable choice_number and a shorter choice_text. The number is the most
  // reliable key once level/module/unit/day/skill are known from the tab name.
  if (parsedChoiceNumber) {
    const byNumber = await queryTask_(client, {
      source,
      enrollment,
      skillType,
      extraParams: [parsedChoiceNumber],
      extraWhere: [(offset) => `choice_number = $${offset + 1}`],
      orderBy: "choice_number nulls last, updated_at desc nulls last, created_at desc nulls last"
    });
    if (byNumber) return byNumber;
  }

  for (const normalized of normalizedCandidates) {
    const byNormalized = await queryTask_(client, {
      source,
      enrollment,
      skillType,
      extraParams: [normalized],
      extraWhere: [(offset) => `choice_text_normalized = $${offset + 1}`],
      orderBy: "choice_number nulls last, updated_at desc nulls last, created_at desc nulls last"
    });
    if (byNormalized) return byNormalized;
  }

  // Apps Script fallback: match by a stable hash of normalised choice text.
  // Older migrated task_catalog rows store a 16-character SHA-256 prefix.
  for (const normalized of normalizedCandidates) {
    const byHash = await queryTask_(client, {
      source,
      enrollment,
      skillType,
      extraParams: [hash16_(normalized)],
      extraWhere: [(offset) => `choice_text_hash = $${offset + 1}`],
      orderBy: "choice_number nulls last, updated_at desc nulls last, created_at desc nulls last"
    });
    if (byHash) return byHash;
  }

  for (const rawText of rawTextCandidates) {
    const byRawText = await queryTask_(client, {
      source,
      enrollment,
      skillType,
      extraParams: [rawText],
      extraWhere: [(offset) => `lower(choice_text) = lower($${offset + 1})`],
      orderBy: "choice_number nulls last, updated_at desc nulls last, created_at desc nulls last"
    });
    if (byRawText) return byRawText;
  }

  return null;
}

function assignmentKey_(task, source, skillType) {
  const level = upper_(task?.level || source?.level || "");
  const moduleNo = task?.module || source?.module || "";
  const unitNo = task?.unit || source?.unit || "";
  const dayNo = task?.day || "";
  const skill = upper_(skillType);
  return [level && `${level}`, moduleNo && `M${moduleNo}`, unitNo && `U${unitNo}`, dayNo && `D${dayNo}`, skill].filter(Boolean).join("_");
}

function firstNonNull_(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && clean_(value) !== "") return value;
  }
  return null;
}

function assignmentKeyFromParts_({ source = {}, writingTask = null, speakingTask = null } = {}) {
  const level = upper_(writingTask?.level || speakingTask?.level || source?.level || "");
  const moduleNo = writingTask?.module || speakingTask?.module || source?.module || "";
  const unitNo = writingTask?.unit || speakingTask?.unit || source?.unit || "";
  const dayNo = writingTask?.day || speakingTask?.day || source?.day || "";
  return [
    level && `${level}`,
    moduleNo && `M${moduleNo}`,
    unitNo && `U${unitNo}`,
    dayNo && `D${dayNo}`,
    "ASSIGNMENT"
  ].filter(Boolean).join("_");
}

async function upsertAssignmentSubmission_(client, {
  importEvent,
  source,
  student,
  enrollment,
  writingTask,
  speakingTask,
  fields
}) {
  if (!writingTask && !speakingTask) return null;

  const primaryTask = writingTask || speakingTask;
  const level = firstNonNull_(writingTask?.level, speakingTask?.level, source?.level, enrollment?.level);
  const moduleNo = firstNonNull_(writingTask?.module, speakingTask?.module, source?.module);
  const unitNo = firstNonNull_(writingTask?.unit, speakingTask?.unit, source?.unit);
  const dayNo = firstNonNull_(writingTask?.day, speakingTask?.day, source?.day);
  const writingChoiceText = firstNonNull_(fields.writingChoice, writingTask?.choice_text);
  const speakingChoiceText = firstNonNull_(fields.speakingChoice, speakingTask?.choice_text);
  const primaryChoiceText = writingChoiceText || speakingChoiceText;
  const primaryChoiceNumber = firstNonNull_(writingTask?.choice_number, speakingTask?.choice_number);
  const assignmentKey = assignmentKeyFromParts_({ source, writingTask, speakingTask });
  const writingAnswer = fields.writingAnswer || null;
  const audioLink = fields.audioLink || null;
  const normalizedWritingAnswer = normalizeSubmissionIdentityText_(writingAnswer);
  const normalizedAudioLink = normalizeSubmissionIdentityText_(audioLink);

  const params = [
    importEvent.id,
    source?.id || null,
    student?.id || null,
    enrollment?.teacher_id || null,
    primaryTask.id,
    "ASSIGNMENT",
    level || null,
    moduleNo || null,
    unitNo || null,
    dayNo || null,
    primaryChoiceNumber || null,
    primaryChoiceText || null,
    assignmentKey,
    writingAnswer,
    writingAnswer,
    writingTask?.full_instruction || null,
    speakingTask?.full_instruction || null,
    writingChoiceText || null,
    speakingChoiceText || null,
    audioLink,
    audioLink,
    importEvent.submitted_at
  ];

  const existing = await client.query(
    `select * from submission_inbox where import_event_id = $1 and skill_type = 'ASSIGNMENT' limit 1`,
    [importEvent.id]
  );

  if (existing.rows[0]) {
    const result = await client.query(`
      update submission_inbox
      set
        source_id=$2,
        student_id=$3,
        teacher_id=$4,
        task_id=$5,
        skill_type=$6,
        level=$7,
        module=$8,
        unit=$9,
        day=$10,
        choice_number=$11,
        choice_text=$12,
        assignment_key=$13,
        writing_answer=$14,
        answer_text=$15,
        writing_task_instruction=$16,
        speaking_task_instruction=$17,
        writing_choice_text=$18,
        speaking_choice_text=$19,
        speakpipe_link=$20,
        audio_link=$21,
        submitted_at=$22,
        updated_at=now()
      where import_event_id=$1 and skill_type='ASSIGNMENT'
      returning *`, params);
    return result.rows[0];
  }

  if (student?.id && assignmentKey && (normalizedAudioLink || normalizedWritingAnswer)) {
    const duplicate = await client.query(
      `select *
         from submission_inbox
        where student_id = $1
          and skill_type = 'ASSIGNMENT'
          and assignment_key = $2
          and regexp_replace(lower(trim(coalesce(audio_link::text, ''))), '\\s+', ' ', 'g') = $3
          and regexp_replace(lower(trim(coalesce(writing_answer::text, ''))), '\\s+', ' ', 'g') = $4
        order by submitted_at asc nulls last, created_at asc nulls last, id
        limit 1`,
      [student.id, assignmentKey, normalizedAudioLink, normalizedWritingAnswer]
    );

    if (duplicate.rows[0]) {
      const reused = duplicate.rows[0];
      const note = `Duplicate form response reused existing submission ${reused.id} for same student, assignment_key, audio_link, and writing_answer.`;
      const refreshedImportEvent = await updateImportEventStatus_(client, importEvent.id, "DUPLICATE_REUSED_EXISTING_SUBMISSION", note);
      if (refreshedImportEvent) Object.assign(importEvent, refreshedImportEvent);

      const result = await client.query(
        `update submission_inbox
            set updated_at = now(),
                notes = concat_ws(E'\n', nullif(notes, ''), $2)
          where id = $1
          returning *`,
        [reused.id, `${note} Import event: ${importEvent.id}.`]
      );
      return result.rows[0] || reused;
    }
  }

  const result = await client.query(`
    insert into submission_inbox(
      import_event_id, source_id, student_id, teacher_id, task_id, skill_type, level, module, unit, day,
      choice_number, choice_text, assignment_key, writing_answer, answer_text, writing_task_instruction,
      speaking_task_instruction, writing_choice_text, speaking_choice_text, speakpipe_link, audio_link, submitted_at
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    returning *`, params);
  return result.rows[0];
}

async function upsertAudioAsset_(client, { submission, importEvent, student, enrollment, task, audioLink }) {
  if (!submission || !audioLink) return null;
  const existing = await client.query(`select * from audio_assets where submission_id = $1 and source_url = $2 limit 1`, [submission.id, audioLink]);
  const params = [submission.id, importEvent.id, student?.id || null, enrollment?.teacher_id || null, task?.id || null, audioLink];
  if (existing.rows[0]) {
    const result = await client.query(`update audio_assets set import_event_id=$2, student_id=$3, teacher_id=$4, task_id=$5, updated_at=now() where submission_id=$1 and source_url=$6 returning *`, params);
    return result.rows[0];
  }
  const result = await client.query(`insert into audio_assets(submission_id, import_event_id, student_id, teacher_id, task_id, source_url, status) values ($1,$2,$3,$4,$5,$6,'READY_FOR_STORAGE') returning *`, params);
  return result.rows[0];
}

async function markBadWritingSubmission_(client, { submission, writingInfo } = {}) {
  if (!submission?.id || !writingInfo || writingInfo.valid) return submission || null;

  const note = [
    `Bad writing submission: ${clean_(writingInfo.issue_code)}.`,
    clean_(writingInfo.issue_message),
    Number.isFinite(Number(writingInfo.word_count)) ? `Word count: ${Number(writingInfo.word_count)}.` : "",
    "No writing correction job should be created and no writing score should be assigned for this submission."
  ].filter(Boolean).join(" ");

  const result = await client.query(
    `update submission_inbox
        set status = 'BAD_WRITING_SUBMISSION',
            updated_at = now(),
            notes = concat_ws(E'\n', nullif(notes, ''), $2)
      where id = $1
      returning *`,
    [submission.id, note]
  );

  return result.rows[0] || submission;
}

async function markLatestSubmissionAttempt_(client, submission) {
  if (!submission?.student_id || !submission?.assignment_key) return null;

  await client.query(
    `update submission_inbox
        set status = 'SUPERSEDED_BY_LATEST_SUBMISSION',
            updated_at = now(),
            notes = concat_ws(E'\n', nullif(notes, ''), 'Superseded by a later submission for the same student and assignment_key.')
      where student_id = $1
        and skill_type = 'ASSIGNMENT'
        and assignment_key = $2
        and id <> $3`,
    [submission.student_id, submission.assignment_key, submission.id]
  );

  const result = await client.query(
    `update submission_inbox
        set status = 'LATEST_VALID',
            updated_at = now()
      where id = $1
      returning *`,
    [submission.id]
  );

  return result.rows[0] || submission;
}

async function upsertQuiz_(client, { importEvent, source, student, enrollment, fields }) {
  const sourceType = upper_(source?.source_type || fields.sourceTypeHint);
  if (sourceType !== "QUIZ" && !fields.quizScoreRaw) return null;

  const score = numOrNull_(fields.quizScoreRaw);
  const maxScore = numOrNull_(fields.maxScoreRaw);
  const inferredMaxScore = maxScore || (score != null && score <= 100 ? 100 : null);
  const percentage = score != null && inferredMaxScore ? Math.round((score / inferredMaxScore) * 10000) / 100 : null;
  const dayNo = intOrNull_(source?.day);
  const quizKey = [
    upper_(source?.level || enrollment?.level || "QUIZ"),
    source?.module && `M${source.module}`,
    source?.unit && `U${source.unit}`,
    dayNo && `D${dayNo}`
  ].filter(Boolean).join("_") || "QUIZ";

  const params = [
    importEvent.id,
    source?.id || null,
    student?.id || null,
    enrollment?.teacher_id || null,
    source?.level || enrollment?.level || null,
    source?.module || null,
    source?.unit || null,
    dayNo || null,
    quizKey,
    score,
    inferredMaxScore,
    percentage,
    fields.quizScoreRaw || null,
    importEvent.submitted_at
  ];

  const existing = await client.query(
    `select *
       from quiz_scores
      where student_id = $1
        and quiz_key = $2
      order by submitted_at desc nulls last, updated_at desc nulls last, created_at desc nulls last, id desc
      limit 1`,
    [student?.id || null, quizKey]
  );

  if (existing.rows[0]) {
    const existingSubmittedAt = existing.rows[0].submitted_at ? new Date(existing.rows[0].submitted_at).getTime() : 0;
    const incomingSubmittedAt = importEvent.submitted_at ? new Date(importEvent.submitted_at).getTime() : 0;

    if (existingSubmittedAt && incomingSubmittedAt && incomingSubmittedAt < existingSubmittedAt) {
      return {
        ...existing.rows[0],
        skipped_older_attempt: true,
        skipped_import_event_id: importEvent.id,
        attempted_submitted_at: importEvent.submitted_at || null
      };
    }

    const result = await client.query(
      `update quiz_scores
          set import_event_id = $1,
              source_id = $2,
              student_id = $3,
              teacher_id = $4,
              level = $5,
              module = $6,
              unit = $7,
              day = $8,
              score = $10,
              max_score = $11,
              percentage = $12,
              score_display = $13,
              submitted_at = $14,
              updated_at = now()
        where id = $15
        returning *`,
      [...params, existing.rows[0].id]
    );
    return result.rows[0];
  }

  const result = await client.query(
    `insert into quiz_scores(
       import_event_id, source_id, student_id, teacher_id, level, module, unit, day,
       quiz_key, score, max_score, percentage, score_display, submitted_at
     )
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     returning *`,
    params
  );
  return result.rows[0];
}

async function createMissingJobForAssignmentPart_(client, { submission, jobType, task, status, provider }) {
  if (!submission || !task) return { created: false, skipped: true, job_type: jobType, reason: "Missing submission or task." };

  const existing = await client.query(
    `select id from ai_drafts where submission_id=$1 and job_type=$2 limit 1`,
    [submission.id, jobType]
  );

  if (existing.rows[0]) return { created: false, job_type: jobType, id: existing.rows[0].id };

  const result = await client.query(`
    insert into ai_drafts(
      submission_id, student_id, teacher_id, task_id, job_type, status, review_status, level, raw_json, ai_provider, created_at, updated_at
    )
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,now(),now())
    returning *`,
    [
      submission.id,
      submission.student_id,
      submission.teacher_id,
      task.id,
      jobType,
      status,
      "NOT_READY",
      submission.level,
      JSON.stringify({
        created_by: "import_layer",
        submission_id: submission.id,
        assignment_key: submission.assignment_key,
        task_id: task.id,
        task_code: task.task_code || null,
        task_key: task.task_key || null
      }),
      provider
    ]
  );

  return { created: true, job_type: jobType, id: result.rows[0].id };
}

async function createMissingJobsForAssignmentSubmission_(client, { submission, writingTask, speakingTask, writingInfo = null, linkInfo = null } = {}) {
  const jobs = [];
  const effectiveWritingInfo = writingInfo || classifyWritingAnswer(submission?.writing_answer || submission?.answer_text || "");
  const audioLink = clean_(submission?.audio_link || submission?.speakpipe_link);
  const effectiveLinkInfo = linkInfo || (audioLink ? classifySpeakPipeLink(audioLink) : null);

  if (writingTask && effectiveWritingInfo.valid) {
    jobs.push(await createMissingJobForAssignmentPart_(client, {
      submission,
      jobType: "WRITING_CORRECTION",
      task: writingTask,
      status: "QUEUED",
      provider: "deepseek"
    }));
  }

  if (speakingTask && audioLink && (!effectiveLinkInfo || effectiveLinkInfo.valid)) {
    jobs.push(await createMissingJobForAssignmentPart_(client, {
      submission,
      jobType: "SPEAKING_EVALUATION",
      task: speakingTask,
      status: "WAITING_FOR_AUDIO_STORAGE",
      provider: "openai"
    }));
  }

  return jobs;
}

async function findTaskForExistingSubmission_(client, submission, skillType) {
  const choiceText = skillType === "WRITING"
    ? submission.writing_choice_text || submission.choice_text
    : submission.speaking_choice_text || submission.choice_text;

  return findTask_(client, {
    source: submission,
    enrollment: null,
    skillType,
    choiceText,
    choiceNumber: choiceNumberFromText_(choiceText)
  });
}


function importAlertDetails_({ fields = {}, importEvent = null, source = null, effectiveSource = null, student = null, enrollment = null, taskMatchWarnings = [], extra = {} } = {}) {
  return {
    source_identity_key: fields.sourceIdentityKey || importEvent?.source_identity_key || "",
    import_event_id: importEvent?.id || "",
    google_spreadsheet_id: fields.source?.google_spreadsheet_id || source?.google_spreadsheet_id || "",
    spreadsheet_name: fields.source?.spreadsheet_name || source?.spreadsheet_name || "",
    event_sheet_name: fields.source?.sheet_name || "",
    configured_sheet_name: source?.sheet_name || "",
    effective_sheet_name: effectiveSource?.sheet_name || "",
    source_row_number: fields.source?.source_row_number || "",
    respondent_email: fields.email || "",
    student_id: student?.id || "",
    enrollment_id: enrollment?.id || "",
    teacher_id: enrollment?.teacher_id || "",
    level: effectiveSource?.level || enrollment?.level || "",
    module: effectiveSource?.module || "",
    unit: effectiveSource?.unit || "",
    day: effectiveSource?.day || "",
    writing_choice: fields.writingChoice || "",
    speaking_choice: fields.speakingChoice || "",
    writing_answer_present: Boolean(clean_(fields.writingAnswer)),
    audio_link: fields.audioLink || "",
    extraction: fields.extraction || {},
    task_match_warnings: taskMatchWarnings,
    ...extra
  };
}


function immediateImportEmailDeliveryEnabled_() {
  const raw = process.env.SEND_IMPORT_NOTIFICATION_EMAILS_IMMEDIATELY ??
    process.env.IMPORT_NOTIFICATION_EMAIL_IMMEDIATE_DELIVERY ??
    process.env.SEND_INTERVENTION_EMAILS_IMMEDIATELY ??
    "true";
  return truthy_(raw) || clean_(raw) === "";
}

function queueRowFromAny_(value) {
  if (!value) return null;
  if (value.id && value.source_type) return value;
  if (value.queued && value.queued.id) return value.queued;
  if (value.email && value.email.queued && value.email.queued.id) return value.email.queued;
  if (value.email && value.email.id && value.email.source_type) return value.email;
  return null;
}

function addQueuedImportEmails_(collector, value) {
  if (!collector) return;
  if (Array.isArray(value)) {
    value.forEach((item) => addQueuedImportEmails_(collector, item));
    return;
  }
  const row = queueRowFromAny_(value);
  if (row?.id) collector.push(row);
}

async function deliverQueuedImportNotificationEmails_(queuedEmails = [], context = {}) {
  const rows = [];
  const seen = new Set();

  for (const row of queuedEmails || []) {
    const id = clean_(row?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push(row);
  }

  const result = {
    ok: true,
    mode: "IMMEDIATE_IMPORT_NOTIFICATION_EMAIL_DELIVERY",
    enabled: immediateImportEmailDeliveryEnabled_(),
    queued_email_count: rows.length,
    send_results: [],
    context: {
      import_event_id: clean_(context.importEventId || context.import_event_id),
      source_identity_key: clean_(context.sourceIdentityKey || context.source_identity_key),
      source_tab: clean_(context.sourceTab || context.source_tab),
      student_email: clean_(context.studentEmail || context.student_email)
    },
    checked_at: nowIso_()
  };

  if (!result.enabled || !rows.length) return result;

  for (const row of rows) {
    try {
      const sendResult = await sendOneQueuedStudentFeedbackEmail({
        emailId: row.id,
        sourceTypes: [row.source_type],
        workerId: "form-import-immediate-email-delivery"
      });
      result.send_results.push(sendResult);
    } catch (error) {
      result.ok = false;
      result.send_results.push({
        ok: false,
        status: "IMMEDIATE_EMAIL_SEND_FAILED",
        email_queue_id: row.id,
        source_type: row.source_type,
        error: error?.message || String(error),
        checked_at: nowIso_()
      });
    }
  }

  result.ok = result.send_results.every((item) => item.ok !== false);
  return result;
}

async function safeQueueImportMaintainerAlert_(options = {}) {
  try {
    return await createAndQueueMaintainerAlert(options);
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      process_event: "maintainer_alert_queue_failed",
      alert_type: options.alert_type || options.issue_type || "IMPORT_ALERT",
      error: error?.message || String(error),
      at: nowIso_()
    }));
    return null;
  }
}

export async function importFormSubmissionEvent(payload = {}) {
  return withSupabaseClient(async (client) => {
    let fields = extractFields_(payload);
    if (!fields.source.google_spreadsheet_id) throw new Error("Missing spreadsheet.id/google_spreadsheet_id in form submission payload.");
    const source = await findSource_(client, fields);
    if (!source) throw new Error(`No active google_response_sources row found for spreadsheet ${fields.source.google_spreadsheet_id}. Import source mappings first.`);
    const context = sourceContext_(source, fields);
    const effectiveSource = applySourceContext_(source, context);
    const student = await findStudent_(client, fields.email);
    const enrollment = await findEnrollment_(client, student?.id, context);
    const rejectionReason = ineligibleReason_(fields, student, enrollment, context);
    await client.query("begin");
    try {
      if (rejectionReason) {
        const importEvent = await upsertImportEvent_(client, fields, effectiveSource, payload, {
          import_status: "SKIPPED_INELIGIBLE",
          import_error: rejectionReason
        });
        await client.query("commit");
        return {
          ok: true,
          status: "FORM_SUBMISSION_SKIPPED_INELIGIBLE",
          reason: rejectionReason,
          source: { id: source.id, google_spreadsheet_id: source.google_spreadsheet_id, source_type: source.source_type },
          student: student ? { id: student.id, email: student.email, full_name: student.full_name, active: student.active, status: student.status } : null,
          enrollment: null,
          import_event: importEvent,
          submissions: [],
          quiz: null,
          audio_asset: null,
          jobs: [],
          checked_at: nowIso_()
        };
      }

      fields = extractFields_(payload, effectiveSource);
      const missingTimestampWarning = fields.submittedAt ? "" : "Source timestamp is missing or could not be parsed. submitted_at was left null instead of using import time.";
      const importEvent = await upsertImportEvent_(client, fields, effectiveSource, payload, missingTimestampWarning ? { import_status: "IMPORTED_WITH_WARNINGS", import_error: missingTimestampWarning } : {});
      const submissions = [];
      const jobs = [];
      let audioAsset = null;
      let quiz = null;
      let queuedEmail = null;
      const queuedImportNotificationEmails = [];
      let immediateEmailDelivery = null;
      if (upper_(effectiveSource.source_type) === "QUIZ" || fields.quizScoreRaw) {
        quiz = await upsertQuiz_(client, { importEvent, source: effectiveSource, student, enrollment, fields });
        if (quiz?.skipped_older_attempt) {
          const olderAttemptMessage = `Older quiz attempt for ${quiz.quiz_key || "quiz"} was not applied because a later submitted attempt already exists.`;
          const refreshedImportEvent = await updateImportEventStatus_(client, importEvent.id, "QUIZ_SCORE_IMPORTED_WITH_WARNINGS", olderAttemptMessage);
          if (refreshedImportEvent) Object.assign(importEvent, refreshedImportEvent);
        } else if (quiz) {
          const quizImportStatus = missingTimestampWarning ? "QUIZ_SCORE_IMPORTED_WITH_WARNINGS" : "QUIZ_SCORE_IMPORTED";
          const refreshedImportEvent = await updateImportEventStatus_(client, importEvent.id, quizImportStatus, missingTimestampWarning || null);
          if (refreshedImportEvent) Object.assign(importEvent, refreshedImportEvent);

          queuedEmail = await queueQuizCompletionEmail(client, { quiz, student, enrollment, importEvent });
          addQueuedImportEmails_(queuedImportNotificationEmails, queuedEmail);
          if (!queuedEmail) {
            const alertQueueResult = await safeQueueImportMaintainerAlert_({
              alert_type: "QUIZ_CONFIRMATION_EMAIL_NOT_QUEUED",
              severity: "WARNING",
              title: "Quiz was imported but confirmation email was not queued",
              message: "A quiz score was imported successfully, but no QUIZ_COMPLETION_ACK email was queued. Check email queue configuration, student/enrollment data, and intervention email delivery settings.",
              entity_type: "quiz_score",
              entity_id: quiz.id || "",
              student_id: student?.id || "",
              teacher_id: enrollment?.teacher_id || "",
              source_spreadsheet_id: fields.source.google_spreadsheet_id,
              source_tab: fields.source.sheet_name,
              source_row: fields.source.source_row_number ? String(fields.source.source_row_number) : "",
              assignment_key: quiz.quiz_key || "",
              fingerprint: `QUIZ_CONFIRMATION_EMAIL_NOT_QUEUED:${quiz.id || fields.sourceIdentityKey || importEvent.id}`,
              details_json: importAlertDetails_({
                fields,
                importEvent,
                source,
                effectiveSource,
                student,
                enrollment,
                extra: {
                  quiz_id: quiz.id || "",
                  quiz_key: quiz.quiz_key || "",
                  score_display: quiz.score_display || "",
                  rule: "Quiz imports should queue a QUIZ_COMPLETION_ACK email immediately. Delivery requires the intervention email delivery scheduler or a manual email:once run with QUIZ_COMPLETION_ACK included."
                }
              })
            });
            addQueuedImportEmails_(queuedImportNotificationEmails, alertQueueResult);
          }
        }
      } else {
        const hasWritingData = Boolean(fields.writingChoice || fields.writingAnswer);
        const hasSpeakingData = Boolean(fields.speakingChoice || fields.audioLink);
        const writingTask = hasWritingData
          ? await findTask_(client, {
              source: effectiveSource,
              enrollment,
              skillType: "WRITING",
              choiceText: fields.writingChoice,
              choiceNumber: choiceNumberFromText_(fields.writingChoice)
            })
          : null;
        const speakingTask = hasSpeakingData
          ? await findTask_(client, {
              source: effectiveSource,
              enrollment,
              skillType: "SPEAKING",
              choiceText: fields.speakingChoice,
              choiceNumber: choiceNumberFromText_(fields.speakingChoice)
            })
          : null;

        const taskMatchWarnings = [];
        if (hasWritingData && !writingTask) {
          taskMatchWarnings.push(`Writing task was not matched for choice "${fields.writingChoice || ""}" on tab ${effectiveSource.sheet_name || fields.source.sheet_name}.`);
        }
        if (hasSpeakingData && !speakingTask) {
          taskMatchWarnings.push(`Speaking task was not matched for choice "${fields.speakingChoice || ""}" on tab ${effectiveSource.sheet_name || fields.source.sheet_name}.`);
        }

        if ((hasWritingData || hasSpeakingData) && !writingTask && !speakingTask) {
          const warningText = taskMatchWarnings.join(" ") || "Assignment data was present, but no matching task_catalog row was found.";
          const updatedImportEvent = await updateImportEventStatus_(client, importEvent.id, "TASK_MATCH_FAILED", warningText);
          await client.query("commit");

          const alertQueueResult = await safeQueueImportMaintainerAlert_({
            alert_type: "IMPORT_TASK_MATCH_FAILED",
            severity: "ERROR",
            title: "Form submission reached Supabase but task matching failed",
            message: "A student submitted an assignment row, but the import layer could not match either the writing task or the speaking task. The student was not emailed because this is an internal task-mapping problem.",
            entity_type: "submission_import_event",
            entity_id: (updatedImportEvent || importEvent)?.id || "",
            student_id: student?.id || "",
            teacher_id: enrollment?.teacher_id || "",
            source_spreadsheet_id: fields.source.google_spreadsheet_id,
            source_tab: fields.source.sheet_name,
            source_row: fields.source.source_row_number ? String(fields.source.source_row_number) : "",
            assignment_key: assignmentKeyFromParts_({ source: effectiveSource }),
            fingerprint: `IMPORT_TASK_MATCH_FAILED:${fields.sourceIdentityKey || importEvent.source_identity_key || importEvent.id}`,
            details_json: importAlertDetails_({
              fields,
              importEvent: updatedImportEvent || importEvent,
              source,
              effectiveSource,
              student,
              enrollment,
              taskMatchWarnings,
              extra: {
                warning_text: warningText,
                rule: "The backend follows the old Apps Script matching sequence: extract selected choices, match by lesson+skill+choice number first, then normalised text/hash/raw text. No student warning is sent for internal task mapping failure."
              }
            })
          });
          const immediateEmailDelivery = await deliverQueuedImportNotificationEmails_([alertQueueResult], {
            importEventId: (updatedImportEvent || importEvent)?.id,
            sourceIdentityKey: fields.sourceIdentityKey || importEvent.source_identity_key,
            sourceTab: fields.source.sheet_name,
            studentEmail: fields.email
          });

          return {
            ok: true,
            status: "FORM_SUBMISSION_TASK_MATCH_FAILED",
            source: { id: source.id, google_spreadsheet_id: source.google_spreadsheet_id, source_type: source.source_type },
            student: student ? { id: student.id, email: student.email, full_name: student.full_name } : null,
            enrollment: enrollment ? { id: enrollment.id, teacher_id: enrollment.teacher_id, level: enrollment.level } : null,
            import_event: updatedImportEvent || importEvent,
            task_match_warnings: taskMatchWarnings,
            submissions: [],
            quiz: null,
            audio_asset: null,
            jobs: [],
            immediate_email_delivery: immediateEmailDelivery,
            checked_at: nowIso_()
          };
        }

        const sub = await upsertAssignmentSubmission_(client, {
          importEvent,
          source: effectiveSource,
          student,
          enrollment,
          writingTask,
          speakingTask,
          fields
        });

        if (sub) {
          const latestSub = await markLatestSubmissionAttempt_(client, sub);
          const activeSub = latestSub || sub;
          submissions.push(activeSub);

          let linkInfo = fields.audioLink ? classifySpeakPipeLink(fields.audioLink) : {
            valid: false,
            issue_code: "AUDIO_LINK_EMPTY",
            issue_message: "Aucun lien SpeakPipe n’a été envoyé."
          };

          if (speakingTask && linkInfo.valid) {
            try {
              await claimSpeakingAudioLinkForAssignment(client, {
                canonicalSourceUrl: linkInfo.normalized_url,
                studentId: activeSub.student_id,
                assignmentKey: activeSub.assignment_key,
                submissionId: activeSub.id
              });
            } catch (error) {
              if (!(error instanceof SpeakingAudioLinkOwnershipError)) throw error;
              linkInfo = {
                valid: false,
                issue_code: error.code,
                issue_message: "This SpeakPipe recording already belongs to another student assignment.",
                normalized_url: linkInfo.normalized_url
              };
            }
          }

          const writingInfo = classifyWritingAnswer(activeSub.writing_answer || activeSub.answer_text || "");
          let submissionForJobs = activeSub;

          if (writingTask && !writingInfo.valid) {
            submissionForJobs = await markBadWritingSubmission_(client, {
              submission: activeSub,
              writingInfo
            }) || activeSub;

            const badWritingEmails = await queueBadWritingSubmissionEmails(client, {
              submission: submissionForJobs,
              student,
              enrollment,
              writingInfo
            });
            addQueuedImportEmails_(queuedImportNotificationEmails, badWritingEmails);
          }

          if (speakingTask && !linkInfo.valid) {
            const remediation = await createInvalidLinkRemediation(client, {
              submission: submissionForJobs,
              student,
              enrollment,
              speakingTask,
              linkInfo
            });
            if (remediation.created) {
              const badLinkEmails = await queueBadSpeakpipeLinkEmails(client, {
                submission: submissionForJobs,
                student,
                enrollment,
                linkInfo,
                remediation
              });
              addQueuedImportEmails_(queuedImportNotificationEmails, badLinkEmails);
            }
          }

          jobs.push(...await createMissingJobsForAssignmentSubmission_(client, {
            submission: submissionForJobs,
            writingTask,
            speakingTask,
            writingInfo,
            linkInfo
          }));

          if (fields.audioLink && speakingTask && linkInfo.valid) {
            audioAsset = await upsertAudioAsset_(client, {
              submission: submissionForJobs,
              importEvent,
              student,
              enrollment,
              task: speakingTask,
              audioLink: fields.audioLink
            });
          }

          if (writingInfo.valid && clean_(submissionForJobs.writing_answer) && speakingTask && linkInfo.valid) {
            const receiptEmail = await queueAssignmentReceiptEmail(client, {
              submission: submissionForJobs,
              student,
              enrollment
            });
            addQueuedImportEmails_(queuedImportNotificationEmails, receiptEmail);
          }
        }

        if (taskMatchWarnings.length) {
          const warningText = taskMatchWarnings.join(" ");
          const refreshedImportEvent = await updateImportEventStatus_(client, importEvent.id, "IMPORTED_WITH_WARNINGS", warningText);
          if (refreshedImportEvent) Object.assign(importEvent, refreshedImportEvent);
          const alertQueueResult = await safeQueueImportMaintainerAlert_({
            alert_type: "IMPORT_PARTIAL_TASK_MATCH_WARNING",
            severity: "WARNING",
            title: "Form submission imported with task-matching warning",
            message: "A student submission was imported, but one side of the assignment did not match task_catalog. Review the source mapping and task catalog.",
            entity_type: "submission_import_event",
            entity_id: importEvent?.id || "",
            student_id: student?.id || "",
            teacher_id: enrollment?.teacher_id || "",
            source_spreadsheet_id: fields.source.google_spreadsheet_id,
            source_tab: fields.source.sheet_name,
            source_row: fields.source.source_row_number ? String(fields.source.source_row_number) : "",
            assignment_key: submissions[0]?.assignment_key || assignmentKeyFromParts_({ source: effectiveSource, writingTask, speakingTask }),
            fingerprint: `IMPORT_PARTIAL_TASK_MATCH_WARNING:${fields.sourceIdentityKey || importEvent.source_identity_key || importEvent.id}`,
            details_json: importAlertDetails_({ fields, importEvent, source, effectiveSource, student, enrollment, taskMatchWarnings })
          });
          addQueuedImportEmails_(queuedImportNotificationEmails, alertQueueResult);
        }
      }
      await client.query("commit");
      immediateEmailDelivery = await deliverQueuedImportNotificationEmails_(queuedImportNotificationEmails, {
        importEventId: importEvent?.id,
        sourceIdentityKey: fields.sourceIdentityKey || importEvent.source_identity_key,
        sourceTab: fields.source.sheet_name,
        studentEmail: fields.email
      });
      return { ok: true, status: quiz ? "FORM_QUIZ_IMPORTED" : "FORM_SUBMISSION_IMPORTED", source: { id: source.id, google_spreadsheet_id: source.google_spreadsheet_id, source_type: source.source_type }, student: student ? { id: student.id, email: student.email, full_name: student.full_name } : null, enrollment: enrollment ? { id: enrollment.id, teacher_id: enrollment.teacher_id, level: enrollment.level } : null, import_event: importEvent, submissions, quiz, queued_email: queuedEmail, queued_import_notification_emails: queuedImportNotificationEmails, immediate_email_delivery: immediateEmailDelivery, audio_asset: audioAsset, jobs, checked_at: nowIso_() };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

export async function getImportPipelineSummary({ limit = 50 } = {}) {
  return withSupabaseClient(async (client) => {
    const tables = ["students","teachers","enrollments","task_catalog","google_response_sources","submission_import_events","submission_inbox","quiz_scores","audio_assets","ai_drafts"];
    const counts = [];
    for (const table of tables) {
      const exists = await client.query(`select to_regclass($1) as table_name`, [`public.${table}`]);
      if (!exists.rows[0]?.table_name) { counts.push({ table_name: table, exists: false, row_count: null }); continue; }
      const count = await client.query(`select count(*)::integer as row_count from ${table}`);
      counts.push({ table_name: table, exists: true, row_count: count.rows[0].row_count });
    }
    const recent = await client.query(`select id, source_identity_key, respondent_email, import_status, created_at from submission_import_events order by created_at desc limit $1`, [normalizeLimit_(limit, 25, 200)]).catch(() => ({ rows: [] }));
    return { ok: true, status: "IMPORT_PIPELINE_SUMMARY", counts, recent_import_events: recent.rows, checked_at: nowIso_() };
  });
}

async function loadActiveSources_(client, options = {}) {
  const params = [];
  const filters = [`active is true`, `upper(coalesce(status,'ACTIVE')) not in ('INACTIVE','ARCHIVED','DISABLED')`];
  if (options.spreadsheetId || options.spreadsheet_id) {
    params.push(clean_(options.spreadsheetId || options.spreadsheet_id));
    filters.push(`google_spreadsheet_id=$${params.length}`);
  }
  if (options.sourceType || options.source_type) {
    params.push(upper_(options.sourceType || options.source_type));
    filters.push(`upper(coalesce(source_type,'')) = $${params.length}`);
  }
  // Important: this limits database sources, not tabs inside each spreadsheet.
  // Do not reuse max_tabs here; max_tabs is handled in reconcileSourceForms().
  params.push(normalizeLimit_(options.sourceLimit || options.source_limit || options.limit, 50, 500));
  const result = await client.query(`select * from google_response_sources where ${filters.join(" and ")} order by created_at asc limit $${params.length}`, params);
  return result.rows;
}

function parseSheetTabKey_(sheetName = "") {
  const clean = clean_(sheetName);
  const match = /^(?:Quiz_)?([A-C][0-9])_M(\d+)_U(\d+)_D(\d+)$/i.exec(clean);
  if (!match) return null;
  return {
    level: upper_(match[1]),
    module: Number(match[2]),
    unit: Number(match[3]),
    day: Number(match[4]),
    is_quiz: /^Quiz_/i.test(clean)
  };
}

function sourceLevelModuleFromName_(source = {}) {
  const text = `${source.spreadsheet_name || ""} ${source.notes || ""}`;
  const levelMatch = /\b([A-C][0-9])\b/i.exec(text);
  const moduleMatch = /module\s*(\d+)|\bM(\d+)\b/i.exec(text);
  return {
    level: upper_(source.level || (levelMatch ? levelMatch[1] : "")),
    module: intOrNull_(source.module || (moduleMatch ? (moduleMatch[1] || moduleMatch[2]) : null))
  };
}

function isTechnicalTab_(title = "") {
  return /^_/i.test(clean_(title)) || /linking log|speakpipe log|log$/i.test(clean_(title));
}

function tabMatchesSource_(source = {}, tabTitle = "") {
  const title = clean_(tabTitle);
  if (!title || isTechnicalTab_(title)) return false;

  const tabKey = parseSheetTabKey_(title);
  if (!tabKey) return false;

  const sourceType = upper_(source.source_type || "");
  if (sourceType === "QUIZ" && !tabKey.is_quiz) return false;
  if (sourceType === "ASSIGNMENT" && tabKey.is_quiz) return false;

  const sourceKey = sourceLevelModuleFromName_(source);
  if (sourceKey.level && tabKey.level !== sourceKey.level) return false;
  if (sourceKey.module && tabKey.module !== sourceKey.module) return false;

  return true;
}

function candidateTabsForSource_(source = {}, tabs = [], maxTabs = 500) {
  const titles = (tabs || []).map((tab) => clean_(tab.title)).filter(Boolean);
  const configuredTab = clean_(source.sheet_name);

  // Use the configured tab only when it really exists AND it is not a generic
  // placeholder. Production source rows can be spreadsheet-level rows with
  // sheet_name="Form Responses 1" even when the real workbook tabs are named
  // A1_M1_U1_D1, Quiz_A1_M1_U1_D7, etc.
  if (
    configuredTab &&
    titles.includes(configuredTab) &&
    !isGenericResponseTab_(configuredTab) &&
    tabMatchesSource_(source, configuredTab)
  ) {
    return [configuredTab];
  }

  return titles
    .filter((title) => tabMatchesSource_(source, title))
    .slice(0, maxTabs);
}

function isGenericResponseTab_(sheetName = "") {
  const lower = lower_(sheetName);
  return ["form responses 1", "sheet1", "feuille 1"].includes(lower);
}

async function ensureReconciliationCursorTable_(client) {
  await client.query(`
    create table if not exists public.google_response_reconciliation_cursor (
      google_spreadsheet_id text not null,
      sheet_name text not null,
      last_scanned_at timestamptz,
      last_seen_row_count integer,
      last_imported_count integer,
      last_error text,
      scan_count integer not null default 0,
      updated_at timestamptz not null default now(),
      primary key (google_spreadsheet_id, sheet_name)
    )
  `);
}

async function selectNextTabsForSource_(client, source = {}, candidateTabs = [], tabsPerRun = 4) {
  const spreadsheetId = clean_(source.google_spreadsheet_id);
  const tabNames = uniqueNonEmpty_(candidateTabs);

  if (!spreadsheetId || tabNames.length === 0) return [];

  await ensureReconciliationCursorTable_(client);

  for (const tabName of tabNames) {
    await client.query(`
      insert into public.google_response_reconciliation_cursor (
        google_spreadsheet_id,
        sheet_name,
        updated_at
      )
      values ($1, $2, now())
      on conflict (google_spreadsheet_id, sheet_name)
      do nothing
    `, [spreadsheetId, tabName]);
  }

  const result = await client.query(`
    select sheet_name
    from public.google_response_reconciliation_cursor
    where google_spreadsheet_id = $1
      and sheet_name = any($2::text[])
    order by
      last_scanned_at asc nulls first,
      updated_at asc nulls first,
      sheet_name asc
    limit $3
  `, [spreadsheetId, tabNames, normalizeLimit_(tabsPerRun, 4, 500)]);

  return result.rows.map((row) => row.sheet_name).filter(Boolean);
}

async function updateReconciliationCursor_(client, source = {}, tabName = "", details = {}) {
  const spreadsheetId = clean_(source.google_spreadsheet_id);
  const sheetName = clean_(tabName);

  if (!spreadsheetId || !sheetName) return null;

  await ensureReconciliationCursorTable_(client);

  const result = await client.query(`
    insert into public.google_response_reconciliation_cursor (
      google_spreadsheet_id,
      sheet_name,
      last_scanned_at,
      last_seen_row_count,
      last_imported_count,
      last_error,
      scan_count,
      updated_at
    )
    values ($1, $2, now(), $3, $4, $5, 1, now())
    on conflict (google_spreadsheet_id, sheet_name)
    do update set
      last_scanned_at = excluded.last_scanned_at,
      last_seen_row_count = excluded.last_seen_row_count,
      last_imported_count = excluded.last_imported_count,
      last_error = excluded.last_error,
      scan_count = public.google_response_reconciliation_cursor.scan_count + 1,
      updated_at = now()
    returning *
  `, [
    spreadsheetId,
    sheetName,
    intOrNull_(details.rowCount) ?? 0,
    intOrNull_(details.importedCount) ?? 0,
    details.error ? clean_(details.error).slice(0, 2000) : null
  ]);

  return result.rows[0] || null;
}


function rowPayloadFromSheet_(source, tabName, row) {
  return {
    event_type: "GOOGLE_SHEETS_RECONCILIATION_ROW",
    spreadsheet: {
      id: source.google_spreadsheet_id,
      name: source.spreadsheet_name || "",
      timezone: source.source_timezone || source.timezone || process.env.DEFAULT_SOURCE_TIMEZONE || process.env.SCHEDULER_TIMEZONE || process.env.TZ || "Africa/Douala"
    },
    sheet: { name: tabName, row_number: row.row_number },
    source: { platform: "GOOGLE_FORMS", transport: "RECONCILIATION", source_type: source.source_type },
    raw_named_values: row.named_values,
    raw_values: row.raw_values
  };
}

export async function reconcileSourceForms(options = {}) {
  const dryRun = truthy_(options.dryRun ?? options.dry_run);
  const maxRows = normalizeLimit_(options.maxRowsPerTab || options.max_rows_per_tab, 200, 2000);
  const tabsPerRun = normalizeLimit_(
    options.tabsPerRun ||
    options.tabs_per_run ||
    options.reconcileTabsPerRun ||
    options.reconcile_tabs_per_run ||
    options.maxTabs ||
    options.max_tabs,
    4,
    500
  );
  const maxCandidateTabs = normalizeLimit_(options.maxCandidateTabs || options.max_candidate_tabs, 500, 1000);
  const maxImports = normalizeLimit_(options.maxImports || options.max_imports, 100, 1000);
  const output = [];
  let importedCount = 0;
  let scannedTabCount = 0;
  let scannedRowCount = 0;
  let retriedExistingFailedCount = 0;
  const sources = await withSupabaseClient((client) => loadActiveSources_(client, options));

  for (const source of sources) {
    if (importedCount >= maxImports) break;

    let tabs = [];
    let allCandidateTabs = [];
    let selectedTabs = [];
    const sourceOutput = {
      source_id: source.id,
      google_spreadsheet_id: source.google_spreadsheet_id,
      spreadsheet_name: source.spreadsheet_name || "",
      configured_sheet_name: source.sheet_name || "",
      cursor_enabled: true,
      tabs_per_run: tabsPerRun,
      candidate_tab_count: 0,
      candidate_tabs_sample: [],
      selected_tab_count: 0,
      selected_tabs: [],
      scanned_tabs: [],
      imported: [],
      skipped_ineligible: [],
      skipped_success_existing: [],
      retried_existing_failed: [],
      failed: []
    };

    try {
      tabs = await getSpreadsheetTabs({ spreadsheetId: source.google_spreadsheet_id });
      allCandidateTabs = candidateTabsForSource_(source, tabs, maxCandidateTabs);
      sourceOutput.candidate_tab_count = allCandidateTabs.length;
      sourceOutput.candidate_tabs_sample = allCandidateTabs.slice(0, 40);

      if (allCandidateTabs.length > 0) {
        selectedTabs = await withSupabaseClient((client) => selectNextTabsForSource_(client, source, allCandidateTabs, tabsPerRun));
      }

      sourceOutput.selected_tab_count = selectedTabs.length;
      sourceOutput.selected_tabs = selectedTabs;
    } catch (error) {
      sourceOutput.failed.push({ error: error.message || String(error) });
      output.push(sourceOutput);
      continue;
    }

    if (allCandidateTabs.length === 0) {
      sourceOutput.failed.push({
        error: `No matching response tabs found. Configured sheet_name=${source.sheet_name || ""}. The worker now ignores generic placeholders and discovers real tabs dynamically.`
      });
      output.push(sourceOutput);
      continue;
    }

    if (selectedTabs.length === 0) {
      sourceOutput.failed.push({ error: "No tabs selected by reconciliation cursor." });
      output.push(sourceOutput);
      continue;
    }

    for (const tabName of selectedTabs) {
      if (importedCount >= maxImports) break;

      let rows = [];
      let importedFromTab = 0;
      let tabError = null;

      try {
        const values = await getSpreadsheetValues({
          spreadsheetId: source.google_spreadsheet_id,
          sheetName: tabName,
          range: `A1:ZZ${maxRows + 1}`
        });
        rows = rowsToObjects(values.values).slice(0, maxRows);
        scannedTabCount += 1;
        scannedRowCount += rows.length;
        sourceOutput.scanned_tabs.push({ sheet_name: tabName, row_count: rows.length });
      } catch (error) {
        tabError = error.message || String(error);
        sourceOutput.failed.push({ sheet_name: tabName, error: tabError });
        await withSupabaseClient((client) => updateReconciliationCursor_(client, source, tabName, {
          rowCount: 0,
          importedCount: 0,
          error: tabError
        }));
        continue;
      }

      for (const row of rows) {
        if (importedCount >= maxImports) break;
        const payload = rowPayloadFromSheet_(source, tabName, row);
        const identity = sourceIdentityKey_(payload, payloadSpreadsheet_(payload));
        const existing = await withSupabaseClient(async (client) => {
          const res = await client.query(
            `select id, import_status from submission_import_events where source_identity_key=$1 limit 1`,
            [identity]
          );
          return res.rows[0] || null;
        });

        if (existing && importStatusIsSuccessful_(existing.import_status)) {
          sourceOutput.skipped_success_existing.push({
            source_identity_key: identity,
            import_event_id: existing.id,
            import_status: existing.import_status
          });
          continue;
        }

        if (existing) {
          retriedExistingFailedCount += 1;
          sourceOutput.retried_existing_failed.push({
            source_identity_key: identity,
            import_event_id: existing.id,
            previous_import_status: existing.import_status || ""
          });
        }

        if (dryRun) {
          sourceOutput.imported.push({
            dry_run: true,
            source_identity_key: identity,
            sheet_name: tabName,
            source_row: row.row_number,
            retrying_existing_failed_event: Boolean(existing)
          });
          importedCount += 1;
          importedFromTab += 1;
          continue;
        }

        try {
          const result = await importFormSubmissionEvent(payload);
          if (result?.status === "FORM_SUBMISSION_SKIPPED_INELIGIBLE") {
            sourceOutput.skipped_ineligible.push({ source_identity_key: identity, result });
          } else {
            sourceOutput.imported.push({ source_identity_key: identity, result });
            importedCount += 1;
            importedFromTab += 1;
          }
        } catch (error) {
          sourceOutput.failed.push({
            source_identity_key: identity,
            sheet_name: tabName,
            source_row: row.row_number,
            error: error.message || String(error)
          });
        }
      }

      await withSupabaseClient((client) => updateReconciliationCursor_(client, source, tabName, {
        rowCount: rows.length,
        importedCount: importedFromTab,
        error: tabError
      }));
    }

    output.push(sourceOutput);
  }

  return {
    ok: output.every((item) => item.failed.length === 0),
    status: dryRun ? "RECONCILIATION_DRY_RUN" : "RECONCILIATION_FINISHED",
    source_count: sources.length,
    tabs_per_run: tabsPerRun,
    scanned_tab_count: scannedTabCount,
    scanned_row_count: scannedRowCount,
    imported_count: importedCount,
    retried_existing_failed_count: retriedExistingFailedCount,
    sources: output,
    checked_at: nowIso_()
  };
}

export async function createMissingCorrectionJobsForSubmissions({ limit = 25 } = {}) {
  return withSupabaseClient(async (client) => {
    const result = await client.query(`
      select si.*
      from submission_inbox si
      where (
        (
          coalesce(si.status, '') <> 'BAD_WRITING_SUBMISSION'
          and (nullif(trim(coalesce(si.writing_answer, '')), '') is not null)
          and not exists (
            select 1 from ai_drafts d
            where d.submission_id = si.id
              and d.job_type = 'WRITING_CORRECTION'
          )
        )
        or
        (
          (nullif(trim(coalesce(si.speaking_choice_text, '')), '') is not null
            or nullif(trim(coalesce(si.speakpipe_link, '')), '') is not null
            or nullif(trim(coalesce(si.audio_link, '')), '') is not null
            or nullif(trim(coalesce(si.speaking_task_instruction, '')), '') is not null)
          and not exists (
            select 1 from ai_drafts d
            where d.submission_id = si.id
              and d.job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')
          )
        )
      )
      order by si.created_at asc
      limit $1`,
      [normalizeLimit_(limit, 25, 500)]
    );

    const created = [];
    for (const submission of result.rows) {
      const writingTask = await findTaskForExistingSubmission_(client, submission, "WRITING");
      const speakingTask = await findTaskForExistingSubmission_(client, submission, "SPEAKING");
      created.push(...await createMissingJobsForAssignmentSubmission_(client, {
        submission,
        writingTask,
        speakingTask,
        writingInfo: classifyWritingAnswer(submission.writing_answer || submission.answer_text || ""),
        linkInfo: clean_(submission.audio_link || submission.speakpipe_link) ? classifySpeakPipeLink(submission.audio_link || submission.speakpipe_link) : null
      }));
    }

    return {
      ok: true,
      status: "MISSING_CORRECTION_JOBS_CREATED",
      created_count: created.filter((row) => row.created).length,
      inspected_count: result.rows.length,
      created,
      checked_at: nowIso_()
    };
  });
}
