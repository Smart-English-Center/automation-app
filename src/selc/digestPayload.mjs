import { studentFacingName } from "../studentFacingName.js";
import { normaliseQuizPercentage } from "./digestPersonalisation.mjs";

const DIGEST_TIMEZONE = process.env.SCHEDULER_TIMEZONE || process.env.TZ || "UTC";

function clean(value) { return String(value ?? "").trim(); }
function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function percent(value) {
  const parsed = numeric(value);
  return parsed !== null && parsed >= 0 && parsed <= 100 ? Math.round(parsed * 100) / 100 : null;
}
function dateOnly(value) {
  const source = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(source)) return source;
  const parsed = value instanceof Date ? value : new Date(source);
  if (!Number.isFinite(parsed.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: DIGEST_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(parsed).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function dateForMessage(value, language = "en") {
  const iso = dateOnly(value);
  const match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return "";
  const monthIndex = Number(match[2]) - 1;
  const months = clean(language).toLowerCase() === "fr"
    ? ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
    : ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  if (!months[monthIndex]) return "";
  return `${Number(match[3])} ${months[monthIndex]} ${match[1]}`;
}
function moduleNumber(student = {}) {
  const value = numeric(student.module ?? student.current_module ?? student.curriculum_snapshot?.module);
  return value === null ? null : Math.trunc(value);
}
function distinctActivityDates(rows = []) {
  return [...new Set(rows.map((row) => dateOnly(row.submitted_at || row.delivery_sent_at)).filter(Boolean))];
}

function hasWriting(row = {}) {
  return Boolean(clean(row.writing_answer || row.answer_text));
}

function hasSpeaking(row = {}) {
  return Boolean(clean(row.audio_link || row.speakpipe_link));
}

function assignmentParticipationFromSubmissions(rows = [], periodScope = "INTERIM_WINDOW") {
  const writingAssignments = new Set();
  const speakingAssignments = new Set();
  rows.forEach((row, index) => {
    const key = clean(row.assignment_key || row.id) || `row-${index + 1}`;
    if (hasWriting(row)) writingAssignments.add(key);
    if (hasSpeaking(row)) speakingAssignments.add(key);
  });
  return {
    period_scope: periodScope,
    writing_submitted: writingAssignments.size > 0,
    speaking_submitted: speakingAssignments.size > 0,
    writing_assignment_count: writingAssignments.size,
    speaking_assignment_count: speakingAssignments.size
  };
}

function assignmentParticipationFromMetric(metric = {}) {
  const writingCount = Math.max(0, Number(metric.writing_activity_count || 0) || 0);
  const speakingCount = Math.max(0, Number(metric.speaking_activity_count || 0) || 0);
  return {
    period_scope: "COMPLETE_WEEK",
    writing_submitted: writingCount > 0,
    speaking_submitted: speakingCount > 0,
    writing_assignment_count: writingCount,
    speaking_assignment_count: speakingCount
  };
}

function participationClassification(days = []) {
  if (days.length < 2) return "INSUFFICIENT_HISTORY";
  const changes = days.slice(1).map((value, index) => value - days[index]);
  if (changes.every((value) => value >= 0) && changes.some((value) => value > 0)) return "IMPROVING";
  if (changes.every((value) => value <= 0) && changes.some((value) => value < 0)) return "DECLINING";
  const spread = Math.max(...days) - Math.min(...days);
  if (spread <= 1 && Math.min(...days) >= 4) return "STABLE_STRONG";
  if (spread <= 1 && Math.max(...days) < 4) return "STABLE_LOW";
  return "IRREGULAR";
}

function participationPattern(facts = {}, metric = {}) {
  const currentDays = Math.max(0, Number(metric.active_days || 0) || 0);
  const eligibleDays = Math.max(0, Number(metric.eligible_days || 0) || 0);
  const partial = Boolean(metric.is_partial_enrollment_week) || (eligibleDays > 0 && eligibleDays < 7);
  const completeWeeks = (facts.four_week_metrics || [])
    .filter((period) => !period.is_partial_enrollment_week)
    .sort((a, b) => dateOnly(a.week_start).localeCompare(dateOnly(b.week_start)))
    .slice(-4)
    .map((period) => ({
      period_start: dateOnly(period.week_start),
      days_worked: Math.max(0, Number(period.active_days || 0) || 0)
    }));
  const days = completeWeeks.map((period) => period.days_worked);
  let consecutiveBelowFour = 0;
  for (let index = days.length - 1; index >= 0 && days[index] < 4; index -= 1) consecutiveBelowFour += 1;
  const pattern = {
    current_week_days: currentDays,
    recent_complete_weeks: completeWeeks,
    pattern: partial ? "PARTIAL_ENROLMENT_WEEK" : participationClassification(days),
    consecutive_weeks_below_four_days: partial ? 0 : consecutiveBelowFour,
    consistency_priority_next_week: partial ? "BUILD_ROUTINE_GENTLY" : currentDays < 4 ? "STRONGER" : "MAINTAIN_OR_IMPROVE"
  };
  if (!partial && currentDays < 4) pattern.suggested_active_days_next_week = 4;
  return pattern;
}

export function digestLanguageForStudent(student = {}) {
  const explicit = clean(student.language || student.language_code).toLowerCase();
  if (["fr", "en"].includes(explicit)) return explicit;
  return clean(student.level).toUpperCase() === "A1" && (moduleNumber(student) ?? 1) <= 3 ? "fr" : "en";
}

function weeklyResults(facts) {
  const metric = facts.current_metric || {};
  const averages = [
    ["QUIZ", metric.quiz_assessed_count, metric.quiz_average],
    ["WRITING", metric.writing_assessed_count, metric.writing_average],
    ["SPEAKING", metric.speaking_assessed_count, metric.speaking_average]
  ].flatMap(([skill, count, score]) => {
    const value = percent(score);
    return Number(count || 0) > 0 && value !== null
      ? [{ skill, result_type: "WEEKLY_AVERAGE", score_percent: value }]
      : [];
  });
  return [...averages, ...individualFeedbackResults(facts, "ASSESSED_ASSIGNMENT")];
}

function individualFeedbackResults(facts, resultType) {
  const results = [];
  for (const feedback of facts.unseen_feedback || []) {
    const assignmentName = clean(feedback.assignment_key);
    if (!assignmentName) continue;
    const writing = percent(feedback.writing_score);
    const speaking = percent(feedback.speaking_score);
    if (clean(feedback.writing_status).toUpperCase() === "REVIEWED" && writing !== null) {
      results.push({ skill: "WRITING", assignment_name: assignmentName, result_type: resultType, score_percent: writing });
    }
    if (clean(feedback.speaking_status).toUpperCase() === "REVIEWED" && speaking !== null) {
      results.push({ skill: "SPEAKING", assignment_name: assignmentName, result_type: resultType, score_percent: speaking });
    }
  }
  return results;
}

function midweekResults(facts) {
  const quizResults = [];
  for (const quiz of facts.unseen_quizzes || []) {
    const score = percent(normaliseQuizPercentage(quiz));
    if (score !== null) quizResults.push({
      skill: "QUIZ",
      assignment_name: clean(quiz.quiz_key) || "Quiz",
      result_type: "RECENT_ASSESSED_RESULT",
      score_percent: score
    });
  }
  return [...quizResults, ...individualFeedbackResults(facts, "RECENT_ASSESSED_RESULT")];
}

function recentCompletePeriods(facts = {}) {
  return (facts.four_week_metrics || [])
    .filter((metric) => !metric.is_partial_enrollment_week)
    .sort((a, b) => dateOnly(a.week_start).localeCompare(dateOnly(b.week_start)))
    .slice(-4)
    .map((metric) => {
      const period = {
        period_start: dateOnly(metric.week_start),
        period_end: dateOnly(metric.week_end),
        days_worked: Number(metric.active_days || 0)
      };
      for (const skill of ["quiz", "writing", "speaking"]) {
        const count = Number(metric[`${skill}_assessed_count`] || 0);
        const average = percent(metric[`${skill}_average`]);
        if (count > 0 && average !== null) {
          period[`${skill}_assessed_count`] = count;
          period[`${skill}_average_percent`] = average;
        }
      }
      return period;
    });
}

function corrections(facts) {
  const seen = new Set();
  const items = [];
  for (const delivery of facts.feedback_deliveries || []) {
    const correctionUrl = clean(delivery.feedback_link);
    if (!correctionUrl) continue;
    for (const assignment of delivery.assignments || []) {
      const assignmentName = clean(assignment.assignment_key);
      const key = `${assignmentName}\u0000${correctionUrl}`;
      if (!assignmentName || seen.has(key)) continue;
      seen.add(key);
      items.push({ assignment_name: assignmentName, correction_url: correctionUrl });
    }
  }
  return items;
}

function daysSinceEnrolment(student, cycleDate) {
  const start = dateOnly(student.start_date || student.registration_start_at);
  const end = dateOnly(cycleDate);
  if (!start || !end) return null;
  const days = Math.floor((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  return Number.isFinite(days) && days >= 0 ? days : null;
}

export function buildDigestStudentRequest({ requestId, student = {}, facts = {}, window = {} } = {}) {
  const day = clean(window.cycle_day || facts.cycle_day).toUpperCase();
  const complete = day === "SUNDAY";
  const isLastSundayOfMonth = complete && Boolean(facts.is_last_sunday_of_month);
  const metric = facts.current_metric || {};
  const windowSubmissions = facts.window_submissions || [];
  const activityRows = [...windowSubmissions, ...(facts.window_quizzes || [])];
  const evidence = {
    assessed_results: complete ? weeklyResults(facts) : midweekResults(facts),
    days_worked_current_period: complete ? Number(metric.active_days || 0) : distinctActivityDates(activityRows).length,
    assignment_participation: complete
      ? assignmentParticipationFromMetric(metric)
      : assignmentParticipationFromSubmissions(windowSubmissions)
  };
  const hasComparablePreviousPeriod = complete && facts.previous_metric &&
    !metric.is_partial_enrollment_week && !facts.previous_metric.is_partial_enrollment_week;
  if (hasComparablePreviousPeriod) {
    evidence.days_worked_previous_complete_period = Number(facts.previous_metric.active_days || 0);
  }
  const eligibleDays = numeric(metric.eligible_days);
  if (complete && eligibleDays !== null) evidence.days_available_current_period = Math.max(0, Math.trunc(eligibleDays));
  if (!complete && day === "WEDNESDAY") evidence.days_available_current_period = 3;
  if (!complete && day === "FRIDAY") evidence.days_available_current_period = 2;
  if (complete) evidence.participation_pattern = participationPattern(facts, metric);
  if (facts.last_submission_at) evidence.most_recent_learning_activity_date = dateOnly(facts.last_submission_at);
  if (facts.last_assignment_at) {
    const lastAssignmentDate = dateOnly(facts.last_assignment_at);
    const lastAssignmentDateForMessage = dateForMessage(facts.last_assignment_at, digestLanguageForStudent(student));
    if (lastAssignmentDate) evidence.most_recent_assignment_date = lastAssignmentDate;
    if (lastAssignmentDateForMessage) evidence.most_recent_assignment_date_for_message = lastAssignmentDateForMessage;
  }
  if (facts.last_writing_at) evidence.most_recent_writing_submission_date = dateOnly(facts.last_writing_at);
  if (facts.last_speaking_at) evidence.most_recent_speaking_submission_date = dateOnly(facts.last_speaking_at);

  if (isLastSundayOfMonth) {
    const periods = recentCompletePeriods(facts);
    if (periods.length) evidence.recent_complete_periods = periods;
  }

  const context = {
    digest_day: day,
    reporting_period_complete: complete,
    reporting_period_description: day === "WEDNESDAY" ? "Since the Sunday digest" : day === "FRIDAY" ? "Since the Wednesday digest" : "Completed Sunday-to-Saturday reporting period",
    level: clean(student.level),
    module: moduleNumber(student),
    days_since_enrolment: daysSinceEnrolment(student, window.cycle_date || facts.cycle_date),
    has_ever_submitted: Boolean(facts.has_ever_submitted)
  };
  if (isLastSundayOfMonth) context.is_last_sunday_of_month = true;
  for (const key of Object.keys(context)) if (context[key] === null || context[key] === "") delete context[key];

  const requestIdValue = clean(requestId);
  const name = studentFacingName(student.student_name || student.full_name || student.recipient_name, "");
  if (!requestIdValue) throw new Error("A digest request_id is required.");
  if (!name) throw new Error(`Student ${clean(student.student_id) || requestIdValue} has no reliable student-facing name.`);

  return {
    request_id: requestIdValue,
    student_name_for_message: name,
    language: digestLanguageForStudent(student),
    context,
    evidence,
    must_deliver: corrections(facts)
  };
}

export function buildDigestBatch(input = {}) {
  const { students = [] } = input;
  const value = clean(input.batch_id);
  if (!value) throw new Error("A DeepSeek digest batch_id is required.");
  if (!Array.isArray(students) || !students.length) throw new Error("A DeepSeek digest batch requires at least one student.");
  const normalisedStudents = students.map((student) => ({
    request_id: clean(student?.request_id),
    student_name_for_message: clean(student?.student_name_for_message),
    language: clean(student?.language).toLowerCase(),
    context: student?.context && typeof student.context === "object" && !Array.isArray(student.context) ? student.context : {},
    evidence: student?.evidence && typeof student.evidence === "object" && !Array.isArray(student.evidence) ? student.evidence : {},
    must_deliver: Array.isArray(student?.must_deliver)
      ? student.must_deliver.map((item) => ({
        assignment_name: clean(item?.assignment_name),
        correction_url: clean(item?.correction_url)
      }))
      : []
  }));
  const requestIds = normalisedStudents.map((student) => student.request_id);
  if (normalisedStudents.some((student) => !student.request_id || !student.student_name_for_message)) {
    throw new Error("Every DeepSeek digest student requires request_id and student_name_for_message.");
  }
  if (normalisedStudents.some((student) => !["en", "fr"].includes(student.language))) {
    throw new Error("Every DeepSeek digest student language must be en or fr.");
  }
  if (new Set(requestIds).size !== requestIds.length) throw new Error("DeepSeek digest request_id values must be unique.");
  if (normalisedStudents.some((student) => student.must_deliver.some((item) => !item.assignment_name || !item.correction_url))) {
    throw new Error("Every must_deliver item requires assignment_name and correction_url.");
  }
  return {
    batch_id: value,
    students: normalisedStudents
  };
}

export function partitionDigestItems(items = [], batchSize = 10) {
  if (!Array.isArray(items)) throw new Error("DeepSeek digest items must be an array.");
  const size = Number(batchSize);
  if (!Number.isInteger(size) || size < 1 || size > 25) {
    throw new Error("DeepSeek digest batch size must be an integer from 1 to 25.");
  }
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
