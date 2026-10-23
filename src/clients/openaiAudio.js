import { buildBatchLine } from "./openaiBatch.js";

// ---------------------------------------------------------------------------
// OpenRouter transport.
//
// This client used to call api.openai.com directly. It now routes through
// OpenRouter (https://openrouter.ai) so the same GPT audio models (transcription
// + audio-in chat completions) can be reached with an OPENROUTER_API_KEY instead
// of an OPENAI_API_KEY. OpenRouter exposes OpenAI-compatible endpoints:
//   - POST {base}/audio/transcriptions   (accepts the same multipart/form-data
//     upload OpenAI's SDK sends, so the request body below is unchanged)
//   - POST {base}/chat/completions       (accepts the same "input_audio" content
//     blocks OpenAI's chat completions API uses)
//
// The only real differences are: (1) the base URL, (2) the bearer token env var,
// (3) two optional attribution headers OpenRouter recommends, and (4) model
// names must be prefixed with the upstream provider, e.g. "openai/gpt-audio"
// instead of "gpt-audio".
// ---------------------------------------------------------------------------

const OPENROUTER_BASE_URL = String(process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1")
  .trim()
  .replace(/\/+$/, "");

const OPENAI_TRANSCRIPTION_URL = `${OPENROUTER_BASE_URL}/audio/transcriptions`;
const OPENAI_CHAT_COMPLETIONS_URL = `${OPENROUTER_BASE_URL}/chat/completions`;

// OpenRouter model slugs. These must keep the "openai/" provider prefix.
const DEFAULT_TRANSCRIPTION_MODEL = "openai/gpt-4o-transcribe";
// Preserve the deployed correction worker's default when a trial variable is
// removed. All entry points now resolve the same model at call time.
const DEFAULT_AUDIO_FEEDBACK_MODEL = "openai/gpt-4o-audio-preview";
const DEFAULT_AUDIO_FEEDBACK_FALLBACK_MODEL = "openai/gpt-audio-mini";

export function getSpeakingAudioModels() {
  const value = (name) => String(process.env[name] || "").trim();
  return {
    model: normaliseOpenRouterModel_(value("OPENAI_SPEAKING_AUDIO_MODEL") || value("OPENAI_AUDIO_FEEDBACK_MODEL") || DEFAULT_AUDIO_FEEDBACK_MODEL),
    fallbackModel: normaliseOpenRouterModel_(value("OPENAI_SPEAKING_AUDIO_FALLBACK_MODEL") || value("OPENAI_AUDIO_FEEDBACK_FALLBACK_MODEL") || DEFAULT_AUDIO_FEEDBACK_FALLBACK_MODEL)
  };
}

const VERBATIM_TRANSCRIPTION_PROMPT = `
Transcribe this as a verbatim English learner transcript.

Do not clean the grammar.
Do not correct mistakes.
Do not remove false starts.
Do not remove self-corrections.
Do not remove repetitions.
Do not silently replace an incorrect first attempt with a corrected second attempt.
Keep hesitations, repairs, repeated words, abandoned starts, and learner self-corrections.

Examples:
If the speaker says “She have... sorry, she has a bag”, transcribe exactly:
“She have... sorry, she has a bag.”

If the speaker says “I am go... I am going to work”, transcribe exactly:
“I am go... I am going to work.”

If the speaker repeats a word, keep the repetition.
If the speaker starts a sentence and abandons it, keep the abandoned start.
`.trim();

const LABELS_FR = {
  score: "Score",
  goodPoint: "Bon point",
  toImprove: "À corriger",
  why: "Pourquoi ?",
  model: "Modèle",
  task: "Respect de la consigne",
  grammar: "Grammaire",
  vocabulary: "Vocabulaire",
  pronunciation: "Prononciation",
  pronunciationDetails: "Corrections de prononciation",
  fluency: "Fluidité",
  organisationClarity: "Organisation et clarté"
};

const LABELS_EN = {
  score: "Score",
  goodPoint: "Good point",
  toImprove: "To improve",
  why: "Why?",
  model: "Model",
  task: "Task achievement",
  grammar: "Grammar",
  vocabulary: "Vocabulary",
  pronunciation: "Pronunciation",
  pronunciationDetails: "Pronunciation corrections",
  fluency: "Fluency",
  organisationClarity: "Organisation and clarity"
};

export async function transcribeAudioWithOpenAi({
  audioBuffer,
  fileName = "audio.mp3",
  mimeType = "",
  model = process.env.OPENAI_TRANSCRIPTION_MODEL || DEFAULT_TRANSCRIPTION_MODEL,
  language = "en",
  prompt = process.env.OPENAI_TRANSCRIPTION_PROMPT || VERBATIM_TRANSCRIPTION_PROMPT
}) {
  const openRouterApiKey = getOpenRouterApiKey_();

  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    throw new Error("audioBuffer must be a non-empty Node.js Buffer.");
  }

  const safeFileName = makeSafeAudioFileName(fileName);
  const safeMimeType = mimeType || guessMimeTypeFromFileName(safeFileName);

  const formData = new FormData();

  formData.append(
    "file",
    new Blob([audioBuffer], { type: safeMimeType }),
    safeFileName
  );

  formData.append("model", model);

  if (language) {
    formData.append("language", language);
  }

  // The normal transcription models support prompting. Diarization models do not.
  if (prompt && !String(model).toLowerCase().includes("diarize")) {
    formData.append("prompt", prompt);
  }

  const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
    method: "POST",
    headers: buildOpenRouterHeaders_(openRouterApiKey),
    body: formData
  });

  const text = await response.text();
  const data = parseJsonOrThrow(
    text,
    `OpenRouter transcription returned non-JSON. HTTP ${response.status}.`
  );

  if (!response.ok) {
    throw new Error(
      `OpenRouter transcription failed. HTTP ${response.status}. Body: ${JSON.stringify(data).slice(0, 1200)}`
    );
  }

  return {
    ok: true,
    provider: "openai",
    model_requested: model,
    transcript_text: String(data.text || "").trim(),
    transcription_prompt_used: !String(model).toLowerCase().includes("diarize") ? prompt : "",
    raw_response: data,
    usage: data.usage || null
  };
}
export async function evaluateJeaSpeakingAudioWithOpenAi({
  originalAudioBuffer,
  originalFileName = "audio.mp3",
  originalMimeType = "",
  wavBuffer = null,
  wavFileName = "audio.wav",

  speakingPrompt = "",
  studentName = "",
  studentLevel = "",
  moduleNumber = "",
  unitNumber = "",
  dayNumber = "",

  grammarContext = null,
  vocabularyContext = null,
  curriculumContext = null,
  pronunciationGuide = ""
}) {
  if (!Buffer.isBuffer(originalAudioBuffer) || !originalAudioBuffer.length) {
    throw new Error("originalAudioBuffer must be a non-empty Node.js Buffer.");
  }

  const transcription = await transcribeAudioWithOpenAi({
    audioBuffer: originalAudioBuffer,
    fileName: originalFileName,
    mimeType: originalMimeType
  });

  const audioForFeedback = chooseAudioForOpenAiFeedback({
    originalAudioBuffer,
    originalFileName,
    originalMimeType,
    wavBuffer,
    wavFileName
  });

  const correctionResult = await generateJeaSpeakingCorrectionFromAudioWithOpenAi({
    audioBuffer: audioForFeedback.audioBuffer,
    fileName: audioForFeedback.fileName,
    mimeType: audioForFeedback.mimeType,
    transcriptText: transcription.transcript_text,
    speakingPrompt,
    studentName,
    studentLevel,
    moduleNumber,
    unitNumber,
    dayNumber,
    grammarContext,
    vocabularyContext,
    curriculumContext,
    pronunciationGuide
  });

  return {
    ok: true,
    provider: "openai",
    transcription,
    feedback: correctionResult,
    transcript_text: transcription.transcript_text,
    speaking_feedback_json: correctionResult.parsed_json,
    storage_payload: {
      score: correctionResult.parsed_json.score,
      grammar_score: correctionResult.parsed_json.grammar_score,
      vocabulary_score: correctionResult.parsed_json.vocabulary_score,
      fluency_score: correctionResult.parsed_json.fluency_score,
      pronunciation_score: correctionResult.parsed_json.pronunciation_score,
      task_achievement_score: correctionResult.parsed_json.task_achievement_score,
      organisation_score: correctionResult.parsed_json.organisation_score,
      spelling_score: "",
      student_draft_feedback: correctionResult.parsed_json.student_draft_feedback,
      teacher_email_subject: correctionResult.parsed_json.teacher_email_subject,
      ai_provider: "openai",
      ai_model: correctionResult.model_returned || correctionResult.model_requested || "",
      raw_json: {
        transcript_text_used: transcription.transcript_text,
        correction: correctionResult.parsed_json,
        method_90_guide_embedded_in_code: true,
        usage: {
          transcription: transcription.usage || null,
          feedback: correctionResult.usage || null
        }
      }
    }
  };
}
export function buildSpeakingCorrectionBatchLine({
  customId,
  audioBuffer,
  fileName = "audio.mp3",
  mimeType = "",
  transcriptText,
  speakingPrompt,
  studentName,
  studentLevel,
  moduleNumber,
  unitNumber,
  dayNumber,
  grammarContext,
  vocabularyContext,
  curriculumContext,
  pronunciationGuide,
  feedbackLanguage,
  model = getSpeakingAudioModels().model
}) {
  if (!customId) {
    throw new Error("customId is required for speaking correction batch line.");
  }

  const body = buildSpeakingCorrectionChatCompletionBody({
    audioBuffer,
    fileName,
    mimeType,
    transcriptText,
    speakingPrompt,
    studentName,
    studentLevel,
    moduleNumber,
    unitNumber,
    dayNumber,
    grammarContext,
    vocabularyContext,
    curriculumContext,
    pronunciationGuide,
    feedbackLanguage,
    model
  });

  return buildBatchLine({
    customId,
    url: "/v1/chat/completions",
    body
  });
}

export function buildSpeakingCorrectionChatCompletionBody({
  audioBuffer,
  fileName = "audio.mp3",
  mimeType = "",
  transcriptText,
  speakingPrompt,
  studentName,
  studentLevel,
  moduleNumber,
  unitNumber,
  dayNumber,
  grammarContext,
  vocabularyContext,
  curriculumContext,
  pronunciationGuide,
  feedbackLanguage,
  model = getSpeakingAudioModels().model
}) {
  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    throw new Error("audioBuffer must be a non-empty Buffer.");
  }

  const safeFileName = makeSafeAudioFileName(fileName);
  const safeMimeType = mimeType || guessMimeTypeFromFileName(safeFileName);
  const audioFormat = getOpenAiAudioFormatFromMimeOrName({
    mimeType: safeMimeType,
    fileName: safeFileName
  });

  const prompt = buildSpeakingCorrectionPrompt({
    transcriptText,
    speakingPrompt,
    studentName,
    studentLevel,
    moduleNumber,
    unitNumber,
    dayNumber,
    grammarContext,
    vocabularyContext,
    curriculumContext,
    pronunciationGuide,
    feedbackLanguage
  });

  return {
    model: normaliseOpenRouterModel_(model),
    messages: [
      {
        role: "system",
        content:
          "You are the speaking correction assistant for John's English Academy. Return valid JSON only. Text fields may use clean Markdown for emphasis. Do not create the final PDF layout; the server/review layer will build it."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt
          },
          {
            type: "input_audio",
            input_audio: {
              data: audioBuffer.toString("base64"),
              format: audioFormat
            }
          }
        ]
      }
    ],
  };
}

async function postOpenAiAudioFeedbackWithFallback_({ openRouterApiKey, requestBody, primaryModel }) {
  const modelsToTry = uniqueModels_([
    normaliseOpenRouterModel_(primaryModel),
    getSpeakingAudioModels().fallbackModel
  ]);
  const attempted = [];
  let lastError = null;

  for (const model of modelsToTry) {
    attempted.push(model);
    const body = { ...requestBody, model };

    const response = await fetch(OPENAI_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: buildOpenRouterHeaders_(openRouterApiKey, { json: true }),
      body: JSON.stringify(body)
    });

    const text = await response.text();
    const raw = parseJsonOrThrow(
      text,
      `OpenRouter audio feedback returned non-JSON. HTTP ${response.status}.`
    );

    if (response.ok) {
      return {
        ...raw,
        _jea_model_attempts: attempted,
        _jea_fallback_used: attempted.length > 1
      };
    }

    const message = `OpenRouter audio feedback failed. HTTP ${response.status}. Body: ${JSON.stringify(raw).slice(0, 1600)}`;
    lastError = new Error(message);

    if (!isRetryableAudioModelSelectionError_(message)) {
      throw lastError;
    }
  }

  throw new Error(
    `OpenRouter audio feedback failed for all configured audio models. Tried: ${attempted.join(", ")}. Last error: ${String(lastError && lastError.message ? lastError.message : lastError)}`
  );
}

// OpenRouter model slugs must be namespaced as "<provider>/<model>". Older
// env vars/config may still hold a bare OpenAI model name (e.g. "gpt-audio"
// left over from the direct-OpenAI setup) — default those to the "openai/"
// provider so existing env vars keep working without edits.
function normaliseOpenRouterModel_(model) {
  const clean = String(model || "").trim();
  if (!clean) return clean;
  return clean.includes("/") ? clean : `openai/${clean}`;
}

function buildOpenRouterHeaders_(openRouterApiKey, { json = false } = {}) {
  const headers = {
    Authorization: `Bearer ${openRouterApiKey}`
  };

  if (json) {
    headers["Content-Type"] = "application/json";
  }

  // Optional but recommended by OpenRouter for attribution/analytics on
  // openrouter.ai; safe to omit if unset.
  const referer = String(process.env.OPENROUTER_SITE_URL || "").trim();
  if (referer) headers["HTTP-Referer"] = referer;

  const title = String(process.env.OPENROUTER_APP_NAME || "John's English Academy").trim();
  if (title) headers["X-Title"] = title;

  return headers;
}

function uniqueModels_(models) {
  const seen = new Set();
  const output = [];

  for (const model of models) {
    const clean = String(model || "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    output.push(clean);
  }

  return output;
}

function isRetryableAudioModelSelectionError_(message) {
  const lower = String(message || "").toLowerCase();
  return lower.includes("model_not_found") ||
    lower.includes("does not exist") ||
    lower.includes("do not have access") ||
    lower.includes("unsupported model") ||
    lower.includes("invalid model") ||
    lower.includes("http 404");
}

function getOpenAiAudioFormatFromMimeOrName({
  mimeType,
  fileName
}) {
  const lowerMime = String(mimeType || "").toLowerCase();
  const lowerName = String(fileName || "").toLowerCase();

  if (lowerMime.includes("wav") || lowerName.endsWith(".wav")) {
    return "wav";
  }

  if (
    lowerMime.includes("mpeg") ||
    lowerMime.includes("mp3") ||
    lowerName.endsWith(".mp3")
  ) {
    return "mp3";
  }

  // Chat Completions input_audio currently supports wav and mp3.
  // Default to mp3 because SpeakPipe usually produces mp3-compatible audio.
  return "mp3";
}
export async function evaluateSpeakingAudioWithOpenAi(args) {
  return evaluateJeaSpeakingAudioWithOpenAi({
    originalAudioBuffer: args.originalAudioBuffer,
    originalFileName: args.originalFileName,
    originalMimeType: args.originalMimeType,
    wavBuffer: args.wavBuffer,
    wavFileName: args.wavFileName,
    speakingPrompt: args.taskInstruction || args.speakingPrompt || "",
    studentName: args.studentName || "Student",
    studentLevel: args.studentLevel || "",
    moduleNumber: args.moduleNumber || "",
    unitNumber: args.unitNumber || "",
    dayNumber: args.dayNumber || "",
    grammarContext: args.grammarContext || null,
    vocabularyContext: args.vocabularyContext || null,
    curriculumContext: args.curriculumContext || null,
    pronunciationGuide: args.pronunciationGuide || ""
  });
}

export async function generateJeaSpeakingCorrectionFromAudioWithOpenAi({
  audioBuffer,
  fileName = "audio.mp3",
  mimeType = "",
  transcriptText = "",
  speakingPrompt = "",
  studentName = "",
  studentLevel = "",
  moduleNumber = "",
  unitNumber = "",
  dayNumber = "",
  grammarContext = null,
  vocabularyContext = null,
  curriculumContext = null,
  pronunciationGuide = "",
  feedbackModel = getSpeakingAudioModels().model
}) {
  const openRouterApiKey = getOpenRouterApiKey_();

  if (!Buffer.isBuffer(audioBuffer) || !audioBuffer.length) {
    throw new Error("audioBuffer must be a non-empty Node.js Buffer.");
  }

  const audioFormat = getSupportedOpenAiAudioInputFormat({
    fileName,
    mimeType
  });

  if (!audioFormat) {
    throw new Error("OpenAI audio feedback needs MP3 or WAV input.");
  }

  const feedbackLanguage = resolveFeedbackLanguage({
    studentLevel,
    moduleNumber
  });

  const prompt = buildSpeakingCorrectionPrompt({
    transcriptText,
    speakingPrompt,
    studentName,
    studentLevel,
    moduleNumber,
    unitNumber,
    dayNumber,
    grammarContext,
    vocabularyContext,
    curriculumContext,
    pronunciationGuide,
    feedbackLanguage
  });

  const requestBody = {
    model: normaliseOpenRouterModel_(feedbackModel),
    modalities: ["text"],
    messages: [
      {
        role: "system",
        content:
          "You are the speaking correction assistant for John's English Academy. Return exactly one raw JSON object only. Do not wrap the JSON object in a string. Do not escape the JSON object's quotation marks. Text fields may use clean Markdown for emphasis. Do not create the final visible layout; the server code will build it."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: prompt
          },
          {
            type: "input_audio",
            input_audio: {
              data: audioBuffer.toString("base64"),
              format: audioFormat
            }
          }
        ]
      }
    ],
    
    temperature: 0.1
  };

  const raw = await postOpenAiAudioFeedbackWithFallback_({
    openRouterApiKey,
    requestBody,
    primaryModel: feedbackModel
  });

  const outputText = extractChatCompletionText(raw);

  if (!outputText) {
    throw new Error("OpenRouter audio feedback returned empty text.");
  }

  const modelJson = parseJsonFromModelOutput(outputText);

  const normalised = normaliseSpeakingCorrection({
    modelJson,
    studentName,
    studentLevel,
    moduleNumber,
    unitNumber,
    dayNumber,
    transcriptText,
    speakingPrompt,
    grammarContext,
    feedbackLanguage
  });

  validateRequiredCorrectionFields(normalised);

  const formattedFeedback = buildStudentFeedback({
    correction: normalised,
    studentName,
    feedbackLanguage
  });

  const teacherEmailSubject = cleanText(normalised.teacher_email_subject);

  const parsedJson = {
    ...normalised,
    formatted_feedback: formattedFeedback,
    student_draft_feedback: formattedFeedback,
    teacher_email_subject: teacherEmailSubject
  };

  return {
    ok: true,
    provider: "openai",
    model_requested: feedbackModel,
    model_returned: raw.model || "",
    audio_model_attempts: raw._jea_model_attempts || [feedbackModel],
    fallback_used: Boolean(raw._jea_fallback_used),
    parsed_json: parsedJson,
    output_text: formattedFeedback,
    usage: raw.usage || null,
    raw_response: raw
  };
}

function buildSpeakingCorrectionPrompt({
  transcriptText,
  speakingPrompt,
  studentName,
  studentLevel,
  moduleNumber,
  unitNumber,
  dayNumber,
  grammarContext,
  vocabularyContext,
  curriculumContext,
  pronunciationGuide,
  feedbackLanguage
}) {
  const currentGrammar = grammarContext && grammarContext.current_lesson_grammar
    ? String(grammarContext.current_lesson_grammar).trim()
    : "";

  const previousGrammarSummary = grammarContext && grammarContext.previous_grammar_summary
    ? String(grammarContext.previous_grammar_summary).trim()
    : "";

  const previousGrammarList = grammarContext && Array.isArray(grammarContext.previous_grammar)
    ? grammarContext.previous_grammar.map(item => {
        return `${item.lesson_key || ""}: ${item.grammar || ""}`;
      }).join("\n")
    : "";

  const currentLessonKey = grammarContext && grammarContext.lesson_key
    ? String(grammarContext.lesson_key).trim()
    : "";

  const languageInstruction = feedbackLanguage === "fr"
    ? "Write feedback comments in French. The model answer must stay in English."
    : "Write feedback comments in simple English. The model answer must stay in English.";

  return `
You are correcting a speaking submission for John's English Academy.

${languageInstruction}

You receive:
1. the exact speaking prompt,
2. the student's audio,
3. a verbatim learner transcript already generated,
4. grammar context,
5. optional vocabulary/curriculum context,
6. British IPA pronunciation targets when pronunciation correction is needed.

Use clean Markdown only inside text fields when you need emphasis. For example, use **bold** for corrected forms, important grammar rules, vocabulary changes, pronunciation targets, and fluency advice.

DUAL-INPUT RULE:
- Use the provided transcript as the source of truth for task achievement, grammar, vocabulary, organisation, and content clarity.
- Use the audio for pronunciation and fluency.
- Do not transcribe the audio yourself.
- Do not invent words that are not in the transcript.
- Do not include a transcript section in your answer.

TRANSCRIPT FAITHFULNESS RULE:
- Do not quote a student error unless the exact phrase appears in the transcript.
- Do not say a time, place, name, day, object, or required element is missing if it appears in the transcript or is clearly expressed with equivalent wording.
- If the transcript shows a self-correction, mention it. Praise the student for self-correcting, but still explain the rule briefly.
- Do not erase the first mistake when the student self-corrects.

POINT OF VIEW:
- Write as if the teacher is speaking directly to the student.
- Do not address the academy owner.
- Do not mention system instructions.

STUDENT:
Name: ${studentName || "Student"}
Level: ${studentLevel || "Unknown"}
Module: ${moduleNumber || "Unknown"}
Unit: ${unitNumber || "Unknown"}
Day: ${dayNumber || "Unknown"}
Lesson key: ${currentLessonKey || "Unknown"}

SPEAKING PROMPT:
${speakingPrompt || "No prompt provided."}

CURRENT LESSON GRAMMAR:
${currentGrammar || "Not provided."}

PREVIOUS GRAMMAR:
${previousGrammarSummary || previousGrammarList || "Not provided."}

VOCABULARY CONTEXT:
${safePromptJson(vocabularyContext) || "Not provided. Use the speaking prompt, transcript, current grammar, and previous grammar context only."}

CURRICULUM CONTEXT:
${safePromptJson(curriculumContext) || "Not provided. Use the speaking prompt, transcript, current grammar, and previous grammar context only."}

VERBATIM TRANSCRIPT:
${transcriptText || "No transcript provided."}

PENALTY LIMIT:
Only penalise grammar, vocabulary, pronunciation, and fluency from:
- current lesson grammar,
- previous lesson grammar,
- current lesson vocabulary,
- previous lesson vocabulary,
- words or phrases explicitly present in the speaking prompt,
- pronunciation/fluency items that affect the student's ability to communicate the required task.

Do not penalise material the student has not studied yet.

TASK VS LESSON STRUCTURE RULE:
- Do not force the student to use the grammar of the day unless the prompt explicitly requires it.
- If the student uses correct extra language, do not penalise it.

STRICT OVERPRODUCTION RULE:
- If the student achieves the core speaking task but slightly exceeds the requested length or adds extra relevant details, deduct no more than 2 points out of 20, strictly from Task Achievement.
- On those facts alone, Task Achievement must remain at least 18/20.
- Do not deduct points from Grammar and vocabulary, Pronunciation, Fluency, or Organisation and clarity merely because the answer is slightly long or contains extra relevant information.
- An independent language, pronunciation, or fluency error that actually occurs in the additional speech may still be assessed under its proper criterion.

GRAMMAR RULE:
- Grammar means rules of language: verb forms, tense, word order, subject-verb agreement, articles, prepositions, question forms, negatives, and sentence structure.
- Grammar corrections must be based on the transcript only.
- Mention only errors connected to current or previous lesson grammar, prompt requirements, or essential beginner structures.

VOCABULARY RULE:
- Vocabulary means knowledge and use of words: word choice, range, accuracy, taught words, prompt words, and natural expressions.
- Vocabulary comments must be based on taught vocabulary, prompt words, or words needed for this task.
- Do not mix vocabulary comments with grammar comments.

PRONUNCIATION RULE:
- Use the audio for pronunciation.
- Compare the audio with the provided transcript.
- Do not penalise accent variation.
- Penalise pronunciation only when a taught word, previous lesson word, prompt word, or task-important word becomes difficult or impossible to recognise.
- Every pronunciation correction must include:
  1. the exact word or phrase from the transcript,
  2. what was unclear in the audio,
  3. the target pronunciation using standard British IPA between slashes,
  4. a practical reminder.
- Do not write vague pronunciation feedback such as "some words could be clearer" unless you also identify exact words in pronunciation_corrections.
- Do not tell the student to pronounce silent letters. For example, do not tell the student to pronounce the "h" in "honest/dishonest" or the "l" in "calm".
- If you give a pronunciation target, use real British IPA between slashes, for example /teɪk/ or /ˈbɪz-nəs/. Do not use Method-90 notation here; the server converts reviewed IPA into Method-90 after DeepSeek review.
- Do not invent IPA for words that are not in the transcript, task, or first correction evidence.
- If no taught or task-important word was seriously unclear, return an empty pronunciation_corrections array and write a clear pronunciation_comment saying that the pronunciation was generally understandable.

FLUENCY RULE:
- Fluency means smoothness of speech, rhythm, speed, hesitation, long pauses, repetition, and ability to continue speaking.
- Use the audio and transcript together for fluency.
- Do not confuse fluency with pronunciation.
- A student can have clear pronunciation but weak fluency if there are many long pauses or broken starts.
- A student can self-correct and still receive positive feedback if the correction shows awareness.

NATURALNESS RULE:
- If the student uses grammatically correct but unnatural language, explain the more natural option.
- Do not punish naturalness heavily unless it affects clarity.

SCORING:
- task_achievement_score: 0 to 20
- grammar_score: 0 to 20
- vocabulary_score: 0 to 15
- pronunciation_score: 0 to 20
- fluency_score: 0 to 15
- organisation_score: 0 to 10

OUTPUT RULE:
- Return exactly one raw JSON object and nothing else.
- Do not wrap the JSON object in a string.
- Do not escape the JSON object's quotation marks.
- Do not return text like {\"task_achievement_score\": 18}.
- Do not return Markdown outside JSON values.
- Do not use code fences.
- Do not add any explanation before or after the JSON.
- The first character of your response must be {.
- The last character of your response must be }.
- Use exactly the schema below. Do not rename keys. Do not add extra top-level keys.
- Every required string must be written by you.
- Do not leave required strings blank.
- Do not rely on fallback feedback. There is no fallback feedback.
- Newline characters inside string values must be escaped as \n.
- Double quotes inside string values must be escaped only when they are part of that string value; do not escape JSON keys or the JSON object's structural quotes.

Return this exact raw JSON object structure:

{
  "task_achievement_score": number,
  "grammar_score": number,
  "vocabulary_score": number,
  "pronunciation_score": number,
  "fluency_score": number,
  "organisation_score": number,

  "good_point": "one specific praise sentence, without the student's name",
  "to_improve": "one or two specific sentences",
  "why": "specific explanation with examples from the transcript where useful",
  "model_answer": "corrected natural model answer in English",

  "task_achievement_comment": "specific comment explaining the task achievement score",
  "grammar_comment": "specific comment explaining the grammar score",
  "vocabulary_comment": "specific comment explaining the vocabulary score",
  "pronunciation_comment": "specific comment based on the audio and exact pronunciation corrections",
  "fluency_comment": "specific comment explaining the fluency score from pauses, rhythm, hesitation, and self-corrections",
  "organisation_comment": "specific comment explaining the organisation and clarity score",

  "pronunciation_corrections": [
    {
      "word_or_phrase": "exact word or phrase from the transcript",
      "heard_problem": "what made it unclear in the audio",
      "target_ipa": "target pronunciation using standard British IPA between slashes",
      "practical_reminder": "short practical reminder",
      "taught_status": "current_lesson / previous_lesson / prompt_word / task_important_word / not_penalised",
      "penalized": true
    }
  ],

  "teacher_email_subject": "short teacher-facing subject line",

  "teacher_notes_internal": {
    "audio_observations": "specific short note about pronunciation and fluency",
    "transcript_observations": "specific short note about transcript-based grammar/vocabulary/task evidence",
    "self_correction_observations": "specific short note about any self-correction, or say none observed",
    "uncertainties": "specific short note",
    "penalty_limit_applied": "specific short note",
    "pronunciation_ipa_applied": "specific short note"
  }
}
`.trim();
}
function normaliseSpeakingCorrection({
  modelJson,
  studentName,
  studentLevel,
  moduleNumber,
  unitNumber,
  dayNumber,
  transcriptText,
  speakingPrompt,
  grammarContext,
  feedbackLanguage
}) {
  const raw = modelJson && typeof modelJson === "object" ? modelJson : {};

  const task = clamp(raw.task_achievement_score, 0, 20);
  const grammar = clamp(raw.grammar_score, 0, 20);
  const vocabulary = clamp(raw.vocabulary_score, 0, 15);
  const pronunciation = clamp(raw.pronunciation_score, 0, 20);
  const fluency = clamp(raw.fluency_score, 0, 15);
  const organisation = clamp(raw.organisation_score, 0, 10);

  const score = round(task + grammar + vocabulary + pronunciation + fluency + organisation);

  const pronunciationCorrections = Array.isArray(raw.pronunciation_corrections)
    ? raw.pronunciation_corrections.map(item => ({
        word_or_phrase: cleanText(item && item.word_or_phrase),
        heard_problem: cleanText(item && item.heard_problem),
        target_ipa: cleanText(item && (item.target_ipa || item.target_method_90)),
        practical_reminder: cleanText(item && item.practical_reminder),
        taught_status: cleanText(item && item.taught_status),
        penalized: item && item.penalized === true
      }))
    : [];

  const teacherNotes = raw.teacher_notes_internal && typeof raw.teacher_notes_internal === "object"
    ? raw.teacher_notes_internal
    : {};

  return {
    feedback_language: feedbackLanguage,
    student_level: studentLevel || "",
    module: moduleNumber || "",
    unit: unitNumber || "",
    day: dayNumber || "",

    score,
    task_achievement_score: task,
    grammar_score: grammar,
    vocabulary_score: vocabulary,
    pronunciation_score: pronunciation,
    fluency_score: fluency,
    organisation_score: organisation,

    // Kept for backward compatibility only. The new feedback separates grammar and vocabulary.
    grammar_vocabulary_score: round(grammar + vocabulary),
    clarity_score: organisation,

    good_point: cleanText(raw.good_point),
    to_improve: cleanText(raw.to_improve),
    why: cleanText(raw.why),
    model_answer: cleanText(raw.model_answer),

    task_achievement_comment: cleanText(raw.task_achievement_comment),
    grammar_comment: cleanText(raw.grammar_comment),
    vocabulary_comment: cleanText(raw.vocabulary_comment),
    pronunciation_comment: cleanText(raw.pronunciation_comment),
    fluency_comment: cleanText(raw.fluency_comment),
    organisation_comment: cleanText(raw.organisation_comment),

    pronunciation_corrections: pronunciationCorrections,

    teacher_email_subject: cleanText(raw.teacher_email_subject),

    transcript_text_used: transcriptText || "",
    speaking_prompt_used: speakingPrompt || "",

    teacher_notes_internal: {
      audio_observations: cleanText(teacherNotes.audio_observations),
      transcript_observations: cleanText(teacherNotes.transcript_observations),
      self_correction_observations: cleanText(teacherNotes.self_correction_observations),
      uncertainties: cleanText(teacherNotes.uncertainties),
      penalty_limit_applied: cleanText(teacherNotes.penalty_limit_applied),
      pronunciation_ipa_applied: cleanText(teacherNotes.pronunciation_ipa_applied),
      current_lesson_grammar: grammarContext ? grammarContext.current_lesson_grammar || "" : "",
      previous_grammar_count: grammarContext ? grammarContext.previous_grammar_count || 0 : 0,
      deterministic_formatting_applied: "Markdown layout was built by code. Feedback sentences were generated by AI."
    },

    student_name_internal: cleanText(studentName)
  };
}

function validateRequiredCorrectionFields(correction) {
  const requiredFields = [
    "good_point",
    "to_improve",
    "why",
    "model_answer",
    "task_achievement_comment",
    "grammar_comment",
    "vocabulary_comment",
    "pronunciation_comment",
    "fluency_comment",
    "organisation_comment",
    "teacher_email_subject"
  ];

  requiredFields.forEach(field => {
    assertRequiredFeedbackField(correction[field], field);
  });

  assertRequiredFeedbackField(
    correction.teacher_notes_internal.audio_observations,
    "teacher_notes_internal.audio_observations"
  );

  assertRequiredFeedbackField(
    correction.teacher_notes_internal.transcript_observations,
    "teacher_notes_internal.transcript_observations"
  );

  assertRequiredFeedbackField(
    correction.teacher_notes_internal.penalty_limit_applied,
    "teacher_notes_internal.penalty_limit_applied"
  );

  assertRequiredFeedbackField(
    correction.teacher_notes_internal.pronunciation_ipa_applied,
    "teacher_notes_internal.pronunciation_ipa_applied"
  );

  const pronunciationCorrections = correction.pronunciation_corrections || [];

  if (!Array.isArray(pronunciationCorrections)) {
    throw new Error("pronunciation_corrections must be an array.");
  }

  pronunciationCorrections.forEach((item, index) => {
    assertRequiredFeedbackField(
      item.word_or_phrase,
      `pronunciation_corrections[${index}].word_or_phrase`
    );

    assertRequiredFeedbackField(
      item.heard_problem,
      `pronunciation_corrections[${index}].heard_problem`
    );

    assertRequiredFeedbackField(
      item.target_ipa,
      `pronunciation_corrections[${index}].target_ipa`
    );

    assertRequiredFeedbackField(
      item.practical_reminder,
      `pronunciation_corrections[${index}].practical_reminder`
    );
  });
}
function buildStudentFeedback({
  correction,
  studentName,
  feedbackLanguage
}) {
  const labels = feedbackLanguage === "fr" ? LABELS_FR : LABELS_EN;
  const name = cleanText(studentName || "Student");

  const goodPointText = removeName(correction.good_point, name);
  const goodPointWithName = name
    ? `${name}, ${lowerFirst(goodPointText)}`
    : goodPointText;

  const pronunciationDetails = buildPronunciationCorrectionBlock({
    corrections: correction.pronunciation_corrections || [],
    feedbackLanguage
  });

  const lines = [
    "# Speaking Feedback",
    "",
    `## ${labels.score}: ${correction.score}/100`,
    "",
    `## ${labels.goodPoint}`,
    punctuate(goodPointWithName),
    "",
    `## ${labels.toImprove}`,
    punctuate(removeName(correction.to_improve, name)),
    "",
    `## ${labels.why}`,
    punctuate(removeName(correction.why, name)),
    "",
    `## ${labels.model}`,
    punctuate(removeName(correction.model_answer, name)),
    "",
    "## Score breakdown",
    "",
    "| Criterion | Score | Comment |",
    "|---|---:|---|",
    `| ${labels.task} | ${correction.task_achievement_score}/20 | ${escapeMarkdownTableCell(punctuate(removeName(correction.task_achievement_comment, name)))} |`,
    `| ${labels.grammar} | ${correction.grammar_score}/20 | ${escapeMarkdownTableCell(punctuate(removeName(correction.grammar_comment, name)))} |`,
    `| ${labels.vocabulary} | ${correction.vocabulary_score}/15 | ${escapeMarkdownTableCell(punctuate(removeName(correction.vocabulary_comment, name)))} |`,
    `| ${labels.pronunciation} | ${correction.pronunciation_score}/20 | ${escapeMarkdownTableCell(punctuate(removeName(correction.pronunciation_comment, name)))} |`,
    `| ${labels.fluency} | ${correction.fluency_score}/15 | ${escapeMarkdownTableCell(punctuate(removeName(correction.fluency_comment, name)))} |`,
    `| ${labels.organisationClarity} | ${correction.organisation_score}/10 | ${escapeMarkdownTableCell(punctuate(removeName(correction.organisation_comment, name)))} |`
  ];

  if (pronunciationDetails) {
    lines.push("", pronunciationDetails);
  }

  return cleanText(lines.join("\n")).trim();
}

function buildPronunciationCorrectionBlock({
  corrections,
  feedbackLanguage
}) {
  if (!Array.isArray(corrections) || !corrections.length) {
    return "";
  }

  const labels = feedbackLanguage === "fr" ? LABELS_FR : LABELS_EN;

  const validCorrections = corrections
    .map(item => ({
      word_or_phrase: cleanText(item.word_or_phrase),
      heard_problem: cleanText(item.heard_problem),
      target_ipa: cleanText(item.target_ipa || item.target_method_90),
      practical_reminder: cleanText(item.practical_reminder),
      taught_status: cleanText(item.taught_status),
      penalized: item.penalized === true
    }))
    .filter(item => {
      return item.word_or_phrase &&
             item.heard_problem &&
             item.target_ipa &&
             item.practical_reminder;
    });

  if (!validCorrections.length) {
    return "";
  }

  const lines = [
    `## ${labels.pronunciationDetails}`,
    ""
  ];

  validCorrections.forEach((item, index) => {
    if (feedbackLanguage === "fr") {
      lines.push(
        `### Correction ${index + 1}`,
        `- Mot/expression : **${item.word_or_phrase}**`,
        `- Problème entendu : ${item.heard_problem}`,
        `- Prononciation cible : **${item.target_ipa}**`,
        `- Rappel pratique : ${item.practical_reminder}`,
        ""
      );
    } else {
      lines.push(
        `### Correction ${index + 1}`,
        `- Word/phrase: **${item.word_or_phrase}**`,
        `- Heard problem: ${item.heard_problem}`,
        `- Target pronunciation: **${item.target_ipa}**`,
        `- Practical reminder: ${item.practical_reminder}`,
        ""
      );
    }
  });

  return lines.join("\n").trim();
}

function escapeMarkdownTableCell(value) {
  return String(value || "")
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|")
    .trim();
}
function assertRequiredFeedbackField(value, fieldName) {
  const clean = cleanText(value);

  if (!clean) {
    throw new Error(
      `OpenAI speaking correction missing required feedback field: ${fieldName}. ` +
      `No predefined fallback feedback is allowed.`
    );
  }
}

function chooseAudioForOpenAiFeedback({
  originalAudioBuffer,
  originalFileName,
  originalMimeType,
  wavBuffer,
  wavFileName
}) {
  const originalFormat = getSupportedOpenAiAudioInputFormat({
    fileName: originalFileName,
    mimeType: originalMimeType
  });

  if (originalFormat) {
    return {
      audioBuffer: originalAudioBuffer,
      fileName: originalFileName,
      mimeType: originalMimeType || guessMimeTypeFromFileName(originalFileName)
    };
  }

  if (Buffer.isBuffer(wavBuffer) && wavBuffer.length) {
    return {
      audioBuffer: wavBuffer,
      fileName: wavFileName || "audio.wav",
      mimeType: "audio/wav"
    };
  }

  throw new Error("No supported audio buffer available for OpenAI audio feedback.");
}

function resolveFeedbackLanguage({ studentLevel, moduleNumber }) {
  const level = String(studentLevel || "").trim().toUpperCase();
  const moduleNum = Number(String(moduleNumber || "").replace(/[^\d]/g, ""));

  if (level === "A1" && moduleNum >= 1 && moduleNum <= 4) {
    return "fr";
  }

  return "en";
}

function extractChatCompletionText(raw) {
  return String(raw?.choices?.[0]?.message?.content || "").trim();
}

export function parseJsonFromModelOutput(text) {
  const raw = String(text || "").trim();

  if (!raw) {
    throw new Error("Cannot parse empty model output.");
  }

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

    if (start >= 0 && end > start) {
      const possibleJson = cleaned.slice(start, end + 1);

      try {
        return JSON.parse(possibleJson);
      } catch (secondError) {
        throw new Error(`Model output looked like JSON but could not be parsed. ${secondError.message}`);
      }
    }

    throw new Error(`Model output was not valid JSON. ${firstError.message}`);
  }
}

function parseJsonOrThrow(text, message) {
  try {
    return JSON.parse(String(text || ""));
  } catch (error) {
    throw new Error(`${message} Body preview: ${String(text || "").slice(0, 1200)}`);
  }
}

function getSupportedOpenAiAudioInputFormat({ fileName, mimeType }) {
  const name = String(fileName || "").toLowerCase();
  const type = String(mimeType || "").toLowerCase();

  if (type.includes("audio/mpeg") || type.includes("audio/mp3")) return "mp3";
  if (type.includes("audio/wav") || type.includes("audio/x-wav") || type.includes("audio/wave")) return "wav";

  if (name.endsWith(".mp3")) return "mp3";
  if (name.endsWith(".wav")) return "wav";

  return "";
}

function guessMimeTypeFromFileName(fileName) {
  const name = String(fileName || "").toLowerCase();

  if (name.endsWith(".mp3")) return "audio/mpeg";
  if (name.endsWith(".wav")) return "audio/wav";
  if (name.endsWith(".m4a")) return "audio/mp4";
  if (name.endsWith(".webm")) return "audio/webm";
  if (name.endsWith(".mp4")) return "audio/mp4";
  if (name.endsWith(".mpeg")) return "audio/mpeg";
  if (name.endsWith(".mpga")) return "audio/mpeg";

  return "application/octet-stream";
}

function makeSafeAudioFileName(fileName) {
  const clean = String(fileName || "audio.mp3")
    .replace(/[\\/*?:"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return clean || "audio.mp3";
}

function safePromptJson(value) {
  if (!value) return "";

  try {
    return JSON.stringify(value, null, 2).slice(0, 8000);
  } catch (error) {
    return String(value || "").slice(0, 8000);
  }
}

function clamp(value, min, max) {
  const number = Number(value);

  if (Number.isNaN(number)) return min;

  return Math.max(min, Math.min(max, round(number)));
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function cleanText(value) {
  return String(value || "")
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function punctuate(value) {
  const clean = cleanText(value);

  if (!clean) return "";

  if (/[.!?…]$/.test(clean)) return clean;

  return `${clean}.`;
}

function lowerFirst(value) {
  const clean = cleanText(value);

  if (!clean) return clean;

  return clean.charAt(0).toLowerCase() + clean.slice(1);
}

function removeName(text, studentName) {
  const clean = cleanText(text);
  const name = cleanText(studentName);

  if (!clean || !name) return clean;

  return clean
    .replace(new RegExp(escapeRegex(name), "gi"), "")
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


function getOpenRouterApiKey_() {
  const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is required for audio transcription/speaking correction " +
      "(these now route through OpenRouter instead of api.openai.com directly)."
    );
  }
  return apiKey;
}
