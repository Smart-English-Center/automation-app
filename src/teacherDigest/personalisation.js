export const TEACHER_DIGEST_TIMEZONE = "Africa/Douala";

const DAY_MS = 86_400_000;

function clean_(value) {
  return String(value ?? "").trim();
}

function numberOrNull_(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clamp_(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function dateOnly_(value) {
  // node-postgres returns timestamptz as Date objects; JSON previews use strings.
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return "";
    value = value.toISOString();
  }
  const source = clean_(value);
  if (/[T ]\d{2}:\d{2}/.test(source)) {
    const instant = new Date(source);
    if (Number.isNaN(instant.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: TEACHER_DIGEST_TIMEZONE
    }).formatToParts(instant);
    const valueFor = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
  }

  const raw = source.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return "";
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? "" : raw;
}

function dateMs_(value) {
  const date = dateOnly_(value);
  return date ? Date.parse(`${date}T00:00:00.000Z`) : Number.NaN;
}

function scoreValue_(value) {
  const number = numberOrNull_(value);
  return number === null ? "" : `${Math.round(number * 100) / 100}/100`;
}

function timestampDate_(value) {
  return dateOnly_(value);
}

function isWithin_(value, start, end) {
  const date = timestampDate_(value);
  return Boolean(date && date >= start && date <= end);
}

function isMeaningful_(value) {
  return Boolean(clean_(value));
}

function hasWriting_(submission = {}) {
  return isMeaningful_(submission.writing_answer) || isMeaningful_(submission.answer_text);
}

function hasSpeaking_(submission = {}) {
  return isMeaningful_(submission.audio_link) || isMeaningful_(submission.speakpipe_link);
}

function isMeaningfulSubmission_(submission = {}) {
  return hasWriting_(submission) || hasSpeaking_(submission);
}

function latestByKey_(rows, keyForRow) {
  const result = new Map();
  for (const row of rows || []) {
    const key = keyForRow(row);
    if (!key) continue;
    const previous = result.get(key);
    const rowTime = clean_(row.submitted_at || row.updated_at || row.created_at);
    const previousTime = clean_(previous?.submitted_at || previous?.updated_at || previous?.created_at);
    if (!previous || rowTime >= previousTime) result.set(key, row);
  }
  return [...result.values()];
}

function assessmentState_(status, score, problemCode = "") {
  if (clean_(problemCode).toUpperCase() === "SPEAKING_PROCESSING_DELAYED") return "PENDING";
  const upper = clean_(status).toUpperCase();
  if (upper === "REVIEWED" && numberOrNull_(score) !== null) return "ASSESSED";
  if (["NOT_ASSESSED", "BAD_SUBMISSION", "PARTIAL_FEEDBACK"].includes(upper)) return "NOT_ASSESSED";
  return "PENDING";
}

export function addCalendarDays(value, days) {
  const millis = dateMs_(value);
  if (!Number.isFinite(millis)) throw new Error(`Invalid calendar date: ${value}`);
  return new Date(millis + Number(days) * DAY_MS).toISOString().slice(0, 10);
}

export function completedWeekForSunday(cycleDate) {
  const cycle = dateOnly_(cycleDate);
  if (!cycle || new Date(`${cycle}T00:00:00.000Z`).getUTCDay() !== 0) {
    throw new Error("A Sunday cycle date is required to calculate the completed Sunday-to-Saturday week.");
  }

  return {
    week_start: addCalendarDays(cycle, -7),
    week_end: addCalendarDays(cycle, -1)
  };
}

export function isLastSundayOfMonth(cycleDate) {
  const cycle = dateOnly_(cycleDate);
  if (!cycle) return false;
  const date = new Date(`${cycle}T00:00:00.000Z`);
  return date.getUTCDay() === 0 && new Date(date.getTime() + 7 * DAY_MS).getUTCMonth() !== date.getUTCMonth();
}

export function groupFeedbackDeliveries(rows = []) {
  const groups = new Map();
  for (const row of rows || []) {
    const key = clean_(row.delivery_key || row.email_queue_id || row.feedback_link || row.pdf_drive_url || row.id);
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        delivery_key: key,
        email_queue_id: row.email_queue_id || null,
        feedback_link: clean_(row.feedback_link || row.pdf_drive_url),
        sent_at: row.delivery_sent_at || row.email_sent_at || row.updated_at || "",
        assignments: []
      });
    }
    const group = groups.get(key);
    group.assignments.push({
      id: row.id,
      assignment_key: clean_(row.assignment_key),
      writing_score: numberOrNull_(row.writing_score),
      speaking_score: numberOrNull_(row.speaking_score)
    });
    if (!group.feedback_link) group.feedback_link = clean_(row.feedback_link || row.pdf_drive_url);
    if (!group.sent_at) group.sent_at = row.delivery_sent_at || row.email_sent_at || row.updated_at || "";
  }

  return [...groups.values()]
    .map((group) => {
      group.assignments.sort((a, b) => a.assignment_key.localeCompare(b.assignment_key));
      group.assignment_keys = group.assignments.map((item) => item.assignment_key).filter(Boolean);
      group.assignment_count = group.assignment_keys.length;
      group.scores_display = group.assignments.map((item) => {
        const scores = [];
        if (item.writing_score !== null) scores.push(`writing ${scoreValue_(item.writing_score)}`);
        if (item.speaking_score !== null) scores.push(`speaking ${scoreValue_(item.speaking_score)}`);
        return scores.length ? `${item.assignment_key}: ${scores.join(", ")}` : item.assignment_key;
      }).join("; ");
      group.feedback_returned_label = "Yes — one PDF/email delivery";
      return group;
    })
    .sort((a, b) => clean_(a.sent_at).localeCompare(clean_(b.sent_at)) || a.delivery_key.localeCompare(b.delivery_key));
}

export function normaliseQuizPercentage(row = {}) {
  const percentage = numberOrNull_(row.percentage);
  if (percentage !== null && percentage >= 0 && percentage <= 100) return clamp_(percentage, 0, 100);

  const score = numberOrNull_(row.score);
  const maximum = numberOrNull_(row.max_score);
  if (score !== null && maximum !== null && maximum > 0) return clamp_((score * 100) / maximum, 0, 100);
  if (score !== null && score >= 0 && score <= 100) return score;
  return null;
}

export function calculateWeeklyMetric({ student, weekStart, submissions = [], quizzes = [], feedback = [] } = {}) {
  const week_start = dateOnly_(weekStart);
  const week_end = addCalendarDays(week_start, 6);
  const enrollmentStart = dateOnly_(student?.start_date || student?.registration_start_at || week_start) || week_start;
  const eligible_start_date = enrollmentStart > week_start ? enrollmentStart : week_start;
  if (eligible_start_date > week_end) return null;

  const eligible_days = Math.round((dateMs_(week_end) - dateMs_(eligible_start_date)) / DAY_MS) + 1;
  const allRelevantSubmissions = (submissions || []).filter((row) => isWithin_(row.submitted_at, eligible_start_date, week_end));
  const meaningfulSubmissions = allRelevantSubmissions.filter(isMeaningfulSubmission_);
  const allRelevantQuizzes = (quizzes || []).filter((row) => isWithin_(row.submitted_at, eligible_start_date, week_end));
  const relevantSubmissions = latestByKey_(
    meaningfulSubmissions,
    (row) => clean_(row.assignment_key || row.id)
  );
  const relevantQuizzes = latestByKey_(
    allRelevantQuizzes,
    (row) => clean_(row.quiz_key || row.id)
  );
  const feedbackByAssignment = new Map(
    latestByKey_(feedback, (row) => clean_(row.assignment_key || row.submission_id || row.id))
      .map((row) => [clean_(row.assignment_key || row.submission_id || row.id), row])
  );

  const activityDates = new Set(meaningfulSubmissions.map((row) => timestampDate_(row.submitted_at)).filter(Boolean));
  const quizScores = [];
  let writingActivityCount = 0;
  let speakingActivityCount = 0;
  let writingAssessedCount = 0;
  let speakingAssessedCount = 0;
  let writingNotAssessedCount = 0;
  let speakingNotAssessedCount = 0;
  let writingPendingCount = 0;
  let speakingPendingCount = 0;
  const writingScores = [];
  const speakingScores = [];

  for (const quiz of allRelevantQuizzes) activityDates.add(timestampDate_(quiz.submitted_at));

  for (const quiz of relevantQuizzes) {
    const score = normaliseQuizPercentage(quiz);
    if (score !== null) quizScores.push(score);
  }

  for (const submission of relevantSubmissions) {
    const hasWriting = hasWriting_(submission);
    const hasSpeaking = hasSpeaking_(submission);
    const feedbackRow = feedbackByAssignment.get(clean_(submission.assignment_key || submission.id)) || {};
    if (hasWriting) {
      writingActivityCount += 1;
      const state = assessmentState_(feedbackRow.writing_status, feedbackRow.writing_score);
      if (state === "ASSESSED") {
        writingAssessedCount += 1;
        writingScores.push(Number(feedbackRow.writing_score));
      } else if (state === "NOT_ASSESSED") writingNotAssessedCount += 1;
      else writingPendingCount += 1;
    }

    if (hasSpeaking) {
      speakingActivityCount += 1;
      const state = assessmentState_(feedbackRow.speaking_status, feedbackRow.speaking_score, feedbackRow.speaking_problem_code);
      if (state === "ASSESSED") {
        speakingAssessedCount += 1;
        speakingScores.push(Number(feedbackRow.speaking_score));
      } else if (state === "NOT_ASSESSED") speakingNotAssessedCount += 1;
      else speakingPendingCount += 1;
    }
  }

  const average = (values) => values.length
    ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100
    : null;
  const allActivity = [
    ...meaningfulSubmissions.map((row) => row.submitted_at),
    ...allRelevantQuizzes.map((row) => row.submitted_at)
  ].filter(Boolean).sort();

  return {
    student_id: student.student_id,
    enrollment_id: student.enrollment_id || null,
    teacher_id: student.teacher_id || null,
    week_start,
    week_end,
    timezone: TEACHER_DIGEST_TIMEZONE,
    eligible_start_date,
    eligible_days,
    is_partial_enrollment_week: eligible_start_date > week_start,
    active_days: activityDates.size,
    activity_dates: [...activityDates].filter(Boolean).sort(),
    quiz_activity_count: relevantQuizzes.length,
    writing_activity_count: writingActivityCount,
    speaking_activity_count: speakingActivityCount,
    quiz_assessed_count: quizScores.length,
    writing_assessed_count: writingAssessedCount,
    speaking_assessed_count: speakingAssessedCount,
    quiz_not_assessed_count: relevantQuizzes.length - quizScores.length,
    writing_not_assessed_count: writingNotAssessedCount,
    speaking_not_assessed_count: speakingNotAssessedCount,
    quiz_pending_count: 0,
    writing_pending_count: writingPendingCount,
    speaking_pending_count: speakingPendingCount,
    quiz_average: average(quizScores),
    writing_average: average(writingScores),
    speaking_average: average(speakingScores),
    last_activity_at: allActivity.at(-1) || null,
    last_quiz_at: allRelevantQuizzes.map((row) => row.submitted_at).filter(Boolean).sort().at(-1) || null,
    last_writing_at: meaningfulSubmissions.filter(hasWriting_).map((row) => row.submitted_at).sort().at(-1) || null,
    last_speaking_at: meaningfulSubmissions.filter(hasSpeaking_).map((row) => row.submitted_at).sort().at(-1) || null
  };
}

export function hasThreeCompleteInactiveDays({ cycleDate, lastActivityAt, enrollmentStart }) {
  const cycle = dateOnly_(cycleDate);
  const eligibilityStart = dateOnly_(enrollmentStart);
  if (!cycle || !eligibilityStart || eligibilityStart > addCalendarDays(cycle, -3)) return false;
  const last = dateOnly_(lastActivityAt);
  return !last || last <= addCalendarDays(cycle, -4);
}

export function isQuizOnlyFollowUp({ cycleDate, submissions = [], quizzes = [] }) {
  const end = addCalendarDays(cycleDate, -1);
  const start = addCalendarDays(cycleDate, -7);
  const recentQuiz = quizzes.some((row) => isWithin_(row.submitted_at, start, end));
  const recentAssignment = submissions.some((row) =>
    isWithin_(row.submitted_at, start, end) && isMeaningfulSubmission_(row)
  );
  return recentQuiz && !recentAssignment;
}
