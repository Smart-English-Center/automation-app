import { downloadOriginalAudioForProcessing } from "../utils/audioProcessing.js";
import { transcribeAudioWithOpenAi, getSpeakingAudioModels } from "../clients/openaiAudio.js";
import { generateJeaSpeakingCorrectionWithAudioThenStructuredReview } from "../clients/openaiStructuredSpeaking.js";
import { getDeepSeekReviewConfig, requireReviewApiKey } from "../review/reviewProviderConfig.js";
import { getGoogleDriveFileMetadata } from "../google/driveClient.js";
import { withSupabaseClient } from "./client.js";
import { findDeliveredWritingCorrection } from "./finalFeedbackRepository.js";

const WRITING_JOB_TYPE = "WRITING_CORRECTION";
const SPEAKING_JOB_TYPES = ["SPEAKING_EVALUATION", "SPEAKING_CORRECTION"];
const READY_FOR_REVIEW = "READY_FOR_REVIEW";
const NOT_READY = "NOT_READY";
const PARTIAL_FEEDBACK = "PARTIAL_FEEDBACK";
const SPEAKING_RETRYABLE_QUEUE_STATUSES = Object.freeze([
  "FAILED_RETRYABLE",
  "CORRECTION_FAILED_RETRYABLE",
  "TRANSCRIPTION_FAILED_RETRYABLE"
]);

function nowIso_() {
  return new Date().toISOString();
}

function clean_(value) {
  return String(value ?? "").trim();
}

function upper_(value) {
  return clean_(value).toUpperCase();
}

function numberOrNull_(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampScore_(value) {
  const parsed = numberOrNull_(value);
  if (parsed === null) return null;
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function isPermanentSpeakingNotAssessedError_(message) {
  const text = clean_(message).toLowerCase();
  if (!text) return false;

  // Do not convert provider/network incidents into Not assessed.
  // Those must remain retryable because the student's link/audio may be valid.
  if (
    text.includes("http 503") ||
    text.includes("http 502") ||
    text.includes("http 504") ||
    text.includes("upstream connect error") ||
    text.includes("connection termination") ||
    text.includes("econnreset") ||
    text.includes("etimedout") ||
    text.includes("timeout") ||
    text.includes("rate limit") ||
    text.includes("temporarily unavailable") ||
    text.includes("service unavailable")
  ) {
    return false;
  }

  return (
    text.includes("no audio link/source url") ||
    text.includes("sourceurl is required") ||
    text.includes("source url is required") ||
    text.includes("missing_source_url") ||
    text.includes("unsupported audio source") ||
    text.includes("unsupported_audio_source") ||
    text.includes("invalid audio") ||
    text.includes("invalid speakpipe") ||
    text.includes("not a valid speakpipe") ||
    text.includes("no audio buffer returned") ||
    text.includes("empty audio") ||
    text.includes("empty converted wav") ||
    text.includes("converted file does not look like") ||
    text.includes("does not look like a valid") ||
    text.includes("could not resolve speakpipe") ||
    text.includes("could not find speakpipe") ||
    text.includes("audio file is inaccessible") ||
    text.includes("inaccessible") ||
    text.includes("forbidden") ||
    text.includes("not found") ||
    text.includes("http 400") ||
    text.includes("http 401") ||
    text.includes("http 403") ||
    text.includes("http 404") ||
    text.includes("http 410") ||
    text.includes("unsupported media") ||
    text.includes("unprocessable")
  );
}

function notAssessedReasonFromError_(message) {
  const text = clean_(message);
  if (!text) {
    return "The speaking task could not be assessed because the audio/link was invalid, inaccessible, or unprocessable.";
  }

  if (/no audio link|missing_source_url|sourceurl is required|source url is required/i.test(text)) {
    return "The speaking task could not be assessed because no valid audio link was submitted.";
  }

  if (/unsupported/i.test(text)) {
    return "The speaking task could not be assessed because the submitted audio link format is not supported.";
  }

  if (/404|410|not found/i.test(text)) {
    return "The speaking task could not be assessed because the submitted audio link could not be found.";
  }

  if (/401|403|forbidden|inaccessible/i.test(text)) {
    return "The speaking task could not be assessed because the submitted audio link was inaccessible.";
  }

  if (/empty|no audio buffer|does not look like|invalid|unprocessable/i.test(text)) {
    return "The speaking task could not be assessed because the submitted audio could not be processed.";
  }

  return "The speaking task could not be assessed because the audio/link was invalid, inaccessible, or unprocessable.";
}

async function saveSpeakingNotAssessed_(client, draft, { message, provider = "system", model = "not-assessed-handler", stage = "SPEAKING_AUDIO" } = {}) {
  const reason = notAssessedReasonFromError_(message);
  const rawJson = {
    ...(safeJsonParse_(draft.raw_json, {})),
    speaking_not_assessed_at: nowIso_(),
    speaking_not_assessed_stage: stage,
    speaking_not_assessed_reason: reason,
    speaking_not_assessed_error: clean_(message).slice(0, 2000)
  };

  const result = await client.query(`
    update ai_drafts
    set
      status = 'NOT_ASSESSED',
      review_status = $2,
      score = null,
      reviewed_score = null,
      student_draft_feedback = null,
      reviewed_student_feedback = '',
      teacher_draft_feedback = null,
      teacher_email_body = null,
      review_note = $3,
      reviewed_at = coalesce(reviewed_at, now()),
      review_provider = coalesce(review_provider, $4),
      review_model = coalesce(review_model, $5),
      teacher_review_reason = null,
      raw_json = $6::jsonb,
      ai_provider = $4,
      ai_model = $5,
      updated_at = now()
    where id = $1
    returning *
  `, [
    draft.id,
    PARTIAL_FEEDBACK,
    reason,
    provider,
    model,
    JSON.stringify(rawJson)
  ]);

  return result.rows[0] || null;
}

function normaliseLimit_(value, fallback = 1, max = 25) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function getWritingModel_() {
  return clean_(process.env.DEEPSEEK_WRITING_MODEL) ||
    clean_(process.env.DEEPSEEK_REVIEW_MODEL) ||
    clean_(process.env.DEEPSEEK_MODEL) ||
    getDeepSeekReviewConfig().model ||
    "deepseek-v4-pro";
}

// Routed through OpenRouter (see src/clients/openaiAudio.js) — model slugs
// need the "openai/" provider prefix.
function getSpeakingAudioModel_() {
  return getSpeakingAudioModels().model;
}

function getTranscriptionModel_() {
  return clean_(process.env.OPENAI_TRANSCRIPTION_MODEL) || "openai/gpt-4o-transcribe";
}

function feedbackLanguageFor_(level, moduleNo) {
  const levelUpper = upper_(level);
  const moduleNumber = Number(moduleNo);
  if (levelUpper === "A1") return "fr";
  if (levelUpper === "A2") return "simple_en";
  return "en";
}

function safeJsonParse_(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function grammarContextFromDraft_(draft) {
  const previous = draft.previous_grammar;
  return {
    lesson_key: draft.grammar_lesson_key || "",
    current_lesson_grammar: draft.current_lesson_grammar || "",
    previous_grammar_summary: draft.previous_grammar_summary || "",
    previous_grammar: Array.isArray(previous) ? previous : safeJsonParse_(previous, []),
    previous_grammar_count: numberOrNull_(draft.previous_grammar_count) || 0
  };
}

function grammarContextLateralSql_() {
  return `
    left join lateral (
      select
        gc.lesson_key as grammar_lesson_key,
        gc.current_lesson_grammar,
        (
          select string_agg(p.current_lesson_grammar, ' | ' order by p.lesson_order desc nulls last)
          from (
            select pgc.current_lesson_grammar, pgc.lesson_order
            from grammar_context pgc
            where coalesce(pgc.active, true) = true
              and upper(coalesce(pgc.level::text,'')) = upper(coalesce(si.level::text,''))
              and pgc.lesson_order < gc.lesson_order
              and coalesce(trim(pgc.current_lesson_grammar), '') <> ''
            order by pgc.lesson_order desc nulls last
            limit 20
          ) p
        ) as previous_grammar_summary,
        (
          select coalesce(
            jsonb_agg(
              jsonb_build_object(
                'lesson_key', p.lesson_key,
                'grammar', p.current_lesson_grammar
              ) order by p.lesson_order desc nulls last
            ),
            '[]'::jsonb
          )
          from (
            select pgc.lesson_key, pgc.current_lesson_grammar, pgc.lesson_order
            from grammar_context pgc
            where coalesce(pgc.active, true) = true
              and upper(coalesce(pgc.level::text,'')) = upper(coalesce(si.level::text,''))
              and pgc.lesson_order < gc.lesson_order
              and coalesce(trim(pgc.current_lesson_grammar), '') <> ''
            order by pgc.lesson_order desc nulls last
            limit 20
          ) p
        ) as previous_grammar,
        (
          select count(*)::integer
          from grammar_context pgc
          where coalesce(pgc.active, true) = true
            and upper(coalesce(pgc.level::text,'')) = upper(coalesce(si.level::text,''))
            and pgc.lesson_order < gc.lesson_order
            and coalesce(trim(pgc.current_lesson_grammar), '') <> ''
        ) as previous_grammar_count
      from grammar_context gc
      where coalesce(gc.active, true) = true
        and upper(coalesce(gc.level::text,'')) = upper(coalesce(si.level::text,''))
        and regexp_replace(coalesce(gc.module::text,''), '[^0-9]', '', 'g') = regexp_replace(coalesce(si.module::text,''), '[^0-9]', '', 'g')
        and regexp_replace(coalesce(gc.unit::text,''), '[^0-9]', '', 'g') = regexp_replace(coalesce(si.unit::text,''), '[^0-9]', '', 'g')
        and regexp_replace(coalesce(gc.day::text,''), '[^0-9]', '', 'g') = regexp_replace(coalesce(si.day::text,''), '[^0-9]', '', 'g')
      order by gc.lesson_order desc nulls last, gc.updated_at desc nulls last
      limit 1
    ) gc on true
  `;
}

function parseJsonFromModelOutput_(text) {
  const raw = clean_(text);
  if (!raw) throw new Error("Model returned empty output.");

  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (firstError) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (secondError) {
        throw new Error(`Could not parse JSON object from model output. ${secondError.message}. Output preview: ${cleaned.slice(0, 1200)}`);
      }
    }
    throw new Error(`Model output was not valid JSON. ${firstError.message}. Output preview: ${cleaned.slice(0, 1200)}`);
  }
}

function buildWritingSystemPrompt_({ feedbackLanguage }) {
  const feedbackLanguageLabel = feedbackLanguage === "fr"
    ? "Write student-facing feedback in French. The model answer must stay in English."
    : feedbackLanguage === "simple_en"
      ? "Write student-facing feedback in simple English. The model answer must stay in English."
      : "Write student-facing feedback in English. The model answer must stay in English.";

  return "You are the writing correction assistant for John's English Academy.\n\nReturn one valid JSON object only.\n\nYou correct student writing submissions.\n\nCORE SOURCE RULES:\n1. Use the exact writing prompt as the task requirement.\n2. Use the exact student writing answer as the source of truth.\n3. Use the grammar context to limit what you penalise.\n4. Do not invent facts, missing elements, errors, or task requirements.\n\nFEEDBACK FORMAT:\nWrite the student-facing feedback in clean Markdown.\nUse:\n- Markdown headings for sections,\n- bullet points for correction details,\n- **bold** for corrected forms, important grammar rules, vocabulary changes, and key advice,\n- `inline code` for the student's original incorrect phrase,\n- Markdown tables for the score breakdown.\n\nHALLUCINATION PREVENTION RULES:\n1. Before saying the student forgot something, check the exact student answer.\n2. Do not say something is missing if it appears in the answer or is clearly expressed with equivalent wording.\n3. If a required element is present but incorrect, say it is present but needs correction.\n4. Before correcting a student phrase, quote the exact phrase from the student answer.\n5. If you cannot quote the exact phrase, do not claim the student made that error.\n6. Do not claim that punctuation is missing unless it is visibly missing in the exact answer.\n7. Do not claim that a capital letter is missing unless it is visibly missing in the exact answer.\n8. Do not say the student wrote a certain number of sentences unless the answer visibly supports that count.\n9. Do not invent stricter requirements than the prompt gives.\n10. The model answer must not repeat any error you criticised.\n\nRUBRIC DEFINITIONS:\n- Task achievement: Did the student answer the prompt fully and follow the required content?\n- Grammar: sentence rules, verb forms, tense, subject-verb agreement, articles, prepositions, question forms, negatives, word order.\n- Vocabulary: word choice, range, meaning accuracy, taught words, prompt words, natural expressions, collocations.\n- Organisation and coherence: complete sentence control, order of ideas, logical sequence, paragraph/message flow.\n- Spelling and punctuation: spelling, capitalisation, full stops, commas, apostrophes, written mechanics.\n- Clarity and naturalness: how easy and natural the message is to understand, without over-penalising beginner-level simplicity.\n\nPENALTY LIMIT:\n- Penalise grammar and vocabulary only if the issue is connected to current lesson grammar, previous lesson grammar, current lesson vocabulary, previous lesson vocabulary, or language explicitly required by the prompt.\n- Do not heavily penalise language the student has not studied yet.\n- A missing task element affects Task Achievement only, unless it also creates a real grammar, vocabulary, organisation, spelling, or clarity problem.\n\nFEEDBACK LANGUAGE:\n${feedbackLanguageLabel}\n\nMODEL ANSWER LANGUAGE:\nThe model answer must always be in English.\n\nRequired formatted_feedback Markdown structure:\n# Writing Feedback\n\n## Score\n[score]/100\n\n## Good point\n[One specific praise sentence. Use the student's name only once here.]\n\n## Corrections\n[Use one or more correction blocks.]\n\n### Correction 1\n- Original: `exact student phrase`\n- Corrected: **corrected phrase**\n- Type: Grammar / Vocabulary / Spelling and punctuation / Organisation / Clarity and naturalness / Task achievement\n- Rule: **clear rule or explanation**\n- Example: short natural example if useful\n\n## Model answer\n[Corrected natural model answer in English.]\n\n## Score breakdown\n| Criterion | Score | Comment |\n|---|---:|---|\n| Task achievement | [score]/20 | [short comment] |\n| Grammar | [score]/25 | [short comment] |\n| Vocabulary | [score]/20 | [short comment] |\n| Organisation and coherence | [score]/15 | [short comment] |\n| Spelling and punctuation | [score]/10 | [short comment] |\n| Clarity and naturalness | [score]/10 | [short comment] |\n\n## Final advice\n[One practical next step.]\n\nImportant storage rule:\n- formatted_feedback must contain the full student-facing correction with all required Markdown sections and score breakdown.\n- student_draft_feedback must be identical to formatted_feedback.\n- teacher_draft_feedback can be shorter and teacher-facing.\n\nJSON keys required:\n{\n  \"score\": number,\n  \"task_achievement_score\": number,\n  \"grammar_score\": number,\n  \"vocabulary_score\": number,\n  \"organisation_score\": number,\n  \"spelling_punctuation_score\": number,\n  \"clarity_naturalness_score\": number,\n  \"formatted_feedback\": string,\n  \"student_draft_feedback\": string,\n  \"teacher_draft_feedback\": string,\n  \"teacher_email_subject\": string,\n  \"teacher_email_body\": string,\n  \"evidence_check\": {\n    \"exact_student_phrases_corrected\": array,\n    \"missing_elements_claimed\": array,\n    \"punctuation_claims\": array,\n    \"uncertainty_notes\": string\n  },\n  \"teacher_notes_internal\": {\n    \"task_achievement\": string,\n    \"grammar\": string,\n    \"vocabulary\": string,\n    \"organisation\": string,\n    \"spelling_punctuation\": string,\n    \"clarity_naturalness\": string,\n    \"penalty_limit_applied\": string,\n    \"uncertainties\": string\n  }\n}\n\nScoring:\n- task_achievement_score: 0 to 20\n- grammar_score: 0 to 25\n- vocabulary_score: 0 to 20\n- organisation_score: 0 to 15\n- spelling_punctuation_score: 0 to 10\n- clarity_naturalness_score: 0 to 10\n- score = sum of those six scores"
    .replace(
      "Important storage rule:\n- formatted_feedback must contain the full student-facing correction with all required Markdown sections and score breakdown.\n- student_draft_feedback must be identical to formatted_feedback.\n- teacher_draft_feedback can be shorter and teacher-facing.",
      "Important storage rule:\n- formatted_feedback must contain the full student-facing correction with all required Markdown sections and score breakdown."
    )
    .replace('\n  "student_draft_feedback": string,', "")
    .replace('\n  "teacher_draft_feedback": string,', "")
    .replace('\n  "teacher_email_body": string,', "")
    .replace(
      "\n\nFEEDBACK LANGUAGE:",
      "\n- If the student achieves the core task but goes slightly over the word limit or adds extra relevant details, deduct no more than 2 points out of 20 in total, and deduct those points from Task Achievement only.\n- On those facts alone, Task Achievement must remain at least 18/20.\n- Do not deduct points from Grammar, Vocabulary, Organisation and coherence, Spelling and punctuation, or Clarity and naturalness merely because the response is slightly too long or contains extra relevant information.\n- The presence or length of extra information is not itself a grammar, vocabulary, organisation, spelling, punctuation, or clarity error. Assess an independent language error inside an extra sentence only under the criterion that the error actually belongs to.\n\nFEEDBACK LANGUAGE:"
    )
    .replace("${feedbackLanguageLabel}", feedbackLanguageLabel)
    .trim();
}

export function buildWritingCorrectionSystemPrompt(options = {}) {
  return buildWritingSystemPrompt_({
    feedbackLanguage: clean_(options.feedbackLanguage || options.feedback_language || "en")
  });
}

export function buildWritingCorrectionPayload(draft = {}) {
  const grammarContext = grammarContextFromDraft_(draft);

  return {
    review_scope: "WRITING_ONLY",
    student: {
      name: draft.student_name || "Student",
      email: draft.student_email || "",
      level: draft.level || "",
      module: draft.module || "",
      unit: draft.unit || "",
      day: draft.day || ""
    },
    task: {
      assignment_key: draft.assignment_key || "",
      choice_text: draft.writing_choice_text || draft.choice_text || "",
      instruction: draft.writing_task_instruction || draft.full_instruction || ""
    },
    learner_answer: draft.writing_answer || draft.answer_text || "",
    grammar_context: {
      lesson_key: grammarContext.lesson_key,
      current_lesson_grammar: grammarContext.current_lesson_grammar,
      previous_grammar_summary: grammarContext.previous_grammar_summary,
      previous_grammar_count: grammarContext.previous_grammar_count
    },
    existing_raw_json: safeJsonParse_(draft.raw_json, {})
  };
}

async function callDeepSeekWritingCorrection_({ draft }) {
  const config = getDeepSeekReviewConfig();
  const model = getWritingModel_();
  const feedbackLanguage = feedbackLanguageFor_(draft.level, draft.module);
  const apiKey = requireReviewApiKey("deepseek");

  const requestBody = {
    model,
    messages: [
      {
        role: "system",
        content: buildWritingSystemPrompt_({ feedbackLanguage })
      },
      {
        role: "user",
        content: JSON.stringify(buildWritingCorrectionPayload(draft))
      }
    ],
    response_format: { type: "json_object" },
    thinking: {
      type: config.thinkingMode,
      reasoning_effort: config.reasoningEffort
    },
    stream: false
  };

  const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    throw new Error(`DeepSeek writing correction failed. HTTP ${response.status}. Body: ${(body ? JSON.stringify(body) : text).slice(0, 1600)}`);
  }

  const content = clean_(body?.choices?.[0]?.message?.content || "");
  const parsed = parseJsonFromModelOutput_(content);

  return {
    provider: "deepseek",
    model_requested: model,
    model_returned: body?.model || "",
    parsed_json: normaliseWritingCorrection_(parsed),
    content,
    reasoning_content: body?.choices?.[0]?.message?.reasoning_content || "",
    usage: body?.usage || null,
    raw_response: body
  };
}

function normaliseWritingCorrection_(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const formattedFeedback = clean_(source.formatted_feedback);

  return {
    score: clampScore_(source.score),
    task_achievement_score: clampScore_(source.task_achievement_score),
    grammar_score: clampScore_(source.grammar_score),
    vocabulary_score: clampScore_(source.vocabulary_score),
    organisation_score: clampScore_(source.organisation_score),
    spelling_score: clampScore_(source.spelling_punctuation_score ?? source.spelling_score),
    spelling_punctuation_score: clampScore_(source.spelling_punctuation_score ?? source.spelling_score),
    clarity_naturalness_score: clampScore_(source.clarity_naturalness_score),

    formatted_feedback: formattedFeedback,
    student_draft_feedback: formattedFeedback,
    teacher_email_subject: clean_(source.teacher_email_subject),

    evidence_check: source.evidence_check && typeof source.evidence_check === "object"
      ? source.evidence_check
      : {
          exact_student_phrases_corrected: [],
          missing_elements_claimed: [],
          punctuation_claims: [],
          uncertainty_notes: ""
        },

    teacher_notes_internal: source.teacher_notes_internal && typeof source.teacher_notes_internal === "object"
      ? source.teacher_notes_internal
      : {
          task_achievement: "",
          grammar: "",
          vocabulary: "",
          organisation: "",
          spelling_punctuation: "",
          clarity_naturalness: "",
          penalty_limit_applied: "",
          uncertainties: ""
        }
  };
}

function buildFallbackWritingFeedback_(parsed) {
  return clean_(parsed.formatted_feedback || "");
}

async function claimWritingDraft_(client, options = {}) {
  const params = [];
  const where = [
    `d.job_type = 'WRITING_CORRECTION'`,
    `upper(d.status) = any(array['QUEUED','FAILED_RETRYABLE','CORRECTION_FAILED_RETRYABLE'])`,
    `upper(coalesce(d.review_status,'NOT_READY')) in ('NOT_READY','REVIEW_FAILED_RETRYABLE')`
  ];

  if (options.draftId || options.draft_id) {
    params.push(clean_(options.draftId || options.draft_id));
    where.push(`d.id = $${params.length}::uuid`);
  }

  if (options.studentEmail || options.student_email) {
    params.push(clean_(options.studentEmail || options.student_email).toLowerCase());
    where.push(`lower(s.email) = $${params.length}`);
  }

  const result = await client.query(`
    select
      d.*,
      si.assignment_key,
      si.module,
      si.unit,
      si.day,
      si.writing_answer,
      si.answer_text,
      si.writing_task_instruction,
      si.writing_choice_text,
      si.choice_text,
      s.full_name as student_name,
      s.email as student_email,
      t.full_name as teacher_name,
      tc.full_instruction,
      tc.task_code,
      tc.task_key,
      gc.grammar_lesson_key,
      gc.current_lesson_grammar,
      gc.previous_grammar_summary,
      gc.previous_grammar,
      gc.previous_grammar_count
    from ai_drafts d
    join submission_inbox si on si.id = d.submission_id
    left join students s on s.id = d.student_id
    left join teachers t on t.id = d.teacher_id
    left join task_catalog tc on tc.id = d.task_id
    ${grammarContextLateralSql_()}
    where ${where.join(" and ")}
    order by d.created_at nulls last, d.id
    limit 1
    for update of d skip locked
  `, params);

  const draft = result.rows[0] || null;
  if (!draft) return null;

  await client.query(`
    update ai_drafts
    set status = 'PROCESSING', ai_provider = 'deepseek', ai_model = $2, updated_at = now()
    where id = $1
  `, [draft.id, getWritingModel_()]);

  return draft;
}

async function saveWritingSuccess_(client, draft, correction) {
  const parsed = correction.parsed_json;
  const studentFeedback = parsed.formatted_feedback || buildFallbackWritingFeedback_(parsed);

  const rawJson = {
    ...(safeJsonParse_(draft.raw_json, {})),
    correction_provider: correction.provider,
    correction_model_requested: correction.model_requested,
    correction_model_returned: correction.model_returned,
    correction_usage: correction.usage || null,
    correction: parsed,
    evidence_check: parsed.evidence_check || null,
    teacher_notes_internal: parsed.teacher_notes_internal || null,
    corrected_at: nowIso_()
  };

  const result = await client.query(`
    update ai_drafts
    set
      status = 'COMPLETED',
      review_status = $2,
      score = $3,
      task_achievement_score = $4,
      grammar_score = $5,
      vocabulary_score = $6,
      organisation_score = $7,
      spelling_score = $8,
      clarity_naturalness_score = $9,
      teacher_draft_feedback = null,
      student_draft_feedback = $10,
      teacher_email_subject = $11,
      teacher_email_body = null,
      raw_json = $12::jsonb,
      ai_provider = 'deepseek',
      ai_model = $13,
      updated_at = now()
    where id = $1
    returning *
  `, [
    draft.id,
    READY_FOR_REVIEW,
    parsed.score,
    parsed.task_achievement_score,
    parsed.grammar_score,
    parsed.vocabulary_score,
    parsed.organisation_score,
    parsed.spelling_score,
    parsed.clarity_naturalness_score,
    studentFeedback,
    parsed.teacher_email_subject || `Writing correction for ${draft.student_name || "student"}`,
    JSON.stringify(rawJson),
    correction.model_returned || correction.model_requested
  ]);

  return result.rows[0];
}

async function saveDraftFailure_(client, draftId, { status = "FAILED_RETRYABLE", reviewStatus = NOT_READY, provider = "", model = "", message, stage, raw = null }) {
  const result = await client.query(`
    update ai_drafts
    set
      status = $2,
      review_status = $3,
      ai_provider = coalesce(nullif($4,''), ai_provider),
      ai_model = coalesce(nullif($5,''), ai_model),
      review_note = $6,
      raw_json = coalesce(raw_json, '{}'::jsonb) || $7::jsonb,
      updated_at = now()
    where id = $1
    returning *
  `, [
    draftId,
    status,
    reviewStatus,
    provider,
    model,
    clean_(message).slice(0, 2000),
    JSON.stringify({
      last_correction_error: {
        stage,
        message: clean_(message),
        at: nowIso_(),
        raw
      }
    })
  ]);

  return result.rows[0] || null;
}

export async function getCorrectionSummary() {
  return withSupabaseClient(async (client) => {
    const drafts = await client.query(`
      select job_type, coalesce(status,'UNKNOWN') as status, coalesce(review_status,'UNKNOWN') as review_status, count(*)::integer as row_count
      from ai_drafts
      group by job_type, coalesce(status,'UNKNOWN'), coalesce(review_status,'UNKNOWN')
      order by job_type, status, review_status
    `);

    const audio = await client.query(`
      select coalesce(status,'UNKNOWN') as status, count(*)::integer as row_count
      from audio_assets
      group by coalesce(status,'UNKNOWN')
      order by status
    `);

    const transcripts = await client.query(`
      select coalesce(status,'UNKNOWN') as status, count(*)::integer as row_count
      from transcripts
      group by coalesce(status,'UNKNOWN')
      order by status
    `);

    const ready = await client.query(`
      select
        count(*) filter (where job_type='WRITING_CORRECTION' and upper(status) in ('QUEUED','FAILED_RETRYABLE','CORRECTION_FAILED_RETRYABLE'))::integer as writing_ready,
        count(*) filter (where job_type = any($1::text[]) and upper(status) in ('WAITING_FOR_AUDIO_STORAGE','QUEUED','TRANSCRIBED','FAILED_RETRYABLE','CORRECTION_FAILED_RETRYABLE','TRANSCRIPTION_FAILED_RETRYABLE'))::integer as speaking_ready,
        count(*) filter (where review_status='READY_FOR_REVIEW')::integer as ready_for_review
      from ai_drafts
    `, [SPEAKING_JOB_TYPES]);

    return {
      ok: true,
      status: "CORRECTION_SUMMARY",
      models: {
        deepseek_writing_correction_model: getWritingModel_(),
        deepseek_quality_review_model: getDeepSeekReviewConfig().model,
        openai_transcription_model: getTranscriptionModel_(),
        openai_speaking_audio_correction_model: getSpeakingAudioModel_(),
        speaking_correction_flow: "OpenAI audio model listens to the audio and produces the first speaking correction. DeepSeek review happens later in /worker/review/* routes."
      },
      draft_statuses: drafts.rows,
      audio_asset_statuses: audio.rows,
      transcript_statuses: transcripts.rows,
      ready_counts: ready.rows[0] || {},
      checked_at: nowIso_()
    };
  });
}

export async function processWritingCorrectionOne(options = {}) {
  let draft = null;

  await withSupabaseClient(async (client) => {
    await client.query("begin");
    try {
      draft = await claimWritingDraft_(client, options);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  if (!draft) {
    return { ok: true, status: "NO_WRITING_CORRECTION_READY", processed: null, checked_at: nowIso_() };
  }

  try {
    const correction = await callDeepSeekWritingCorrection_({ draft });
    const saved = await withSupabaseClient((client) => saveWritingSuccess_(client, draft, correction));

    return {
      ok: true,
      status: "WRITING_CORRECTION_COMPLETED",
      draft_id: draft.id,
      submission_id: draft.submission_id,
      student_email: draft.student_email,
      score: saved.score,
      review_status: saved.review_status,
      provider: "deepseek",
      model: saved.ai_model,
      checked_at: nowIso_()
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    const saved = await withSupabaseClient((client) => saveDraftFailure_(client, draft.id, {
      status: "FAILED_RETRYABLE",
      reviewStatus: NOT_READY,
      provider: "deepseek",
      model: getWritingModel_(),
      message,
      stage: "WRITING_CORRECTION"
    }));

    return {
      ok: false,
      status: "WRITING_CORRECTION_FAILED_RETRYABLE",
      draft_id: draft.id,
      submission_id: draft.submission_id,
      error: message,
      saved_status: saved?.status || null,
      checked_at: nowIso_()
    };
  }
}

async function claimSpeakingDraft_(client, options = {}) {
  const params = [SPEAKING_JOB_TYPES];
  const allowedStatuses = Array.isArray(options.allowedStatuses) && options.allowedStatuses.length
    ? options.allowedStatuses.map((item) => upper_(item)).filter(Boolean)
    : [
        "WAITING_FOR_AUDIO_STORAGE",
        "QUEUED",
        "TRANSCRIBED",
        "FAILED_RETRYABLE",
        "CORRECTION_FAILED_RETRYABLE",
        "TRANSCRIPTION_FAILED_RETRYABLE"
      ];

  params.push(allowedStatuses);

  const where = [
    `d.job_type = any($1::text[])`,
    `upper(d.status) = any($2::text[])`,
    `upper(coalesce(d.review_status,'NOT_READY')) in ('NOT_READY','REVIEW_FAILED_RETRYABLE')`,
    `not exists (
      select 1
      from final_feedback delivered
      where delivered.student_id = d.student_id
        and delivered.assignment_key = si.assignment_key
        and delivered.writing_draft_id is not null
        and upper(coalesce(delivered.writing_status, '')) = 'REVIEWED'
        and upper(coalesce(delivered.delivery_status, '')) in ('EMAIL_SENT', 'SENT')
    )`
  ];

  if (options.requireStoredAudio) {
    where.push(`nullif(trim(coalesce(aa.stored_drive_file_id::text, '')), '') is not null`);
  }

  if (options.requireCompletedTranscript) {
    where.push(`(
      nullif(trim(coalesce(d.transcript, '')), '') is not null
      or (upper(coalesce(tr.status, '')) = 'COMPLETED' and nullif(trim(coalesce(tr.transcript, '')), '') is not null)
    )`);
  }

  if (options.draftId || options.draft_id) {
    params.push(clean_(options.draftId || options.draft_id));
    where.push(`d.id = $${params.length}::uuid`);
  }

  if (options.studentEmail || options.student_email) {
    params.push(clean_(options.studentEmail || options.student_email).toLowerCase());
    where.push(`lower(s.email) = $${params.length}`);
  }

  const result = await client.query(`
    select
      d.*,
      si.assignment_key,
      si.module,
      si.unit,
      si.day,
      si.speaking_task_instruction,
      si.speaking_choice_text,
      si.choice_text,
      si.speakpipe_link,
      si.audio_link,
      s.full_name as student_name,
      s.email as student_email,
      t.full_name as teacher_name,
      tc.full_instruction,
      aa.id as audio_asset_id,
      aa.source_url as audio_source_url,
      aa.resolved_download_url,
      aa.stored_drive_url,
      aa.stored_drive_file_id,
      aa.mime_type as audio_mime_type,
      tr.id as existing_transcript_id,
      tr.transcript as existing_transcript,
      tr.status as existing_transcript_status,
      gc.grammar_lesson_key,
      gc.current_lesson_grammar,
      gc.previous_grammar_summary,
      gc.previous_grammar,
      gc.previous_grammar_count
    from ai_drafts d
    join submission_inbox si on si.id = d.submission_id
    left join students s on s.id = d.student_id
    left join teachers t on t.id = d.teacher_id
    left join task_catalog tc on tc.id = d.task_id
    ${grammarContextLateralSql_()}
    left join lateral (
      select * from audio_assets aa
      where aa.submission_id = d.submission_id
      order by
        case when nullif(trim(coalesce(aa.stored_drive_file_id::text, '')), '') is not null then 0 else 1 end,
        aa.created_at desc nulls last,
        aa.id
      limit 1
    ) aa on true
    left join lateral (
      select * from transcripts tr
      where tr.submission_id = d.submission_id
      order by tr.created_at desc nulls last, tr.id
      limit 1
    ) tr on true
    where ${where.join(" and ")}
    order by
      ${buildSpeakingDraftQueuePrioritySql()},
      d.created_at nulls last,
      d.id
    limit 1
    for update of d skip locked
  `, params);

  const draft = result.rows[0] || null;
  if (!draft) return null;

  await client.query(`
    update ai_drafts
    set status = case when nullif($2,'') is not null then $2 else 'PROCESSING' end,
        ai_provider = 'openai',
        ai_model = $3,
        updated_at = now()
    where id = $1
  `, [draft.id, options.claimStatus || "PROCESSING", getSpeakingAudioModel_()]);

  return draft;
}

export function buildSpeakingDraftQueuePrioritySql() {
  const retryableStatuses = SPEAKING_RETRYABLE_QUEUE_STATUSES
    .map((status) => `'${status}'`)
    .join(",");

  // Fresh stored-audio work must run before older retryable failures. Without
  // this priority, one provider or billing failure can remain the oldest row
  // and prevent every later transcription from being claimed.
  return `case when upper(d.status) in (${retryableStatuses}) then 1 else 0 end`;
}

async function releaseSpeakingDraftAfterDeliveredWriting_(draft) {
  const restoredStatus = upper_(draft.status) || "QUEUED";

  return withSupabaseClient(async (client) => {
    const result = await client.query(
      `
        update ai_drafts
        set
          status = $2,
          raw_json = coalesce(raw_json, '{}'::jsonb) || $3::jsonb,
          updated_at = now()
        where id = $1::uuid
        returning *
      `,
      [
        draft.id,
        restoredStatus,
        JSON.stringify({
          speaking_cost_control: {
            reason: "WRITING_FEEDBACK_ALREADY_DELIVERED",
            assignment_key: clean_(draft.assignment_key),
            checked_at: nowIso_()
          }
        })
      ]
    );

    return result.rows[0] || null;
  });
}

async function deliveredWritingGuard_(draft, options = {}) {
  const lookup =
    options.dependencies?.findDeliveredWritingCorrection ||
    findDeliveredWritingCorrection;

  const delivered = await lookup({
    studentId: draft.student_id,
    assignmentKey: draft.assignment_key
  });

  if (!delivered) return null;

  const release =
    options.dependencies?.releaseSpeakingDraftAfterDeliveredWriting ||
    releaseSpeakingDraftAfterDeliveredWriting_;
  await release(draft);

  return {
    ok: true,
    status: "SPEAKING_API_SKIPPED_WRITING_ALREADY_DELIVERED",
    skipped: true,
    skip_reason: "WRITING_FEEDBACK_ALREADY_DELIVERED",
    draft_id: draft.id,
    submission_id: draft.submission_id,
    student_id: draft.student_id,
    assignment_key: draft.assignment_key,
    delivered_writing_feedback_id: delivered.id,
    checked_at: nowIso_()
  };
}

function resolveOriginalAudioSourceUrl_(draft) {
  return clean_(draft.audio_source_url) ||
    clean_(draft.audio_link) ||
    clean_(draft.speakpipe_link) ||
    clean_(draft.resolved_download_url) ||
    clean_(draft.stored_drive_url);
}

function resolveStoredDriveAudioUrl_(draft) {
  const storedDriveFileId = clean_(draft.stored_drive_file_id);
  return storedDriveFileId ? `google-drive-file://${storedDriveFileId}` : "";
}

function resolveAudioUrl_(draft) {
  // Production rule: after the audio-storage stage, transcription and speaking
  // correction must use the stored Google Drive file only. Do not fall back to
  // the original submitted SpeakPipe/other URL here; that can create repeated
  // timeout failures and bypass the storage gate.
  return resolveStoredDriveAudioUrl_(draft);
}


async function verifyStoredDriveAudioIfPresent_(draft) {
  const fileId = clean_(draft.stored_drive_file_id);
  if (!fileId) {
    return { ok: false, status: "NO_STORED_DRIVE_FILE_ID" };
  }

  try {
    const metadata = await getGoogleDriveFileMetadata(fileId);
    return {
      ok: true,
      status: "STORED_DRIVE_FILE_EXISTS",
      drive_file_id: fileId,
      name: metadata.name || "",
      mime_type: metadata.mime_type || "",
      size_bytes: metadata.size_bytes || 0,
      web_view_link: metadata.web_view_link || ""
    };
  } catch (error) {
    return {
      ok: false,
      status: "STORED_DRIVE_FILE_CHECK_FAILED",
      drive_file_id: fileId,
      error: String(error && error.message ? error.message : error)
    };
  }
}

async function downloadAudioForAiProcessing_(draft, purpose = "audio_processing") {
  const storedDriveUrl = resolveStoredDriveAudioUrl_(draft);
  const storedDriveCheck = await verifyStoredDriveAudioIfPresent_(draft);

  if (!storedDriveUrl) {
    throw new Error(`NO_STORED_AUDIO_READY: Speaking draft has no stored Google Drive audio file for ${purpose}. Wait for audio storage before transcription or speaking correction.`);
  }

  if (storedDriveCheck && storedDriveCheck.ok === false) {
    throw new Error(`STORED_AUDIO_CHECK_FAILED: ${storedDriveCheck.error || storedDriveCheck.status || "Stored Google Drive audio could not be verified."}`);
  }

  try {
    const downloaded = await downloadOriginalAudioForProcessing({
      sourceUrl: storedDriveUrl,
      studentName: draft.student_name || "Student",
      lessonKey: [draft.level, draft.module ? `M${draft.module}` : "", draft.unit ? `U${draft.unit}` : "", draft.day ? `D${draft.day}` : ""].filter(Boolean).join("_"),
      referenceName: draft.submission_id || draft.id
    });

    if (!downloaded?.ok || !Buffer.isBuffer(downloaded.original_buffer) || !downloaded.original_buffer.length) {
      throw new Error(downloaded?.reason || "No audio buffer returned from stored Google Drive audio.");
    }

    return {
      ...downloaded,
      source_selection_strategy: "stored_drive_only",
      stored_drive_check: storedDriveCheck,
      attempted_source_urls: [{ strategy: "stored_drive_only", source_url: storedDriveUrl }]
    };
  } catch (error) {
    throw new Error(`Could not download stored Google Drive audio for ${purpose}. Attempts: ${JSON.stringify([{
      strategy: "stored_drive_only",
      source_url: storedDriveUrl,
      error: String(error && error.message ? error.message : error)
    }]).slice(0, 1800)}`);
  }
}

async function transcribeSpeakingDraft_(draft) {
  const transcriptText = clean_(draft.existing_transcript);
  if (transcriptText && upper_(draft.existing_transcript_status) === "COMPLETED") {
    return {
      ok: true,
      reused: true,
      transcript_id: draft.existing_transcript_id,
      transcript_text: transcriptText,
      provider: "openai",
      model: getTranscriptionModel_(),
      source_url: resolveAudioUrl_(draft),
      usage: null,
      raw_json: { reused_existing_transcript: true }
    };
  }

  const sourceUrl = resolveAudioUrl_(draft);
  const downloaded = await downloadAudioForAiProcessing_(draft, "transcription");

  const result = await transcribeAudioWithOpenAi({
    audioBuffer: downloaded.original_buffer,
    fileName: downloaded.original_filename || "speaking-audio.mp3",
    mimeType: downloaded.original_mime_type || "",
    model: getTranscriptionModel_()
  });

  return {
    ok: true,
    reused: false,
    transcript_text: result.transcript_text,
    provider: result.provider,
    model: result.model_requested,
    source_url: sourceUrl,
    usage: result.usage || null,
    raw_json: {
      transcription: result.raw_response || null,
      downloaded: {
        source_url: downloaded.source_url,
        source_type: downloaded.source_type,
        source_selection_strategy: downloaded.source_selection_strategy || "",
        stored_drive_check: downloaded.stored_drive_check || null,
        attempted_source_urls: downloaded.attempted_source_urls || [],
        resolved_download_url: downloaded.resolved_download_url,
        final_download_url: downloaded.final_download_url,
        original_filename: downloaded.original_filename,
        original_mime_type: downloaded.original_mime_type,
        original_size_bytes: downloaded.original_size_bytes
      }
    }
  };
}

async function saveTranscriptSuccess_(client, draft, transcription) {
  if (transcription.reused && transcription.transcript_id) {
    return {
      id: transcription.transcript_id,
      transcript: transcription.transcript_text,
      status: "COMPLETED",
      reused: true
    };
  }

  const existing = await client.query(`select * from transcripts where submission_id = $1 order by created_at desc nulls last limit 1`, [draft.submission_id]);
  if (existing.rows[0]) {
    const updated = await client.query(`
      update transcripts
      set audio_asset_id = $2,
          transcript = $3,
          status = 'COMPLETED',
          provider = $4,
          model = $5,
          raw_json = $6::jsonb,
          updated_at = now()
      where id = $1
      returning *
    `, [
      existing.rows[0].id,
      draft.audio_asset_id || null,
      transcription.transcript_text,
      transcription.provider,
      transcription.model,
      JSON.stringify(transcription.raw_json || {})
    ]);
    return updated.rows[0];
  }

  const inserted = await client.query(`
    insert into transcripts(audio_asset_id, submission_id, transcript, status, provider, model, raw_json)
    values ($1,$2,$3,'COMPLETED',$4,$5,$6::jsonb)
    returning *
  `, [
    draft.audio_asset_id || null,
    draft.submission_id,
    transcription.transcript_text,
    transcription.provider,
    transcription.model,
    JSON.stringify(transcription.raw_json || {})
  ]);
  return inserted.rows[0];
}

async function saveTranscriptionToDraft_(client, draft, transcriptRow) {
  await client.query(`
    update ai_drafts
    set status = 'TRANSCRIBED',
        transcript_id = $2,
        transcript = $3,
        ai_provider = 'openai',
        ai_model = $4,
        raw_json = coalesce(raw_json, '{}'::jsonb) || $5::jsonb,
        updated_at = now()
    where id = $1
  `, [
    draft.id,
    transcriptRow.id,
    transcriptRow.transcript,
    getTranscriptionModel_(),
    JSON.stringify({ transcription_completed_at: nowIso_(), transcript_id: transcriptRow.id })
  ]);

  if (draft.audio_asset_id) {
    await client.query(`
      update audio_assets
      set status = case when status in ('READY_FOR_STORAGE','STORAGE_IN_PROGRESS','STORAGE_FAILED_RETRYABLE') then status else 'TRANSCRIBED' end,
          updated_at = now()
      where id = $1
    `, [draft.audio_asset_id]);
  }
}

export async function processTranscriptionOne(options = {}) {
  const withClient = options.dependencies?.withSupabaseClient || withSupabaseClient;
  let draft = null;

  if (options.dependencies?.claimSpeakingDraft) {
    draft = await options.dependencies.claimSpeakingDraft(options);
  } else {
    await withClient(async (client) => {
      await client.query("begin");
      try {
        draft = await claimSpeakingDraft_(client, {
          ...options,
          claimStatus: "TRANSCRIBING",
          requireStoredAudio: true,
          allowedStatuses: [
            "WAITING_FOR_AUDIO_STORAGE",
            "QUEUED",
            "TRANSCRIPTION_FAILED_RETRYABLE"
          ]
        });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  if (!draft) {
    return { ok: true, status: "NO_SPEAKING_TRANSCRIPTION_READY", processed: null, checked_at: nowIso_() };
  }

  const costControlSkip = await deliveredWritingGuard_(draft, options);
  if (costControlSkip) return costControlSkip;

  try {
    const transcription = await transcribeSpeakingDraft_(draft);
    const transcriptRow = await withClient(async (client) => {
      const row = await saveTranscriptSuccess_(client, draft, transcription);
      await saveTranscriptionToDraft_(client, draft, row);
      return row;
    });

    return {
      ok: true,
      status: transcription.reused ? "TRANSCRIPTION_REUSED" : "TRANSCRIPTION_COMPLETED",
      draft_id: draft.id,
      submission_id: draft.submission_id,
      transcript_id: transcriptRow.id,
      transcript_preview: clean_(transcriptRow.transcript).slice(0, 400),
      provider: transcription.provider,
      model: transcription.model,
      checked_at: nowIso_()
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);

    if (isPermanentSpeakingNotAssessedError_(message)) {
      const saved = await withClient((client) => saveSpeakingNotAssessed_(client, draft, {
        message,
        provider: "openai",
        model: getTranscriptionModel_(),
        stage: "TRANSCRIPTION"
      }));

      return {
        ok: true,
        status: "SPEAKING_NOT_ASSESSED",
        draft_id: draft.id,
        submission_id: draft.submission_id,
        review_status: saved?.review_status || PARTIAL_FEEDBACK,
        reason: saved?.review_note || notAssessedReasonFromError_(message),
        checked_at: nowIso_()
      };
    }

    await withClient((client) => saveDraftFailure_(client, draft.id, {
      status: "TRANSCRIPTION_FAILED_RETRYABLE",
      reviewStatus: NOT_READY,
      provider: "openai",
      model: getTranscriptionModel_(),
      message,
      stage: "TRANSCRIPTION"
    }));

    return {
      ok: false,
      status: "TRANSCRIPTION_FAILED_RETRYABLE",
      draft_id: draft.id,
      submission_id: draft.submission_id,
      error: message,
      checked_at: nowIso_()
    };
  }
}


function transcriptRowFromClaimedDraft_(draft) {
  const transcript = clean_(draft.existing_transcript || draft.transcript);
  const id = clean_(draft.existing_transcript_id || draft.transcript_id);

  if (!transcript) {
    throw new Error("NO_COMPLETED_TRANSCRIPT_READY: Speaking correction requires a completed transcript before correction.");
  }

  return {
    id: id || null,
    transcript,
    status: clean_(draft.existing_transcript_status) || "COMPLETED"
  };
}

async function saveSpeakingSuccess_(client, draft, transcriptRow, correction) {
  const parsed = correction.parsed_json || {};
  const rawJson = {
    ...(safeJsonParse_(draft.raw_json, {})),
    speaking_correction_completed_at: nowIso_(),
    speaking_correction_provider: correction.provider,
    speaking_correction_model_requested: correction.audio_model_requested || correction.model_requested || getSpeakingAudioModel_(),
    speaking_audio_model_requested: correction.audio_model_requested || correction.model_requested || getSpeakingAudioModel_(),
    speaking_usage: correction.usage || null,
    audio_observation_ok: Boolean(correction.audio_observation_ok),
    transcript_id: transcriptRow.id,
    correction: parsed
  };

  const result = await client.query(`
    update ai_drafts
    set
      status = 'COMPLETED',
      review_status = $2,
      transcript_id = $3,
      transcript = $4,
      score = $5,
      task_achievement_score = $6,
      grammar_score = $7,
      vocabulary_score = $8,
      organisation_score = $9,
      clarity_naturalness_score = $10,
      pronunciation_score = $11,
      fluency_score = $12,
      teacher_draft_feedback = null,
      student_draft_feedback = $13,
      teacher_email_subject = $14,
      teacher_email_body = null,
      raw_json = $15::jsonb,
      ai_provider = 'openai',
      ai_model = $16,
      updated_at = now()
    where id = $1
    returning *
  `, [
    draft.id,
    READY_FOR_REVIEW,
    transcriptRow.id,
    transcriptRow.transcript,
    clampScore_(parsed.score),
    clampScore_(parsed.task_achievement_score),
    clampScore_(parsed.grammar_score),
    clampScore_(parsed.vocabulary_score),
    clampScore_(parsed.organisation_score),
    clampScore_(parsed.clarity_naturalness_score),
    clampScore_(parsed.pronunciation_score),
    clampScore_(parsed.fluency_score),
    clean_(parsed.formatted_feedback),
    clean_(parsed.teacher_email_subject || `Speaking correction for ${draft.student_name || "student"}`),
    JSON.stringify(rawJson),
    correction.audio_model_returned || correction.audio_model_requested || correction.model_returned || correction.model_requested || getSpeakingAudioModel_()
  ]);

  return result.rows[0];
}

export async function processSpeakingCorrectionOne(options = {}) {
  let draft = null;

  if (options.dependencies?.claimSpeakingDraft) {
    draft = await options.dependencies.claimSpeakingDraft(options);
  } else {
    await withSupabaseClient(async (client) => {
      await client.query("begin");
      try {
        draft = await claimSpeakingDraft_(client, {
          ...options,
          claimStatus: "PROCESSING",
          requireStoredAudio: true,
          requireCompletedTranscript: true,
          allowedStatuses: [
            "TRANSCRIBED",
            "FAILED_RETRYABLE",
            "CORRECTION_FAILED_RETRYABLE"
          ]
        });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  if (!draft) {
    return { ok: true, status: "NO_SPEAKING_CORRECTION_READY", processed: null, checked_at: nowIso_() };
  }

  const costControlSkip = await deliveredWritingGuard_(draft, options);
  if (costControlSkip) return costControlSkip;

  try {
    // Speaking correction must not transcribe again. Transcription is a separate
    // previous step handled by processTranscriptionOne(). This route only uses
    // the transcript already stored on the draft/transcripts table and the
    // stored Google Drive audio selected by claimSpeakingDraft_().
    const transcriptRow = transcriptRowFromClaimedDraft_(draft);

    const sourceUrl = resolveAudioUrl_(draft);
    const correction = await generateJeaSpeakingCorrectionWithAudioThenStructuredReview({
      transcriptText: transcriptRow.transcript,
      sourceUrl,
      speakingPrompt: draft.speaking_task_instruction || draft.full_instruction || draft.speaking_choice_text || draft.choice_text || "",
      studentName: draft.student_name || "Student",
      studentLevel: draft.level || "",
      moduleNumber: draft.module || "",
      unitNumber: draft.unit || "",
      dayNumber: draft.day || "",
      grammarContext: grammarContextFromDraft_(draft),
      vocabularyContext: null,
      curriculumContext: {
        source: "supabase_correction_repository",
        assignment_key: draft.assignment_key || "",
        note: "Live HTTP route correction. Transcription and speaking correction executed synchronously."
      },
      audioModel: getSpeakingAudioModel_()
    });

    const saved = await withSupabaseClient((client) => saveSpeakingSuccess_(client, draft, transcriptRow, correction));

    return {
      ok: true,
      status: "SPEAKING_CORRECTION_COMPLETED",
      draft_id: draft.id,
      submission_id: draft.submission_id,
      transcript_id: transcriptRow.id,
      student_email: draft.student_email,
      score: saved.score,
      review_status: saved.review_status,
      provider: "openai",
      model: saved.ai_model,
      audio_observation_ok: Boolean(correction.audio_observation_ok),
      checked_at: nowIso_()
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);

    // Speaking correction is reached only after a speaking draft has stored
    // Google Drive audio and a completed transcript. At this stage, failures
    // are correction/model/parser/provider failures, not student submission
    // terminal failures. Do not convert them to NOT_ASSESSED here; keep them
    // retryable so the same stored Drive audio + transcript can be processed
    // again after prompt/parser/provider fixes.
    await withSupabaseClient((client) => saveDraftFailure_(client, draft.id, {
      status: "FAILED_RETRYABLE",
      reviewStatus: NOT_READY,
      provider: "openai",
      model: getSpeakingAudioModel_(),
      message,
      stage: "SPEAKING_CORRECTION"
    }));

    return {
      ok: false,
      status: "SPEAKING_CORRECTION_FAILED_RETRYABLE",
      draft_id: draft.id,
      submission_id: draft.submission_id,
      error: message,
      checked_at: nowIso_()
    };
  }
}

export async function processCorrectionBatch(options = {}) {
  void options;
  return {
    ok: false,
    status: "CORRECTION_BATCH_DISABLED",
    message: "Batch correction is disabled by design. Use process-writing-one, process-transcription-one, and process-speaking-one so every correction is processed and returned immediately.",
    checked_at: nowIso_()
  };
}
