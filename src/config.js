import { getSpeakingAudioModels } from "./clients/openaiAudio.js";

const requiredEnvVars = [
  "DATABASE_URL"
];

const optionalEnvVars = [
  "PGSSLMODE",
  "SUPABASE_POOL_MAX",
  "SUPABASE_IDLE_TIMEOUT_MS",
  "SUPABASE_CONNECTION_TIMEOUT_MS",

  "NODE_ENV",
  "PORT",
  "HOST",
  "TZ",
  "SCHEDULER_TIMEZONE",
  "APP_TIMEZONE",
  "DEFAULT_SOURCE_TIMEZONE",
  "MAINTAINER_ALERT_EMAIL",
  "EMAIL_TEST_MODE",
  "EMAIL_TEST_RECIPIENT",
  "EMAIL_TEST_RECIPIENT_NAME",
  "STUDENT_EMAIL_TEST_MODE",
  "STUDENT_EMAIL_TEST_RECIPIENT",
  "STUDENT_EMAIL_TEST_RECIPIENT_NAME",
  "EMAIL_DESIGN_TEST_RECIPIENT",
  "EMAIL_DESIGN_TEST_RECIPIENT_NAME",
  "EMAIL_DESIGN_SAMPLE_CYCLE_DATE",
  "EMAIL_DESIGN_PROGRESS_SAMPLE_LIMIT",
  "EMAIL_DESIGN_PROGRESS_CYCLE_DATE",
  "ACADEMY_WHATSAPP_URL",
  "JEA_ACADEMY_WHATSAPP_URL",
  "JEA_MAINTAINER_ALERT_EMAIL",
  "MAINTAINER_ALERTS_ENABLED",
  "ENABLE_STUDENT_PROGRESS_REPORT_SCHEDULER",
  "CRON_STUDENT_PROGRESS_REPORT_QUEUE",
  "PROGRESS_REPORT_LIMIT",
  "PROGRESS_REPORT_CYCLE_DATE",
  "PROGRESS_REPORT_PERIOD_START",
  "PROGRESS_REPORT_PERIOD_END",
  "PROGRESS_REPORT_TEST_MODE",
  "PROGRESS_REPORT_TEST_RECIPIENT",
  "ENABLE_STUDENT_PROGRESS_REPORT_EMAIL_DELIVERY_SCHEDULER",
  "CRON_STUDENT_PROGRESS_REPORT_EMAIL_DELIVERY",
  "PROGRESS_REPORT_EMAIL_DELIVERY_LIMIT",
  "PROGRESS_REPORT_EMAIL_SOURCE_TYPES",
  "MAINTAINER_TEST_SEVERITY",
  "MAINTAINER_TEST_FINGERPRINT",
  "HEAD_TEACHER_EMAIL",
  "JEA_HEAD_TEACHER_EMAIL",
  "DEFAULT_ACADEMY_WHATSAPP",
  "JEA_SUPPORT_WHATSAPP_NUMBER",

  "REGISTRATION_WEBHOOK_SECRET",
  "REGISTRATION_DECISION_LINK_SECRET",
  "REGISTRATION_MAINTENANCE_SECRET",
  "REGISTRATION_PUBLIC_BASE_URL",
  "REGISTRATION_APPROVER_EMAILS",
  "REGISTRATION_CLASS_DOC_A1_URL",
  "REGISTRATION_CLASS_DOC_A2_URL",
  "REGISTRATION_CLASS_DOC_B1_URL",
  "REGISTRATION_ACADEMY_WHATSAPP_PHONE",
  "REGISTRATION_TRIAL_END_CTA_URL",
  "REGISTRATION_EMAIL_TEST_MODE",
  "REGISTRATION_EMAIL_TEST_RECIPIENT",
  "ENABLE_REGISTRATION_EXPIRY_SCHEDULER",
  "CRON_REGISTRATION_EXPIRY",

  "ENABLE_INTERNAL_SCHEDULER",
  "ENABLE_INTERNAL_WORKER_LOOP",
  "WORKER_ADMIN_TEST_SECRET",
  "WORKER_ADMIN_SECRET",
  "ADMIN_SECRET",

  "OPENAI_API_KEY",
  "OPENAI_REVIEW_MODEL",
  "OPENAI_TRANSCRIPTION_MODEL",
  "OPENAI_AUDIO_FEEDBACK_MODEL",
  "OPENAI_AUDIO_FEEDBACK_FALLBACK_MODEL",
  "OPENAI_SPEAKING_AUDIO_MODEL",
  "OPENAI_SPEAKING_AUDIO_FALLBACK_MODEL",

  // OpenRouter is now the transport for GPT audio transcription + audio
  // feedback (src/clients/openaiAudio.js). OPENAI_API_KEY above is no longer
  // used by that path; OPENROUTER_API_KEY is required instead. The model env
  // vars above still apply, but their values should be OpenRouter slugs
  // (e.g. "openai/gpt-audio", "openai/gpt-4o-transcribe").
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_SITE_URL",
  "OPENROUTER_APP_NAME",

  "DEEPSEEK_API_KEY",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_THINKING_MODE",
  "DEEPSEEK_REASONING_EFFORT",

  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GOOGLE_AUTH_MODE",
  "GOOGLE_REFRESH_TOKEN",
  "GOOGLE_SPREADSHEET_ID",
  "FORM_WEBHOOK_SECRET",
  "GOOGLE_AUDIO_STORAGE_FOLDER_ID",
  "GOOGLE_DRIVE_AUDIO_FOLDER_ID",
  "ENABLE_SOURCE_FORM_RECONCILIATION_SCHEDULER",
  "CRON_SOURCE_FORM_RECONCILIATION",
  "RECONCILE_MAX_ROWS_PER_TAB",
  "RECONCILE_MAX_TABS",
  "RECONCILE_MAX_IMPORTS",
  "RECONCILE_DRY_RUN",
  "ENABLE_AUDIO_DRIVE_STORAGE_SCHEDULER",
  "CRON_AUDIO_DRIVE_STORAGE",
  "AUDIO_STORAGE_LIMIT",
  "ENABLE_CREATE_MISSING_JOBS_SCHEDULER",
  "CRON_CREATE_MISSING_JOBS",
  "CREATE_MISSING_JOBS_LIMIT",

  "BREVO_API_KEY",
  "BREVO_SENDER_NAME",
  "BREVO_SENDER_EMAIL",
  "BREVO_REPLY_TO",
  "EMAIL_QUEUE_LIMIT",
  "EMAIL_DELIVERY_LIMIT",
  "EMAIL_MAX_ATTEMPTS",
  "EMAIL_RETRY_MINUTES",
  "EMAIL_SENDING_STALE_MINUTES",
  "QUEUE_STUDENT_FEEDBACK_EMAILS_BEFORE_SEND",
  "STUDENT_EMAIL_DELIVERY_SOURCE_TYPES",
  "STUDENT_FEEDBACK_EMAIL_SUBJECT_PREFIX",

  "PDFMONKEY_API_KEY",
  "PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID",
  "PDFMONKEY_TEACHER_DIGEST_TEMPLATE_ID",
  "PDFMONKEY_BASE_URL",
  "PDF_REQUIRE_SPEAKING",
  "DEEPSEEK_BASE_URL",
  "SPEAKING_TOPIC_PIPELINE_ENABLED",
  "ENABLE_SPEAKING_TOPIC_PIPELINE_SCHEDULER",
  "CRON_SPEAKING_TOPIC_PIPELINE",
  "ENABLE_SPEAKING_EMAIL_DELIVERY_SCHEDULER",
  "CRON_SPEAKING_EMAIL_DELIVERY",
  "SPEAKING_CYCLE_CUTOFF_TIME",
  "SPEAKING_STUDENT_EMAIL_TIME",
  "SPEAKING_TEACHER_DOCUMENT_TIME",
  "SPEAKING_TOPIC_BATCH_SIZE",
  "SPEAKING_TOPIC_RETRY_MINUTES",
  "SPEAKING_EMAIL_DELIVERY_LIMIT",
  "SPEAKING_TEACHER_PDF_STUDENTS_PER_PART",
  "SPEAKING_GROUP_TEACHER_EMAILS",
  "SPEAKING_GROUP_A1_TEACHER_EMAILS",
  "SPEAKING_GROUP_A2_TEACHER_EMAILS",
  "SPEAKING_GROUP_B1_TEACHER_EMAILS",
  "SPEAKING_GROUP_B2_TEACHER_EMAILS",
  "SPEAKING_PROFILE_FORM_URL",
  "SPEAKING_PROFILE_WEBHOOK_SECRET",
  "SPEAKING_PROFILE_PAYLOAD_ENCRYPTION_KEY",
  "PDFMONKEY_SPEAKING_TEACHER_TEMPLATE_ID",
  "SPEAKING_TEACHER_DRIVE_FOLDER_ID"
];

function getEnv(name, options = {}) {
  const value = process.env[name];

  if (options.required && (!value || !String(value).trim())) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value ? String(value).trim() : "";
}

function getNumberEnv(name, fallback) {
  const value = getEnv(name);
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getBooleanEnv(name, fallback = false) {
  const value = getEnv(name).toLowerCase();
  if (!value) return fallback;

  if (["true", "1", "yes", "y", "on"].includes(value)) return true;
  if (["false", "0", "no", "n", "off"].includes(value)) return false;

  return fallback;
}

function envStatusFor_(key) {
  const value = process.env[key];

  return {
    key,
    configured: Boolean(value && String(value).trim()),
    length: value ? String(value).length : 0
  };
}

export function getConfig() {
  return {
    app: {
      port: getNumberEnv("PORT", 3000),
      host: getEnv("HOST") || "0.0.0.0",
      nodeEnv: getEnv("NODE_ENV") || "development",
      timezone: getEnv("TZ") || getEnv("SCHEDULER_TIMEZONE") || "Africa/Douala",
      schedulerEnabled: getBooleanEnv("ENABLE_INTERNAL_SCHEDULER", false),
      workerLoopEnabled: getBooleanEnv("ENABLE_INTERNAL_WORKER_LOOP", false)
    },

    supabase: {
      databaseUrl: getEnv("DATABASE_URL", { required: true }),
      sslMode: getEnv("PGSSLMODE") || "require",
      poolMax: getNumberEnv("SUPABASE_POOL_MAX", 5),
      idleTimeoutMs: getNumberEnv("SUPABASE_IDLE_TIMEOUT_MS", 30000),
      connectionTimeoutMs: getNumberEnv("SUPABASE_CONNECTION_TIMEOUT_MS", 15000)
    },

    openai: {
      apiKeyConfigured: Boolean(getEnv("OPENAI_API_KEY")),
      reviewModel: getEnv("OPENAI_REVIEW_MODEL") || "gpt-4.1-mini"
    },

    // GPT audio transcription + audio feedback route through OpenRouter now
    // (src/clients/openaiAudio.js), reusing the same OpenAI-made models via
    // OpenRouter's OpenAI-compatible endpoints.
    openrouter: {
      apiKeyConfigured: Boolean(getEnv("OPENROUTER_API_KEY")),
      baseUrl: getEnv("OPENROUTER_BASE_URL") || "https://openrouter.ai/api/v1",
      transcriptionModel: getEnv("OPENAI_TRANSCRIPTION_MODEL") || "openai/gpt-4o-transcribe",
      audioFeedbackModel: getSpeakingAudioModels().model,
      audioFeedbackFallbackModel: getSpeakingAudioModels().fallbackModel
    },

    deepseek: {
      apiKeyConfigured: Boolean(getEnv("DEEPSEEK_API_KEY")),
      model: getEnv("DEEPSEEK_MODEL") || "deepseek-v4-pro",
      thinkingMode: getEnv("DEEPSEEK_THINKING_MODE") || "enabled",
      reasoningEffort: getEnv("DEEPSEEK_REASONING_EFFORT") || "high"
    },

    email: {
      brevoConfigured: Boolean(getEnv("BREVO_API_KEY")),
      senderName: getEnv("BREVO_SENDER_NAME") || "John's English Academy",
      senderEmail: getEnv("BREVO_SENDER_EMAIL"),
      replyTo: getEnv("BREVO_REPLY_TO"),
      queueLimit: getNumberEnv("EMAIL_QUEUE_LIMIT", 10),
      deliveryLimit: getNumberEnv("EMAIL_DELIVERY_LIMIT", 1),
      maxAttempts: getNumberEnv("EMAIL_MAX_ATTEMPTS", 3),
      retryMinutes: getNumberEnv("EMAIL_RETRY_MINUTES", 30)
    },

    pdf: {
      pdfmonkeyConfigured: Boolean(getEnv("PDFMONKEY_API_KEY")),
      studentTemplateIdConfigured: Boolean(getEnv("PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID")),
      teacherDigestTemplateIdConfigured: Boolean(getEnv("PDFMONKEY_TEACHER_DIGEST_TEMPLATE_ID")),
      // When true (default), a student's PDF cannot be assembled until their speaking
      // task has a reviewed or terminal (not-assessed) outcome. Set PDF_REQUIRE_SPEAKING=false
      // in the environment to unblock PDF generation while speaking is having issues;
      // affected students will see a "technical difficulties" placeholder instead of a
      // speaking correction until speaking catches up.
      requireSpeakingForPdf: getBooleanEnv("PDF_REQUIRE_SPEAKING", true),
      speakingUnavailableMessage:
        "we are experiencing technical difficuties to process your speaking task, our team is working to solve the issue as soon as possible."
    },

    imports: {
      formWebhookSecretConfigured: Boolean(getEnv("FORM_WEBHOOK_SECRET")),
      audioDriveFolderConfigured: Boolean(getEnv("GOOGLE_AUDIO_STORAGE_FOLDER_ID") || getEnv("GOOGLE_DRIVE_AUDIO_FOLDER_ID")),
      reconciliationSchedulerEnabled: getBooleanEnv("ENABLE_SOURCE_FORM_RECONCILIATION_SCHEDULER", false),
      audioStorageSchedulerEnabled: getBooleanEnv("ENABLE_AUDIO_DRIVE_STORAGE_SCHEDULER", false),
      createMissingJobsSchedulerEnabled: getBooleanEnv("ENABLE_CREATE_MISSING_JOBS_SCHEDULER", false)
    }
  };
}

export function getEnvironmentStatus() {
  return {
    required_variables: requiredEnvVars.map(envStatusFor_),
    optional_variables: optionalEnvVars.map(envStatusFor_),
    summary: {
      required_configured: requiredEnvVars.every((key) => {
        const value = process.env[key];
        return Boolean(value && String(value).trim());
      }),
      required_count: requiredEnvVars.length,
      optional_count: optionalEnvVars.length
    }
  };
}
