function cleanStage_(value) {
  const stage = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return stage || "UNKNOWN";
}

function diagnosticValue_(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? { type: "Date", value: "INVALID_DATE" }
      : { type: "Date", value: value.toISOString() };
  }
  if (value === null) return null;
  if (value === undefined) return "UNDEFINED";
  if (["string", "number", "boolean"].includes(typeof value)) {
    return String(value).slice(0, 300);
  }
  return Object.prototype.toString.call(value);
}

function diagnosticContext_(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) return {};
  return Object.fromEntries(
    Object.entries(context).map(([key, value]) => [key, diagnosticValue_(value)])
  );
}

export function teacherDigestWindowDiagnosticContext(window = {}) {
  return {
    cycle_date: window.cycle_date,
    activity_window_start: window.activity_window_start,
    activity_window_end_exclusive: window.activity_window_end_exclusive,
    feedback_window_start: window.feedback_window_start,
    feedback_window_end_exclusive: window.feedback_window_end_exclusive
  };
}

export async function runTeacherDigestStage(stage, operation, context = {}) {
  if (typeof operation !== "function") {
    throw new TypeError("Teacher digest diagnostic stage requires an operation function.");
  }

  try {
    return await operation();
  } catch (error) {
    const originalMessage = String(error?.message || error);
    if (originalMessage.startsWith("TEACHER_DIGEST_STAGE=")) throw error;

    const safeContext = diagnosticContext_(context);
    const contextSuffix = Object.keys(safeContext).length
      ? `; CONTEXT=${JSON.stringify(safeContext)}`
      : "";
    const wrapped = new Error(
      `TEACHER_DIGEST_STAGE=${cleanStage_(stage)}${contextSuffix}; ERROR=${originalMessage}`,
      { cause: error }
    );
    if (error?.code) wrapped.code = error.code;
    throw wrapped;
  }
}
