function clean(value) { return String(value ?? "").trim(); }

function parseJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return JSON.parse(String(value ?? ""));
}

export function countMessageEmojis(message) {
  const source = String(message ?? "");
  const segments = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(source)].map((item) => item.segment)
    : [...source];
  return segments.filter((segment) => /\p{Extended_Pictographic}/u.test(segment)).length;
}

export function validateDigestMessage(expected, message) {
  const text = String(message ?? "");
  const errors = [];
  if (!text.trim()) errors.push("MESSAGE_EMPTY");
  const expectedName = clean(expected?.student_name_for_message);
  if (expectedName && !text.includes(expectedName)) errors.push("STUDENT_NAME_MISSING");
  const greetingWord = clean(expected?.language).toLowerCase() === "fr" ? "Bonjour" : "Hello";
  const expectedGreeting = expectedName ? `${greetingWord} ${expectedName},` : "";
  if (expectedGreeting && !text.trimStart().startsWith(expectedGreeting)) errors.push("REQUIRED_GREETING_MISSING");

  for (const item of expected?.must_deliver || []) {
    const assignmentName = String(item?.assignment_name ?? "");
    const correctionUrl = String(item?.correction_url ?? "");
    if (assignmentName && !text.includes(assignmentName)) errors.push(`ASSIGNMENT_NAME_MISSING:${assignmentName}`);
    if (correctionUrl && !text.includes(correctionUrl)) errors.push(`CORRECTION_URL_MISSING:${correctionUrl}`);
  }

  const participation = expected?.evidence?.assignment_participation || {};
  const requiredLastAssignmentDate = clean(expected?.evidence?.most_recent_assignment_date_for_message);
  const requiresLastAssignmentDate = clean(expected?.context?.digest_day).toUpperCase() === "SUNDAY" &&
    expected?.context?.has_ever_submitted === true &&
    participation.writing_submitted === false &&
    participation.speaking_submitted === false &&
    Boolean(requiredLastAssignmentDate);
  if (requiresLastAssignmentDate && !text.includes(requiredLastAssignmentDate)) {
    errors.push(`LAST_ASSIGNMENT_DATE_MISSING:${requiredLastAssignmentDate}`);
  }

  if (/(^|\n)\s{0,3}#{1,6}(?:\s|$)/u.test(text)) errors.push("MARKDOWN_HEADING_FORBIDDEN");
  if (/(^|\n)\s*(?:[-+•]|\d+[.)])\s+/u.test(text)) errors.push("MARKDOWN_BULLET_FORBIDDEN");
  if (text.includes("*")) errors.push("ASTERISK_FORBIDDEN");

  const questionCount = (text.match(/\?/g) || []).length;
  if (questionCount > 3) errors.push("TOO_MANY_QUESTION_MARKS");
  const emojiCount = countMessageEmojis(text);
  if (emojiCount < 1 || emojiCount > 3) errors.push("EMOJI_COUNT_INVALID");

  const nonEmptyLines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (nonEmptyLines.at(-1) !== "Olivier Tehua") errors.push("MR_JOHN_NOT_FINAL_LINE");
  const signatureIndex = nonEmptyLines.indexOf("Olivier Tehua");
  if (signatureIndex >= 0 && signatureIndex !== nonEmptyLines.length - 1) errors.push("CONTENT_AFTER_MR_JOHN");

  return { ok: errors.length === 0, errors, message: text, question_count: questionCount, emoji_count: emojiCount };
}

export function validateDigestBatchResponse({ expectedBatch, response } = {}) {
  const students = Array.isArray(expectedBatch?.students) ? expectedBatch.students : [];
  const expectedById = new Map(students.map((student) => [clean(student.request_id), student]));
  let parsed;
  try {
    parsed = parseJson(response);
  } catch (error) {
    return {
      ok: false,
      parsed: null,
      batch_errors: ["INVALID_JSON"],
      missing_request_ids: [...expectedById.keys()],
      duplicate_request_ids: [],
      unexpected_request_ids: [],
      valid_messages: [],
      invalid_messages: [...expectedById.keys()].map((request_id) => ({ request_id, errors: ["INVALID_JSON"] })),
      error_message: clean(error?.message)
    };
  }

  const batchErrors = [];
  if (clean(parsed?.batch_id) !== clean(expectedBatch?.batch_id)) batchErrors.push("BATCH_ID_MISMATCH");
  if (!Array.isArray(parsed?.messages)) batchErrors.push("MESSAGES_ARRAY_MISSING");
  const outputs = Array.isArray(parsed?.messages) ? parsed.messages : [];
  const byId = new Map();
  for (const output of outputs) {
    const requestId = clean(output?.request_id);
    if (!byId.has(requestId)) byId.set(requestId, []);
    byId.get(requestId).push(output);
  }

  const duplicateIds = [...byId].filter(([, rows]) => rows.length > 1).map(([requestId]) => requestId);
  const unexpectedIds = [...byId.keys()].filter((requestId) => !expectedById.has(requestId));
  const missingIds = [...expectedById.keys()].filter((requestId) => !byId.has(requestId));
  if (duplicateIds.length) batchErrors.push("DUPLICATE_REQUEST_IDS");
  if (unexpectedIds.length) batchErrors.push("UNEXPECTED_REQUEST_IDS");
  if (missingIds.length) batchErrors.push("MISSING_REQUEST_IDS");
  const expectedOrder = [...expectedById.keys()];
  const actualOrder = outputs.map((output) => clean(output?.request_id));
  if (!duplicateIds.length && !unexpectedIds.length && !missingIds.length &&
      actualOrder.some((requestId, index) => requestId !== expectedOrder[index])) {
    batchErrors.push("ORDER_MISMATCH");
  }

  const fatal = batchErrors.includes("BATCH_ID_MISMATCH") ||
    batchErrors.includes("MESSAGES_ARRAY_MISSING") ||
    batchErrors.includes("UNEXPECTED_REQUEST_IDS") ||
    batchErrors.includes("ORDER_MISMATCH");
  const valid = [];
  const invalid = [];
  for (const [requestId, expected] of expectedById) {
    const rows = byId.get(requestId) || [];
    if (fatal) invalid.push({ request_id: requestId, errors: [...batchErrors] });
    else if (!rows.length) invalid.push({ request_id: requestId, errors: ["REQUEST_ID_MISSING"] });
    else if (rows.length > 1) invalid.push({ request_id: requestId, errors: ["REQUEST_ID_DUPLICATED"] });
    else {
      const checked = validateDigestMessage(expected, rows[0]?.message);
      if (checked.ok) valid.push({ request_id: requestId, ...checked });
      else invalid.push({ request_id: requestId, errors: checked.errors });
    }
  }

  return {
    ok: batchErrors.length === 0 && invalid.length === 0 && valid.length === expectedById.size,
    parsed,
    batch_errors: batchErrors,
    missing_request_ids: missingIds,
    duplicate_request_ids: duplicateIds,
    unexpected_request_ids: unexpectedIds,
    valid_messages: valid,
    invalid_messages: invalid
  };
}
