/******************************************************************
 * openaiStructuredSpeaking.js
 *
 * Compatibility wrapper for the proven JEA speaking-correction layer.
 *
 * Model responsibility:
 * - OpenAI transcription model creates a verbatim learner transcript.
 * - OpenAI audio model receives the actual audio + transcript + task context
 *   and produces the first speaking correction.
 * - DeepSeek review is NOT used here. It remains the second-pass quality
 *   review model in /worker/review/* for both writing and speaking.
 *
 * This wrapper keeps the route-level API used by correctionRepository.js,
 * while delegating the prompt/formatting logic to src/clients/openaiAudio.js,
 * which contains the previously working Apps Script-era speaking prompt.
 ******************************************************************/

import {
  generateJeaSpeakingCorrectionFromAudioWithOpenAi as generateSpeakingCorrectionWithProvenPrompt_,
  getSpeakingAudioModels
} from "./openaiAudio.js";

import {
  downloadOriginalAudioForProcessing,
  downloadAndConvertAudioToWavBuffer
} from "../utils/audioProcessing.js";

// Requests now go through OpenRouter (see src/clients/openaiAudio.js), so the
// model slug needs the "openai/" provider prefix. openaiAudio.js will also
// auto-prefix a bare model name coming from env vars, but we keep this
// default namespaced too for clarity.

export async function generateJeaSpeakingCorrectionFromTranscriptWithOpenAi(args = {}) {
  return generateJeaSpeakingCorrectionWithAudioThenStructuredReview(args);
}

export async function generateJeaSpeakingCorrectionFromAudioWithOpenAiCompat(args = {}) {
  return generateJeaSpeakingCorrectionWithAudioThenStructuredReview(args);
}

// Keep the original export name expected by correctionRepository.js.
export async function generateJeaSpeakingCorrectionFromAudioWithOpenAi(args = {}) {
  return generateJeaSpeakingCorrectionWithAudioThenStructuredReview(args);
}

export async function generateJeaSpeakingCorrectionWithAudioThenStructuredReview({
  transcriptText = "",
  sourceUrl = "",
  audioUrl = "",
  speakingPrompt = "",
  studentName = "Student",
  studentLevel = "",
  moduleNumber = "",
  unitNumber = "",
  dayNumber = "",
  grammarContext = null,
  vocabularyContext = null,
  curriculumContext = null,
  audioModel = getSpeakingAudioModels().model,
  reviewModel = "", // intentionally ignored; DeepSeek review happens later in review routes.
  model = ""
} = {}) {
  void reviewModel;

  const resolvedSourceUrl = String(audioUrl || sourceUrl || "").trim();
  if (!resolvedSourceUrl) {
    throw new Error("Speaking correction requires an audio URL/source. OpenAI audio model must hear the submitted audio.");
  }

  const selectedAudioModel = String(model || audioModel || getSpeakingAudioModels().model).trim() || getSpeakingAudioModels().model;

  const audio = await downloadAudioForOpenAiSpeakingCorrection_({
    sourceUrl: resolvedSourceUrl,
    studentName,
    studentLevel,
    moduleNumber,
    unitNumber,
    dayNumber
  });

  const correction = await generateSpeakingCorrectionWithProvenPrompt_({
    audioBuffer: audio.audioBuffer,
    fileName: audio.fileName,
    mimeType: audio.mimeType,
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
    pronunciationGuide: "",
    feedbackModel: selectedAudioModel
  });

  return {
    provider: "openai",
    mode: "proven_apps_script_prompt_audio_plus_transcript",
    structured_output: false,
    audio_used_for_scoring: true,
    audio_observation_ok: true,
    model_requested: correction.model_requested || selectedAudioModel,
    model_returned: correction.model_returned || "",
    audio_model_requested: correction.model_requested || selectedAudioModel,
    audio_model_returned: correction.model_returned || "",
    parsed_json: correction.parsed_json,
    raw_audio_observation: {
      ok: true,
      notes: "OpenAI audio model received the stored audio plus the verbatim transcript and generated the first speaking correction using the proven JEA prompt.",
      model_requested: correction.model_requested || selectedAudioModel,
      model_returned: correction.model_returned || "",
      source_url_used: resolvedSourceUrl,
      audio_format_used: audio.format,
      audio_mime_type: audio.mimeType,
      audio_byte_length: audio.byteLength,
      audio_source_type: audio.sourceType || "",
      original_audio_filename: audio.fileName,
      conversion_used: Boolean(audio.conversionUsed)
    },
    raw_response: correction.raw_response,
    usage: correction.usage || null
  };
}

async function downloadAudioForOpenAiSpeakingCorrection_({
  sourceUrl,
  studentName = "",
  studentLevel = "",
  moduleNumber = "",
  unitNumber = "",
  dayNumber = ""
}) {
  const lessonKey = [
    studentLevel ? String(studentLevel).trim().toUpperCase() : "",
    moduleNumber ? `M${String(moduleNumber).replace(/[^0-9]/g, "") || moduleNumber}` : "",
    unitNumber ? `U${String(unitNumber).replace(/[^0-9]/g, "") || unitNumber}` : "",
    dayNumber ? `D${String(dayNumber).replace(/[^0-9]/g, "") || dayNumber}` : ""
  ].filter(Boolean).join("_");

  const original = await downloadOriginalAudioForProcessing({
    sourceUrl,
    studentName,
    lessonKey,
    referenceName: "speaking_correction"
  });

  const originalFormat = getSupportedOpenAiAudioInputFormat_({
    fileName: original.original_filename,
    mimeType: original.original_mime_type
  });

  if (originalFormat) {
    return {
      audioBuffer: original.original_buffer,
      fileName: original.original_filename || `speaking-audio.${originalFormat}`,
      mimeType: original.original_mime_type || mimeFromFormat_(originalFormat),
      format: originalFormat,
      byteLength: original.original_buffer.length,
      sourceType: original.source_type || "",
      conversionUsed: false
    };
  }

  const converted = await downloadAndConvertAudioToWavBuffer({
    sourceUrl,
    studentName,
    lessonKey,
    referenceName: "speaking_correction"
  });

  return {
    audioBuffer: converted.wav_buffer,
    fileName: converted.wav_filename || "speaking-audio.wav",
    mimeType: converted.wav_mime_type || "audio/wav",
    format: "wav",
    byteLength: converted.wav_buffer.length,
    sourceType: converted.source_type || "",
    conversionUsed: true
  };
}

function getSupportedOpenAiAudioInputFormat_({ fileName, mimeType }) {
  const name = String(fileName || "").toLowerCase();
  const type = String(mimeType || "").toLowerCase();

  if (type.includes("audio/mpeg") || type.includes("audio/mp3") || name.endsWith(".mp3")) return "mp3";
  if (type.includes("audio/wav") || type.includes("audio/x-wav") || type.includes("audio/wave") || name.endsWith(".wav")) return "wav";

  return "";
}

function mimeFromFormat_(format) {
  return format === "wav" ? "audio/wav" : "audio/mpeg";
}
