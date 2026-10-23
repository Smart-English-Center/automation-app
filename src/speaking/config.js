const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function clean(value) {
  return String(value ?? "").trim();
}

function integerEnv(name, fallback, { min = 1, max = 1000 } = {}) {
  const parsed = Number(process.env[name]);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function booleanEnv(name, fallback = false) {
  const value = clean(process.env[name]).toLowerCase();
  if (!value) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(value)) return true;
  if (["0", "false", "no", "n", "off"].includes(value)) return false;
  return fallback;
}

function timeEnv(name, fallback) {
  const value = clean(process.env[name]);
  if (!value) return fallback;
  if (!TIME_PATTERN.test(value)) {
    throw new Error(`${name} must use 24-hour HH:MM format.`);
  }
  return value;
}

function csvEnv(name) {
  return [...new Set(clean(process.env[name]).split(/[;,]/).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

export function getSpeakingConfig() {
  const levelSpecificGroupTeacherEmails = {
    A1: csvEnv("SPEAKING_GROUP_A1_TEACHER_EMAILS"),
    A2: csvEnv("SPEAKING_GROUP_A2_TEACHER_EMAILS"),
    B1: csvEnv("SPEAKING_GROUP_B1_TEACHER_EMAILS"),
    B2: csvEnv("SPEAKING_GROUP_B2_TEACHER_EMAILS")
  };
  const legacyGroupTeacherEmails = csvEnv("SPEAKING_GROUP_TEACHER_EMAILS");
  const usesLegacyGroupTeacherFallback = Object.values(levelSpecificGroupTeacherEmails).every((items) => items.length === 0);
  const groupTeacherEmailsByLevel = usesLegacyGroupTeacherFallback
    ? Object.fromEntries(Object.keys(levelSpecificGroupTeacherEmails).map((level) => [level, [...legacyGroupTeacherEmails]]))
    : levelSpecificGroupTeacherEmails;
  const groupTeacherEmails = [...new Set(Object.values(groupTeacherEmailsByLevel).flat())];
  return {
    enabled: booleanEnv("SPEAKING_TOPIC_PIPELINE_ENABLED", false),
    timezone: clean(process.env.SCHEDULER_TIMEZONE || process.env.TZ) || "Africa/Douala",
    cycleCutoffTime: timeEnv("SPEAKING_CYCLE_CUTOFF_TIME", "00:00"),
    studentEmailTime: timeEnv("SPEAKING_STUDENT_EMAIL_TIME", "04:00"),
    teacherDocumentTime: timeEnv("SPEAKING_TEACHER_DOCUMENT_TIME", "06:00"),
    groupBatchSize: integerEnv("SPEAKING_TOPIC_BATCH_SIZE", 10, { min: 1, max: 10 }),
    studentsPerPdfPart: integerEnv("SPEAKING_TEACHER_PDF_STUDENTS_PER_PART", 25, { min: 1, max: 500 }),
    retryMinutes: integerEnv("SPEAKING_TOPIC_RETRY_MINUTES", 5, { min: 5, max: 1440 }),
    groupTeacherEmails,
    groupTeacherEmailsByLevel,
    usesLegacyGroupTeacherFallback,
    profileFormUrl: clean(process.env.SPEAKING_PROFILE_FORM_URL),
    pdfMonkeyTemplateId: clean(process.env.PDFMONKEY_SPEAKING_TEACHER_TEMPLATE_ID),
    driveFolderId: clean(process.env.SPEAKING_TEACHER_DRIVE_FOLDER_ID),
    model: clean(process.env.DEEPSEEK_MODEL) || "deepseek-v4-pro",
    thinkingMode: clean(process.env.DEEPSEEK_THINKING_MODE) || "enabled",
    reasoningEffort: clean(process.env.DEEPSEEK_REASONING_EFFORT) || "high"
  };
}

export function localParts(date = new Date(), timezone = getSpeakingConfig().timezone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday.toUpperCase(),
    time: `${parts.hour}:${parts.minute}`
  };
}

export function timeReached(currentTime, configuredTime) {
  if (!TIME_PATTERN.test(currentTime) || !TIME_PATTERN.test(configuredTime)) return false;
  return currentTime >= configuredTime;
}

export function isSpeakingCycleDay(weekday) {
  return weekday === "MONDAY" || weekday === "FRIDAY";
}

export function normaliseSpeakingCycleDate(value, timezone = getSpeakingConfig().timezone) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error("Speaking cycle date is invalid.");
    return localParts(value, timezone).date;
  }

  const match = clean(value).match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/);
  if (!match) throw new Error("Speaking cycle date must contain a valid YYYY-MM-DD value.");
  return match[1];
}

export function speakingScheduledInstant(cycleDate, time, timezone = getSpeakingConfig().timezone) {
  if (!TIME_PATTERN.test(clean(time))) throw new Error("Speaking delivery time must use 24-hour HH:MM format.");
  const date = normaliseSpeakingCycleDate(cycleDate, timezone);
  const instant = new Date(`${date}T${time}:00+01:00`);
  if (Number.isNaN(instant.getTime())) throw new Error("Speaking delivery timestamp could not be constructed.");
  return instant;
}

export function assertSpeakingCycleConfig(config = getSpeakingConfig()) {
  if (config.timezone !== "Africa/Douala") {
    throw new Error("The installed speaking schema requires SCHEDULER_TIMEZONE=Africa/Douala.");
  }
  return config;
}

export function assertSpeakingRuntimeConfig(config = getSpeakingConfig()) {
  assertSpeakingCycleConfig(config);
  if (!clean(process.env.DEEPSEEK_API_KEY)) throw new Error("Missing DEEPSEEK_API_KEY.");
  if (!config.profileFormUrl) throw new Error("Missing SPEAKING_PROFILE_FORM_URL.");
  if (!config.pdfMonkeyTemplateId) throw new Error("Missing PDFMONKEY_SPEAKING_TEACHER_TEMPLATE_ID.");
  return config;
}
