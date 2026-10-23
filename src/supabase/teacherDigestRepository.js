import crypto from "node:crypto";
import { studentFacingName } from "../studentFacingName.js";
import { applyTeacherDigestCatchUpWindow, buildTeacherDigestWindow } from "../cycleWindows.js";
import { createPdfMonkeyDocument, waitForPdfMonkeyDocument } from "../pdfmonkeyClient.js";
import { uploadPdfUrlToGoogleDrive } from "../google/driveClient.js";
import { withSupabaseClient } from "./client.js";
import {
  buildTeacherDigestEvidence
} from "./teacherDigestPersonalisationRepository.js";
import {
  ensureValidatedTeacherDigestMessages,
  linkDeepSeekRunToDigestRun
} from "./teacherDigestDeepSeekRepository.js";
import { buildDigestBatch, buildDigestStudentRequest } from "../teacherDigest/deepseekPayload.js";
import { TEACHER_DIGEST_PROMPT_VERSION } from "../teacherDigest/deepseekPrompt.js";
import {
  runTeacherDigestStage,
  teacherDigestWindowDiagnosticContext
} from "../teacherDigest/diagnosticStage.js";

const REAL_SOURCE_TYPE = "TEACHER_PROGRESS_DIGEST";
const TEST_SOURCE_TYPE = "TEACHER_PROGRESS_DIGEST_TEST";
const DEFAULT_STUDENTS_PER_PDF = 25;
const ACTIVE_NEGATIVE_STATUSES = [
  "INACTIVE",
  "DROPPED",
  "CANCELLED",
  "CANCELED",
  "ARCHIVED",
  "DISABLED",
  "SUSPENDED",
  "ENDED",
  "COMPLETED"
];


function nowIso_() {
  return new Date().toISOString();
}

function clean_(value) {
  return String(value ?? "").trim();
}

function cleanLower_(value) {
  return clean_(value).toLowerCase();
}

function normaliseLimit_(value, fallback = 1, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function hashKey_(parts) {
  return crypto.createHash("sha256").update(parts.map(clean_).join("|")).digest("hex").slice(0, 32);
}

async function withDigestAdvisoryLock_(client, lockKey, callback) {
  const acquiredResult = await client.query(
    `select pg_try_advisory_lock(hashtext($1)) as acquired`,
    [lockKey]
  );
  if (!acquiredResult.rows[0]?.acquired) {
    return {
      ok: true,
      status: "DIGEST_OPERATION_ALREADY_IN_PROGRESS",
      lock_key: lockKey,
      checked_at: nowIso_()
    };
  }
  try {
    return await callback();
  } finally {
    await client.query(`select pg_advisory_unlock(hashtext($1))`, [lockKey]);
  }
}

function quoteIdent_(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function getTableColumns_(client, tableName) {
  const result = await client.query(
    `select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [tableName]
  );
  return new Map(result.rows.map((row) => [row.column_name, row.data_type]));
}

function pickColumn_(columns, candidates) {
  return candidates.find((candidate) => columns.has(candidate)) || "";
}

function inactiveStatusFilter_(alias, column, param = 1) {
  return `(
    ${alias}.${quoteIdent_(column)} is null
    or nullif(trim(${alias}.${quoteIdent_(column)}::text), '') is null
    or upper(trim(${alias}.${quoteIdent_(column)}::text)) <> all($${param}::text[])
  )`;
}

function booleanActiveFilter_(alias, column) {
  return `coalesce(${alias}.${quoteIdent_(column)}, true) is true`;
}

function activeFilters_(alias, columns, param = 1) {
  const filters = [];
  const statusColumn = pickColumn_(columns, ["status", "student_status", "teacher_status", "enrollment_status"]);
  const activeColumn = pickColumn_(columns, ["is_active", "active"]);
  if (statusColumn) filters.push(inactiveStatusFilter_(alias, statusColumn, param));
  if (activeColumn) filters.push(booleanActiveFilter_(alias, activeColumn));
  return filters;
}

function shortName_(name, fallback = "") {
  const parts = clean_(name).split(/\s+/).filter(Boolean);
  if (!parts.length) return fallback;
  return parts.slice(0, 2).map(capitaliseNamePart_).join(" ");
}

function firstName_(name, fallback = "student") {
  return capitaliseNamePart_(clean_(name).split(/\s+/).filter(Boolean)[0] || fallback);
}

function capitaliseNamePart_(value) {
  const clean = clean_(value).toLowerCase();
  return clean ? clean.charAt(0).toUpperCase() + clean.slice(1) : "";
}

function safeFilenamePart_(value, fallback = "Teacher") {
  const cleaned = clean_(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return cleaned || fallback;
}

function buildTeacherDigestFilename_(teacherName, cycleDate, partNumber, totalParts) {
  const base = `${safeFilenamePart_(teacherName, "Teacher")}-TPD-${cycleDate}`;
  if (Number(totalParts) <= 1) return `${base}.pdf`;
  return `${base}-Part_${String(partNumber).padStart(2, "0")}_of_${String(totalParts).padStart(2, "0")}.pdf`;
}

function chunk_(items, size) {
  const output = [];
  for (let index = 0; index < items.length; index += size) {
    output.push(items.slice(index, index + size));
  }
  return output.length ? output : [[]];
}

function normalisePhoneForWhatsApp_(value) {
  const digits = clean_(value).replace(/[^0-9]+/g, "");
  if (!digits) return "";
  if (digits.startsWith("237")) return digits;
  if (digits.length === 9) return `237${digits}`;
  return digits;
}

function buildWhatsAppUrl_(phone, message) {
  const cleanPhone = normalisePhoneForWhatsApp_(phone);
  if (!cleanPhone) return "";
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
}

function displayNameForWhatsApp_(student, languageCode) {
  const displayName = studentFacingName(student.student_name || student.recipient_name);
  if (displayName) return displayName;

  const explicitFirstName = clean_(student.first_name || student.student_first_name);
  if (explicitFirstName) return capitaliseNamePart_(explicitFirstName);

  return languageCode === "fr" ? "" : "";
}

function feedbackLinkForAssignments_(assignments = []) {
  for (const assignment of assignments || []) {
    const link = clean_(assignment.feedback_link || assignment.pdf_drive_url || assignment.pdf_url || assignment.pdf_file_url);
    if (link) return link;
  }
  return "";
}

function scoreDisplay_(value, max = 100) {
  if (value === null || value === undefined || value === "") return "";
  return `${value}/${max}`;
}

function percentageDisplay_(score, maxScore, percentage) {
  if (percentage !== null && percentage !== undefined && percentage !== "") {
    const value = Number(percentage);
    if (Number.isFinite(value)) return `${Math.round(value)}%`;
    return clean_(percentage);
  }
  const scoreNumber = Number(score);
  const maxNumber = Number(maxScore);
  if (Number.isFinite(scoreNumber) && Number.isFinite(maxNumber) && maxNumber > 0) {
    return `${Math.round((scoreNumber / maxNumber) * 100)}%`;
  }
  return "";
}

async function loadTeachers_(client, options = {}) {
  const teacherColumns = await getTableColumns_(client, "teachers");
  const enrollmentColumns = await getTableColumns_(client, "enrollments");
  const studentColumns = await getTableColumns_(client, "students");
  const emailColumn = pickColumn_(teacherColumns, ["email", "teacher_email", "email_address"]);
  const nameColumn = pickColumn_(teacherColumns, ["teacher_name", "full_name", "name"]);
  const phoneColumn = pickColumn_(teacherColumns, ["whatsapp_number", "whatsapp", "phone", "phone_number", "teacher_phone"]);
  const studentEmailColumn = pickColumn_(studentColumns, ["email", "student_email", "email_address"]);
  const requireActiveStudents = options.requireActiveStudents !== false && options.require_active_students !== false;

  if (!emailColumn) throw new Error("teachers email column not found.");

  const filters = [`nullif(trim(t.${quoteIdent_(emailColumn)}::text), '') is not null`, ...activeFilters_("t", teacherColumns, 1)];
  const params = [ACTIVE_NEGATIVE_STATUSES];

  if (requireActiveStudents) {
    if (!studentEmailColumn) throw new Error("students email column not found.");
    if (!enrollmentColumns.has("student_id") || !enrollmentColumns.has("teacher_id")) {
      throw new Error("enrollments.student_id and enrollments.teacher_id are required for teacher digest.");
    }

    const studentFilters = [
      `e.teacher_id = t.id`,
      `nullif(trim(s.${quoteIdent_(studentEmailColumn)}::text), '') is not null`,
      ...activeFilters_("s", studentColumns, 1),
      ...activeFilters_("e", enrollmentColumns, 1)
    ];

    filters.push(`exists (
      select 1
      from enrollments e
      join students s on s.id = e.student_id
      where ${studentFilters.join(" and ")}
    )`);
  }

  if (options.teacherId || options.teacher_id) {
    params.push(clean_(options.teacherId || options.teacher_id));
    filters.push(`t.id = $${params.length}::uuid`);
  }

  if (options.teacherEmail || options.teacher_email) {
    params.push(cleanLower_(options.teacherEmail || options.teacher_email));
    filters.push(`lower(trim(t.${quoteIdent_(emailColumn)}::text)) = $${params.length}`);
  }

  params.push(normaliseLimit_(options.limit, 1, 500));

  const nameExpression = nameColumn
    ? `coalesce(nullif(trim(t.${quoteIdent_(nameColumn)}::text), ''), nullif(trim(t.${quoteIdent_(emailColumn)}::text), ''), 'Teacher')`
    : `coalesce(nullif(trim(t.${quoteIdent_(emailColumn)}::text), ''), 'Teacher')`;
  const phoneExpression = phoneColumn ? `nullif(trim(t.${quoteIdent_(phoneColumn)}::text), '')` : `null::text`;

  const result = await client.query(
    `
      select
        t.id as teacher_id,
        ${nameExpression} as teacher_name,
        lower(trim(t.${quoteIdent_(emailColumn)}::text)) as teacher_email,
        ${phoneExpression} as teacher_phone
      from teachers t
      where ${filters.join(" and ")}
      order by teacher_name asc, t.id
      limit $${params.length}
    `,
    params
  );

  return result.rows;
}

async function loadStudentsForTeacher_(client, teacherId) {
  const studentColumns = await getTableColumns_(client, "students");
  const enrollmentColumns = await getTableColumns_(client, "enrollments");
  const emailColumn = pickColumn_(studentColumns, ["email", "student_email", "email_address"]);
  const nameColumn = pickColumn_(studentColumns, ["full_name", "student_name", "name"]);
  const firstNameColumn = pickColumn_(studentColumns, ["first_name", "firstname", "given_name"]);
  const phoneColumn = pickColumn_(studentColumns, ["whatsapp_number", "whatsapp", "phone", "phone_number", "student_phone"]);
  const enrollmentLevelColumn = pickColumn_(enrollmentColumns, ["level", "student_level", "current_level", "level_snapshot", "cefr_level"]);
  const studentLevelColumn = pickColumn_(studentColumns, ["level", "current_level", "level_snapshot", "cefr_level"]);

  if (!emailColumn) throw new Error("students email column not found.");
  if (!enrollmentColumns.has("student_id") || !enrollmentColumns.has("teacher_id")) {
    throw new Error("enrollments.student_id and enrollments.teacher_id are required for teacher digest.");
  }

  const filters = [
    `e.teacher_id = $2::uuid`,
    `nullif(trim(s.${quoteIdent_(emailColumn)}::text), '') is not null`,
    ...activeFilters_("s", studentColumns, 1),
    ...activeFilters_("e", enrollmentColumns, 1)
  ];

  const nameExpression = nameColumn
    ? `coalesce(nullif(trim(s.${quoteIdent_(nameColumn)}::text), ''), nullif(trim(s.${quoteIdent_(emailColumn)}::text), ''), 'Student')`
    : `coalesce(nullif(trim(s.${quoteIdent_(emailColumn)}::text), ''), 'Student')`;
  const firstNameExpression = firstNameColumn ? `nullif(trim(s.${quoteIdent_(firstNameColumn)}::text), '')` : `null::text`;
  const phoneExpression = phoneColumn ? `nullif(trim(s.${quoteIdent_(phoneColumn)}::text), '')` : `null::text`;
  const levelCandidates = [
    enrollmentLevelColumn ? `nullif(trim(e.${quoteIdent_(enrollmentLevelColumn)}::text), '')` : "",
    studentLevelColumn ? `nullif(trim(s.${quoteIdent_(studentLevelColumn)}::text), '')` : ""
  ].filter(Boolean);
  const levelExpression = levelCandidates.length ? `coalesce(${levelCandidates.join(", ")})` : `null::text`;

  const result = await client.query(
    `
      select distinct on (s.id)
        s.id as student_id,
        e.id as enrollment_id,
        e.teacher_id,
        e.start_date,
        ${nameExpression} as student_name,
        ${firstNameExpression} as first_name,
        lower(trim(s.${quoteIdent_(emailColumn)}::text)) as student_email,
        ${phoneExpression} as student_phone,
        ${levelExpression} as level,
        latest_progress.current_module
      from enrollments e
      join students s on s.id = e.student_id
      left join lateral (
        select si.module as current_module
        from submission_inbox si
        where si.student_id = s.id
          and si.submitted_at is not null
          and si.module is not null
          and upper(coalesce(si.status, '')) not in ('SUPERSEDED', 'INVALID', 'DELETED')
          and (
            nullif(btrim(coalesce(si.writing_answer, '')), '') is not null
            or nullif(btrim(coalesce(si.answer_text, '')), '') is not null
            or nullif(btrim(coalesce(si.audio_link, '')), '') is not null
            or nullif(btrim(coalesce(si.speakpipe_link, '')), '') is not null
          )
        order by si.submitted_at desc, si.id desc
        limit 1
      ) latest_progress on true
      where ${filters.join(" and ")}
      order by s.id, e.start_date desc nulls last, e.id
    `,
    [ACTIVE_NEGATIVE_STATUSES, teacherId]
  );

  return result.rows;
}

async function resolveTeacherDigestWindow_(client, teacherId, nominalWindow, options = {}) {
  if (options.disableCatchUp || options.disable_catch_up) {
    return applyTeacherDigestCatchUpWindow(nominalWindow, {
      snapshotAt: options.snapshotAt || options.snapshot_at
    });
  }

  const previous = await runTeacherDigestStage("LOAD_PREVIOUS_CHECKPOINT", () => client.query(
    `
      select
        r.id as teacher_digest_run_id,
        r.activity_window_end_exclusive,
        eq.sent_at as digest_sent_at,
        nullif(r.payload_json -> 'window' ->> 'snapshot_at', '') as feedback_checkpoint_at
      from teacher_digest_runs r
      join email_queue eq
        on eq.id = r.email_queue_id
       and upper(coalesce(eq.status, '')) = 'SENT'
       and eq.source_type = $3
      where r.teacher_id = $1::uuid
        and r.test_mode = false
        and r.cycle_date < $2::date
        and r.activity_window_end_exclusive is not null
      order by r.cycle_date desc, eq.sent_at desc nulls last, r.updated_at desc
      limit 1
    `,
    [teacherId, nominalWindow.cycle_date, REAL_SOURCE_TYPE]
  ), teacherDigestWindowDiagnosticContext(nominalWindow));
  const last = previous.rows[0] || {};
  return applyTeacherDigestCatchUpWindow(nominalWindow, {
    previousActivityEnd: last.activity_window_end_exclusive,
    previousDigestSentAt: last.feedback_checkpoint_at || last.activity_window_end_exclusive,
    snapshotAt: options.snapshotAt || options.snapshot_at
  });
}

async function findExistingProductionRun_(client, teacherId, cycleKey) {
  const result = await client.query(
    `
      select r.*, eq.status as email_status, eq.sent_at
      from teacher_digest_runs r
      left join email_queue eq
        on eq.id = r.email_queue_id
       and eq.source_type = $3
      where r.teacher_id = $1::uuid
        and r.cycle_key = $2
        and r.test_mode = false
      limit 1
    `,
    [teacherId, cycleKey, REAL_SOURCE_TYPE]
  );
  return result.rows[0] || null;
}

async function loadAssignmentSubmissionStats_(client, studentIds, window) {
  if (!studentIds.length) return new Map();
  const columns = await getTableColumns_(client, "submission_inbox");
  const studentColumn = pickColumn_(columns, ["student_id"]);
  const dateColumn = pickColumn_(columns, ["submitted_at", "created_at", "timestamp", "updated_at"]);
  if (!studentColumn || !dateColumn) return new Map();

  const result = await client.query(
    `
      select
        si.${quoteIdent_(studentColumn)} as student_id,
        count(*)::integer as assignment_submission_count,
        max(si.${quoteIdent_(dateColumn)}) as last_assignment_submission_at
      from submission_inbox si
      where si.${quoteIdent_(studentColumn)} = any($1::uuid[])
        and si.${quoteIdent_(dateColumn)} >= $2::timestamptz
        and si.${quoteIdent_(dateColumn)} < $3::timestamptz
        and upper(coalesce(si.status, '')) not in ('SUPERSEDED', 'INVALID', 'DELETED')
      group by si.${quoteIdent_(studentColumn)}
    `,
    [studentIds, window.activity_window_start, window.activity_window_end_exclusive]
  );

  return new Map(result.rows.map((row) => [String(row.student_id), row]));
}

async function loadQuizScores_(client, studentIds, window) {
  if (!studentIds.length) return new Map();
  const columns = await getTableColumns_(client, "quiz_scores");
  const studentColumn = pickColumn_(columns, ["student_id"]);
  const dateColumn = pickColumn_(columns, ["submitted_at", "created_at", "timestamp", "updated_at"]);
  if (!studentColumn || !dateColumn) return new Map();

  const result = await client.query(
    `
      select *
      from quiz_scores qs
      where qs.${quoteIdent_(studentColumn)} = any($1::uuid[])
        and qs.${quoteIdent_(dateColumn)} >= $2::timestamptz
        and qs.${quoteIdent_(dateColumn)} < $3::timestamptz
        and upper(coalesce(qs.status, '')) not in ('SUPERSEDED', 'INVALID', 'DELETED')
      order by qs.${quoteIdent_(dateColumn)} asc
    `,
    [studentIds, window.activity_window_start, window.activity_window_end_exclusive]
  );

  const scoreColumn = pickColumn_(columns, ["score", "quiz_score", "points", "raw_score"]);
  const maxColumn = pickColumn_(columns, ["max_score", "total_score", "total", "points_possible"]);
  const percentageColumn = pickColumn_(columns, ["percentage", "percent", "score_percentage"]);
  const keyColumn = pickColumn_(columns, ["quiz_key", "assignment_key", "source_key", "form_title", "title"]);

  const byStudentAndKey = new Map();
  for (const row of result.rows) {
    const studentId = String(row[studentColumn]);
    const score = scoreColumn ? row[scoreColumn] : "";
    const max = maxColumn ? row[maxColumn] : "";
    const quiz = {
      quiz_key: keyColumn ? clean_(row[keyColumn]) : clean_(row.id) || "Quiz",
      score_display: max ? scoreDisplay_(score, max) : clean_(score),
      percentage_display: percentageDisplay_(score, max, percentageColumn ? row[percentageColumn] : ""),
      submitted_at: row[dateColumn] || ""
    };
    if (!byStudentAndKey.has(studentId)) byStudentAndKey.set(studentId, new Map());
    byStudentAndKey.get(studentId).set(quiz.quiz_key, quiz);
  }

  return new Map(
    [...byStudentAndKey].map(([studentId, quizzes]) => [
      studentId,
      [...quizzes.values()].sort((a, b) => clean_(a.submitted_at).localeCompare(clean_(b.submitted_at)))
    ])
  );
}

function sentFeedbackParagraph_(deliveries) {
  if (!deliveries.length) return "No feedback PDF/email has been sent to this student since the previous successful digest.";
  const assignmentCount = deliveries.reduce((sum, delivery) => sum + Number(delivery.assignment_count || 0), 0);
  const deliveryLabel = deliveries.length === 1 ? "1 feedback PDF/email" : `${deliveries.length} feedback PDF/emails`;
  const assignmentLabel = assignmentCount === 1 ? "1 assignment" : `${assignmentCount} assignments`;
  const details = deliveries.map((delivery) => delivery.scores_display).filter(Boolean).join(" | ");
  return `The student received ${deliveryLabel} covering ${assignmentLabel}.${details ? ` Scores: ${details}.` : ""}`;
}

async function buildTeacherPayloadBase_(client, teacher, window, options = {}) {
  const windowContext = teacherDigestWindowDiagnosticContext(window);
  const activeStudents = await runTeacherDigestStage(
    "LOAD_ACTIVE_STUDENTS",
    () => loadStudentsForTeacher_(client, teacher.teacher_id),
    windowContext
  );
  const studentIds = activeStudents.map((student) => student.student_id).filter(Boolean);
  const assignmentStats = await runTeacherDigestStage(
    "LOAD_ASSIGNMENT_STATS",
    () => loadAssignmentSubmissionStats_(client, studentIds, window),
    windowContext
  );
  const quizScores = await runTeacherDigestStage(
    "LOAD_WINDOW_QUIZZES",
    () => loadQuizScores_(client, studentIds, window),
    windowContext
  );
  const evidenceItems = await runTeacherDigestStage(
    "BUILD_DEEPSEEK_EVIDENCE",
    () => buildTeacherDigestEvidence(client, {
      students: activeStudents,
      teacher,
      window,
      options
    }),
    windowContext
  );
  const evidenceByStudent = new Map(
    evidenceItems.map((item) => [String(item.student_id), item])
  );
  const deepSeek = options.generateDeepSeekMessages && evidenceItems.length
    ? await runTeacherDigestStage(
      "GENERATE_AND_VALIDATE_DEEPSEEK_MESSAGES",
      () => ensureValidatedTeacherDigestMessages(client, {
        teacher,
        window,
        evidenceItems,
        options,
        dependencies: options.deepSeekDependencies || {}
      }),
      windowContext
    )
    : null;
  const generatedByStudent = new Map(
    (deepSeek?.messages || [])
      .filter((row) => ["VALIDATED", "INCLUDED"].includes(clean_(row.status).toUpperCase()))
      .map((row) => [String(row.student_id), row])
  );

  const students = activeStudents.map((student, index) => {
    const id = String(student.student_id);
    const assignment = assignmentStats.get(id) || {};
    const quizzes = quizScores.get(id) || [];
    const evidenceItem = evidenceByStudent.get(id) || {};
    const feedback = evidenceItem.facts?.unseen_feedback || [];
    const feedbackDeliveries = evidenceItem.facts?.feedback_deliveries || [];
    const unseenQuizzes = evidenceItem.facts?.unseen_quizzes || [];
    const assignmentCount = Number(assignment.assignment_submission_count || 0);
    const quizCount = quizzes.length;
    const feedbackCount = feedbackDeliveries.length;
    const hasAssignment = assignmentCount > 0;
    const hasQuiz = quizCount > 0;
    const hasFeedback = feedbackCount > 0;
    const needsInactivityFollowUp = Boolean(evidenceItem.facts?.inactivity_eligible);
    const needsQuizOnlyFollowUp = Boolean(evidenceItem.facts?.quiz_only_eligible);
    const needsFollowUp = needsInactivityFollowUp || needsQuizOnlyFollowUp;
    const periodStatus = needsInactivityFollowUp
      ? "NO_SUBMISSION_FOLLOW_UP"
      : needsQuizOnlyFollowUp
        ? "QUIZ_ONLY_FOLLOW_UP"
        : hasAssignment
          ? "ACTIVE_WITH_ASSIGNMENT"
          : hasFeedback
            ? "FEEDBACK_ONLY"
            : "GENERAL_OBSERVATION";

    const feedbackLink = feedbackLinkForAssignments_(feedbackDeliveries);
    const message = generatedByStudent.get(id) || {};
    const suggested = clean_(message.message_text);
    const candidateWaUrl = suggested ? buildWhatsAppUrl_(student.student_phone, suggested) : "";
    const messageBudgetExceeded = false;
    const waUrl = messageBudgetExceeded ? "" : candidateWaUrl;
    const waDisplayName = displayNameForWhatsApp_(student) || firstName_(student.student_name);
    const waLabel = `Message ${waDisplayName} on WhatsApp`;
    const waLinkStatus = waUrl
      ? "AVAILABLE"
      : messageBudgetExceeded
        ? "MESSAGE_EXCEEDS_SAFE_BUDGET"
        : suggested
          ? "PHONE_MISSING"
          : "MESSAGE_EMPTY";
    const submissionActivityCount = assignmentCount + quizCount;
    const activityOrFeedbackCount = submissionActivityCount + feedbackCount;

    return {
      row_number: index + 1,
      student_id: student.student_id,
      student_name: student.student_name,
      student_short_name: shortName_(student.student_name, "Student"),
      student_first_name: displayNameForWhatsApp_(student) || firstName_(student.student_name),
      first_name: student.first_name || "",
      student_email: student.student_email,
      student_phone: student.student_phone || "",
      level: student.level || "",
      assignment_submission_count: assignmentCount,
      quiz_submission_count: quizCount,
      feedback_email_count: feedbackCount,
      counted_activity_count: submissionActivityCount,
      activity_or_feedback_count: activityOrFeedbackCount,
      has_assignment_activity: hasAssignment,
      has_quiz_activity: hasQuiz,
      has_feedback_sent: hasFeedback,
      has_activity_or_feedback: !needsFollowUp && (activityOrFeedbackCount > 0 || Boolean(suggested)),
      needs_teacher_follow_up: needsFollowUp,
      needs_inactivity_follow_up: needsInactivityFollowUp,
      needs_quiz_only_follow_up: needsQuizOnlyFollowUp,
      last_submission_at: evidenceItem.facts?.last_submission_at || "",
      last_assignment_submission_at: assignment.last_assignment_submission_at || "",
      last_quiz_submission_at: quizzes.length ? quizzes[quizzes.length - 1].submitted_at : "",
      period_status: periodStatus,
      assignment_feedback_sent: feedbackDeliveries,
      assignment_feedback_items: feedback,
      quiz_scores: unseenQuizzes,
      sent_feedback_paragraph: sentFeedbackParagraph_(feedbackDeliveries),
      feedback_link: feedbackLink,
      suggested_whatsapp_message: suggested,
      suggested_whatsapp_message_mode: suggested ? "DEEPSEEK" : "NONE",
      suggested_whatsapp_message_character_count: suggested.length,
      suggested_whatsapp_encoded_text_character_count: suggested ? encodeURIComponent(suggested).length : 0,
      estimated_whatsapp_url_character_count: candidateWaUrl.length,
      whatsapp_message_budget: {},
      whatsapp_message_budget_exceeded: messageBudgetExceeded,
      whatsapp_url: waUrl,
      whatsapp_url_character_count: waUrl.length,
      whatsapp_link_status: waLinkStatus,
      whatsapp_link_label: waLabel,
      whatsapp_link_html: waUrl ? `<a href="${waUrl}">${waLabel}</a>` : ""
    };
  });

  const needsEncouragement = students.filter((student) => student.needs_teacher_follow_up);
  const studentsWithActivity = students.filter((student) => student.has_activity_or_feedback);
  const feedbackOnlyStudents = students.filter((student) => student.has_feedback_sent && !student.has_assignment_activity && !student.has_quiz_activity);
  const assignmentActiveStudents = students.filter((student) => student.has_assignment_activity);
  const quizOnlyStudents = students.filter((student) => student.needs_quiz_only_follow_up);
  const feedbackEmailsSentCount = students.reduce((sum, student) => sum + student.assignment_feedback_sent.length, 0);
  const assignmentSubmissionCount = students.reduce((sum, student) => sum + student.assignment_submission_count, 0);
  const quizSubmissionCount = students.reduce((sum, student) => sum + student.quiz_submission_count, 0);

  const payload = {
    academy: {
      name: process.env.ACADEMY_NAME || "John's English Academy"
    },
    document: {
      title: "Teacher Progress Digest",
      template_version: "JEA_TEACHER_PROGRESS_DIGEST_V2",
      cycle_date: window.cycle_date,
      cycle_day: window.cycle_day,
      cycle_key: window.cycle_key,
      window_start: window.window_start,
      window_end: window.window_end,
      activity_window_start: window.activity_window_start,
      activity_window_end_exclusive: window.activity_window_end_exclusive,
      feedback_window_start: window.feedback_window_start,
      feedback_window_end_exclusive: window.feedback_window_end_exclusive,
      catch_up_applied: Boolean(window.catch_up_applied),
      nominal_activity_window_start: window.nominal_activity_window_start || window.activity_window_start,
      snapshot_at: window.snapshot_at || "",
      window_days_and_dates: window.window_days_and_dates,
      window_days_and_dates_fr: window.window_days_and_dates_fr || "",
      window_range_en: window.window_range_en || "",
      window_range_fr: window.window_range_fr || "",
      whatsapp_template_source: `deepseek:${TEACHER_DIGEST_PROMPT_VERSION}`
    },
    teacher: {
      teacher_id: teacher.teacher_id,
      teacher_name: teacher.teacher_name,
      teacher_email: teacher.teacher_email,
      teacher_phone: teacher.teacher_phone || ""
    },
    summary: {
      active_student_count: students.length,
      students_with_activity_count: studentsWithActivity.length,
      students_with_submission_activity_count: students.filter((student) => student.counted_activity_count > 0).length,
      students_without_activity_count: students.filter((student) => student.needs_inactivity_follow_up).length,
      students_needing_follow_up_count: needsEncouragement.length,
      active_assignment_student_count: assignmentActiveStudents.length,
      quiz_only_student_count: quizOnlyStudents.length,
      feedback_sent_only_student_count: feedbackOnlyStudents.length,
      assignment_submission_count: assignmentSubmissionCount,
      quiz_submission_count: quizSubmissionCount,
      feedback_emails_sent_count: feedbackEmailsSentCount,
      compacted_whatsapp_message_count: students.filter((student) => student.suggested_whatsapp_message_mode === "COMPACT_FEEDBACK").length,
      whatsapp_message_budget_exceeded_count: students.filter((student) => student.whatsapp_message_budget_exceeded).length
    },
    sections: {
      needs_encouragement: needsEncouragement,
      no_activity: needsEncouragement,
      students_with_activity: studentsWithActivity,
      activity_or_feedback: studentsWithActivity
    },
    all_students: students,
    students: studentsWithActivity
  };

  Object.defineProperty(payload, "_evidenceItems", {
    value: evidenceItems,
    enumerable: false
  });
  Object.defineProperty(payload, "_deepSeek", {
    value: deepSeek,
    enumerable: false
  });

  return payload;
}

function buildChunkPayloads_(basePayload, studentsPerPdf) {
  const chunks = chunk_(basePayload.all_students, studentsPerPdf);
  const totalParts = chunks.length;
  return chunks.map((allStudents, index) => {
    const partNumber = index + 1;
    const startIndex = index * studentsPerPdf + 1;
    const endIndex = index * studentsPerPdf + allStudents.length;
    const studentIdsInChunk = new Set(allStudents.map((student) => String(student.student_id)));
    const studentsWithActivity = basePayload.sections.students_with_activity.filter((student) => studentIdsInChunk.has(String(student.student_id)));
    const needsEncouragement = basePayload.sections.needs_encouragement.filter((student) => studentIdsInChunk.has(String(student.student_id)));

    return {
      ...basePayload,
      document: {
        ...basePayload.document,
        part_number: partNumber,
        total_parts: totalParts,
        student_start_index: startIndex,
        student_end_index: endIndex,
        student_range_label: `Students ${startIndex}–${endIndex}`,
        title: totalParts > 1
          ? `Teacher Progress Digest — Part ${partNumber} of ${totalParts}`
          : "Teacher Progress Digest"
      },
      sections: {
        ...basePayload.sections,
        needs_encouragement: needsEncouragement,
        no_activity: needsEncouragement,
        students_with_activity: studentsWithActivity,
        activity_or_feedback: studentsWithActivity
      },
      all_students: allStudents,
      students: studentsWithActivity
    };
  });
}

function buildDigestEmail_(teacher, window, pdfs, options = {}) {
  const testEmail = cleanLower_(options.testRecipientEmail || options.test_recipient_email);
  const subjectBase = "Teacher Progress Digest";
  const subject = pdfs.length > 1
    ? `${subjectBase} — ${window.cycle_date} — ${pdfs.length} PDF parts`
    : `${subjectBase} — ${window.cycle_date}`;
  const linksHtml = pdfs.map((pdf) => `<li style="margin:0 0 8px;"><a href="${escapeHtml_(pdf.pdf_drive_url)}" style="color:#1d4ed8;font-weight:bold;">${escapeHtml_(pdf.pdf_filename)}</a> <span style="color:#6b7280;">${escapeHtml_(pdf.student_range_label || "")}</span></li>`).join("\n");
  const linksText = pdfs.map((pdf) => `- ${pdf.pdf_filename}: ${pdf.pdf_drive_url}`).join("\n");

  const bodyHtml = `
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${escapeHtml_(subject)}</title></head>
  <body style="margin:0;padding:0;background:#eef4ff;font-family:Arial,Helvetica,sans-serif;color:#111827;">
    <div style="max-width:720px;margin:0 auto;padding:28px 14px;">
      <div style="background:#ffffff;border-radius:18px;border:1px solid #dbeafe;overflow:hidden;box-shadow:0 10px 30px rgba(30,64,175,0.10);">
        <div style="background:#1d4ed8;color:#ffffff;padding:22px 24px;">
          <div style="font-size:12px;letter-spacing:0.14em;text-transform:uppercase;opacity:0.86;">John's English Academy</div>
          <h1 style="font-family:'Trebuchet MS',Arial,Helvetica,sans-serif;font-size:24px;margin:8px 0 0;">${escapeHtml_(subjectBase)}</h1>
        </div>
        <div style="padding:24px;">
          <p>Hello ${escapeHtml_(shortName_(teacher.teacher_name, "Teacher"))},</p>
          <p>Your teacher progress digest for <strong>${escapeHtml_(window.cycle_date)}</strong> is ready.</p>
          <p>This report covers: <strong>${escapeHtml_(window.window_days_and_dates)}</strong>.</p>
          ${pdfs.length > 1 ? `<p>Because you have many active students, the report has been divided into <strong>${pdfs.length} PDF parts</strong> for easier reading.</p>` : ""}
          <ul style="padding-left:20px;margin:18px 0;">${linksHtml}</ul>
          <p style="color:#374151;">Please review the students who need encouragement and contact them kindly when needed.</p>
          <p>John's English Academy</p>
        </div>
      </div>
    </div>
  </body>
</html>
`.trim();

  const bodyText = [
    "John's English Academy",
    `Hello ${shortName_(teacher.teacher_name, "Teacher")},`,
    `Your teacher progress digest for ${window.cycle_date} is ready.`,
    `This report covers: ${window.window_days_and_dates}.`,
    pdfs.length > 1 ? `The report has been divided into ${pdfs.length} PDF parts for easier reading.` : "",
    linksText,
    "Please review the students who need encouragement and contact them kindly when needed.",
    "John's English Academy"
  ].filter(Boolean).join("\n\n");

  return {
    subject,
    body_html: bodyHtml,
    body_text: bodyText,
    recipient_email: testEmail || teacher.teacher_email,
    recipient_name: testEmail ? clean_(options.testRecipientName || options.test_recipient_name || "John Test") : teacher.teacher_name
  };
}

function escapeHtml_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function insertEmailQueue_(client, teacher, window, pdfs, options = {}) {
  const testEmail = cleanLower_(options.testRecipientEmail || options.test_recipient_email);
  const sourceType = testEmail ? TEST_SOURCE_TYPE : REAL_SOURCE_TYPE;
  const email = buildDigestEmail_(teacher, window, pdfs, options);
  const bccEmail = teacherDigestBccEmail_();
  const idempotencyKey = testEmail
    ? `teacher-digest-test:${window.cycle_key}:${teacher.teacher_id}:${hashKey_([testEmail])}`
    : `teacher-digest:${window.cycle_key}:${teacher.teacher_id}`;

  const result = await client.query(
    `
      insert into email_queue (
        source_type,
        source_id,
        idempotency_key,
        status,
        recipient_email,
        recipient_name,
        subject,
        body_html,
        body_text,
        payload_json,
        provider,
        created_at,
        updated_at
      ) values (
        $1,
        $2::uuid,
        $3,
        'QUEUED',
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb,
        'BREVO',
        now(),
        now()
      )
      on conflict (idempotency_key) do update
      set
        status = case
          when email_queue.status = 'SENT' then email_queue.status
          when email_queue.status = 'FAILED' then 'QUEUED'
          else email_queue.status
        end,
        attempt_count = case when email_queue.status = 'FAILED' then 0 else email_queue.attempt_count end,
        next_attempt_at = case when email_queue.status = 'FAILED' then null else email_queue.next_attempt_at end,
        last_attempt_at = case when email_queue.status = 'FAILED' then null else email_queue.last_attempt_at end,
        locked_at = case when email_queue.status = 'FAILED' then null else email_queue.locked_at end,
        locked_by = case when email_queue.status = 'FAILED' then null else email_queue.locked_by end,
        error_code = case when email_queue.status = 'FAILED' then null else email_queue.error_code end,
        error_message = case when email_queue.status = 'FAILED' then null else email_queue.error_message end,
        updated_at = now(),
        recipient_email = case when email_queue.status = 'SENT' then email_queue.recipient_email else excluded.recipient_email end,
        recipient_name = case when email_queue.status = 'SENT' then email_queue.recipient_name else excluded.recipient_name end,
        subject = case when email_queue.status = 'SENT' then email_queue.subject else excluded.subject end,
        body_html = case when email_queue.status = 'SENT' then email_queue.body_html else excluded.body_html end,
        body_text = case when email_queue.status = 'SENT' then email_queue.body_text else excluded.body_text end,
        payload_json = case when email_queue.status = 'SENT' then email_queue.payload_json else excluded.payload_json end
      returning id, source_type, status, recipient_email, recipient_name, subject,
                attempt_count, next_attempt_at, error_code, error_message,
                created_at, updated_at, sent_at
    `,
    [
      sourceType,
      teacher.teacher_id,
      idempotencyKey,
      email.recipient_email,
      email.recipient_name,
      email.subject,
      email.body_html,
      email.body_text,
      JSON.stringify({
        source: "teacher-progress-digest",
        test_mode: Boolean(testEmail),
        teacher,
        cycle: window,
        pdfs,
        bcc_email_configured: Boolean(bccEmail),
        bcc_email: bccEmail
      })
    ]
  );
  return {
    ...result.rows[0],
    bcc_email_configured: Boolean(bccEmail)
  };
}

async function createAndUploadPdf_(client, teacher, payload, filename) {
  const teacherTemplateId = requireTeacherDigestTemplateId_();
  const teacherFolderId = teacherDigestDriveFolderId_();

  const createResult = await createPdfMonkeyDocument(payload, {
    templateId: teacherTemplateId,
    documentTemplateId: teacherTemplateId,
    requireExplicitTemplateId: true,
    filename,
    meta: {
      source_type: REAL_SOURCE_TYPE,
      document_type: "TEACHER_PROGRESS_DIGEST",
      teacher_id: teacher.teacher_id,
      cycle_date: payload.document.cycle_date,
      part_number: payload.document.part_number,
      total_parts: payload.document.total_parts
    }
  });

  const ready = await waitForPdfMonkeyDocument(createResult.document_id, {
    timeoutMs: Number(process.env.TEACHER_DIGEST_PDFMONKEY_WAIT_TIMEOUT_MS || process.env.PDFMONKEY_WAIT_TIMEOUT_MS || 180000),
    intervalMs: Number(process.env.TEACHER_DIGEST_PDFMONKEY_WAIT_INTERVAL_MS || process.env.PDFMONKEY_WAIT_INTERVAL_MS || 5000)
  });

  const drive = await uploadPdfUrlToGoogleDrive(ready.download_url, {
    filename,
    folderId: teacherFolderId
  });

  return {
    pdfmonkey_document_id: createResult.document_id,
    pdf_drive_url: drive.drive_url,
    google_drive_file_id: drive.drive_file_id,
    google_drive_folder_id: drive.folder_id || teacherFolderId,
    pdf_filename: drive.filename || filename
  };
}

function requireTeacherDigestTemplateId_() {
  const value = clean_(process.env.PDFMONKEY_TEACHER_DIGEST_TEMPLATE_ID);

  if (!value) {
    throw new Error(
      "Missing PDFMONKEY_TEACHER_DIGEST_TEMPLATE_ID. Teacher digest PDFs must use the teacher digest PDFMonkey template and must not fall back to the student feedback template."
    );
  }

  return value;
}

function teacherDigestDriveFolderId_() {
  return clean_(
    process.env.GOOGLE_TEACHER_DIGEST_PDF_FOLDER_ID ||
    process.env.GOOGLE_TEACHER_DIGEST_FOLDER_ID ||
    process.env.TEACHER_DIGEST_GOOGLE_DRIVE_FOLDER_ID ||
    ""
  );
}

function teacherDigestBccEmail_() {
  return cleanLower_(
    process.env.TEACHER_DIGEST_BCC_EMAIL ||
      process.env.HEAD_TEACHER_EMAIL ||
      process.env.JEA_HEAD_TEACHER_EMAIL ||
      ""
  );
}

export async function getTeacherDigestSummary(options = {}) {
  return withSupabaseClient(async (client) => {
    const window = buildTeacherDigestWindow(options);
    const runSummary = await client.query(
      `select status, test_mode, count(*)::integer as row_count from teacher_digest_runs group by status, test_mode order by status, test_mode`
    );
    const jobSummary = await client.query(
      `select status, count(*)::integer as row_count from teacher_digest_pdf_jobs group by status order by status`
    );
    const emailSummary = await client.query(
      `
        select source_type, status, count(*)::integer as row_count
        from email_queue
        where source_type in ($1, $2)
        group by source_type, status
        order by source_type, status
      `,
      [REAL_SOURCE_TYPE, TEST_SOURCE_TYPE]
    );
    return {
      ok: true,
      status: "TEACHER_DIGEST_SUMMARY",
      current_window: window,
      runs: runSummary.rows,
      pdf_jobs: jobSummary.rows,
      email_queue: emailSummary.rows,
      checked_at: nowIso_()
    };
  });
}

export async function previewTeacherDigestPayload(options = {}) {
  const window = buildTeacherDigestWindow(options);
  const force = Boolean(options.force || options.force_run);
  if (!window.should_run && !force) {
    return { ok: true, status: "SKIPPED_NOT_DIGEST_DAY", window, payloads: [], checked_at: nowIso_() };
  }

  return withSupabaseClient(async (client) => {
    const teachers = await runTeacherDigestStage(
      "LOAD_TEACHERS",
      () => loadTeachers_(client, { ...options, limit: 1 }),
      { cycle_date: window.cycle_date }
    );
    if (!teachers.length) return { ok: true, status: "NO_ACTIVE_TEACHER", window, payloads: [], checked_at: nowIso_() };
    const teacher = teachers[0];
    const resolvedWindow = await runTeacherDigestStage(
      "RESOLVE_WINDOW",
      () => resolveTeacherDigestWindow_(client, teacher.teacher_id, window, options),
      teacherDigestWindowDiagnosticContext(window)
    );
    const base = await runTeacherDigestStage(
      "BUILD_PAYLOAD_BASE",
      () => buildTeacherPayloadBase_(client, teacher, resolvedWindow, {
        ...options,
        persistWeeklyMetrics: false
      }),
      teacherDigestWindowDiagnosticContext(resolvedWindow)
    );
    const studentsPerPdf = normaliseLimit_(options.studentsPerPdf || options.students_per_pdf || process.env.TEACHER_DIGEST_STUDENTS_PER_PDF, DEFAULT_STUDENTS_PER_PDF, 25);
    const payloads = buildChunkPayloads_(base, studentsPerPdf);
    const deepSeekBatch = base._evidenceItems.length
      ? buildDigestBatch({
        batch_id: `teacher-digest-preview:${resolvedWindow.cycle_key}:${teacher.teacher_id}`,
        students: base._evidenceItems.map((item) => buildDigestStudentRequest({
          requestId: `preview:${item.student_id}`,
          student: item.student,
          facts: item.facts,
          window: resolvedWindow
        }))
      })
      : null;
    return {
      ok: true,
      status: "TEACHER_DIGEST_PAYLOAD_PREVIEW",
      window: resolvedWindow,
      teacher,
      students_per_pdf: studentsPerPdf,
      pdf_part_count: payloads.length,
      deepseek_batch: deepSeekBatch,
      payloads,
      checked_at: nowIso_()
    };
  });
}

async function generateTeacherDigestForTeacher_(client, teacher, window, options = {}) {
  const testRecipientEmail = cleanLower_(options.testRecipientEmail || options.test_recipient_email);
  let existingProductionRun = null;
  if (!testRecipientEmail) {
    existingProductionRun = await findExistingProductionRun_(client, teacher.teacher_id, window.cycle_key);
    if (clean_(existingProductionRun?.email_status).toUpperCase() === "SENT") {
      return {
        ok: true,
        status: "ALREADY_SENT_IDEMPOTENT_SKIP",
        source_type: REAL_SOURCE_TYPE,
        window,
        teacher,
        run_id: existingProductionRun.id,
        sent_at: existingProductionRun.sent_at,
        pdf_count: 0,
        pdfs: [],
        queued: null,
        checked_at: nowIso_()
      };
    }
    if (
      existingProductionRun?.payload_json?.deepseek_generation_run_id &&
      ["QUEUED", "FAILED_RETRYABLE", "SENDING"].includes(clean_(existingProductionRun?.email_status).toUpperCase())
    ) {
      return {
        ok: true,
        status: "ALREADY_QUEUED_IDEMPOTENT_SKIP",
        source_type: REAL_SOURCE_TYPE,
        window,
        teacher,
        run_id: existingProductionRun.id,
        pdf_count: 0,
        pdfs: [],
        queued: { id: existingProductionRun.email_queue_id, status: existingProductionRun.email_status },
        checked_at: nowIso_()
      };
    }
  }
  const regenerateAfterTerminalEmailFailure = clean_(existingProductionRun?.email_status).toUpperCase() === "FAILED";

  const recoverySnapshot = existingProductionRun?.payload_json?.window?.snapshot_at || existingProductionRun?.feedback_window_end_exclusive;
  const windowOptions = regenerateAfterTerminalEmailFailure && recoverySnapshot && !options.snapshotAt && !options.snapshot_at
    ? { ...options, snapshotAt: recoverySnapshot }
    : options;
  window = await resolveTeacherDigestWindow_(client, teacher.teacher_id, window, windowOptions);
  const base = await buildTeacherPayloadBase_(client, teacher, window, {
    ...options,
    generateDeepSeekMessages: true
  });
  if (!base.summary.active_student_count) {
    return {
      ok: true,
      status: "SKIPPED_TEACHER_HAS_NO_ACTIVE_STUDENTS",
      source_type: testRecipientEmail ? TEST_SOURCE_TYPE : REAL_SOURCE_TYPE,
      window,
      teacher,
      students_per_pdf: 0,
      pdf_count: 0,
      pdfs: [],
      queued: null,
      checked_at: nowIso_()
    };
  }
  if (!base._deepSeek?.ready) {
    return {
      ok: true,
      status: "WAITING_FOR_VALID_DIGEST_MESSAGES",
      source_type: testRecipientEmail ? TEST_SOURCE_TYPE : REAL_SOURCE_TYPE,
      window,
      teacher,
      deepseek_generation: {
        run_id: base._deepSeek?.run_id || null,
        status: base._deepSeek?.status || "NOT_STARTED",
        expected_count: Number(base._deepSeek?.expected_count || base.summary.active_student_count),
        validated_count: Number(base._deepSeek?.validated_count || 0),
        failed_count: Number(base._deepSeek?.failed_count || 0)
      },
      pdf_count: 0,
      pdfs: [],
      queued: null,
      checked_at: nowIso_()
    };
  }

  const studentsPerPdf = normaliseLimit_(options.studentsPerPdf || options.students_per_pdf || process.env.TEACHER_DIGEST_STUDENTS_PER_PDF, DEFAULT_STUDENTS_PER_PDF, 25);
  let payloads = buildChunkPayloads_(base, studentsPerPdf);
  const totalParts = payloads.length;
  payloads = payloads.map((payload) => ({
    ...payload,
    document: {
      ...payload.document,
      deepseek_generation_run_id: base._deepSeek.run_id,
      deepseek_prompt_version: TEACHER_DIGEST_PROMPT_VERSION
    }
  }));
  const currentPayloadJson = {
    teacher,
    window,
    summary: base.summary,
    deepseek_generation_run_id: base._deepSeek.run_id,
    deepseek_prompt_version: TEACHER_DIGEST_PROMPT_VERSION,
    pdf_payloads: payloads
  };

  await client.query("begin");
  let run;
  try {
    const runResult = await client.query(
    `
      insert into teacher_digest_runs (
        teacher_id, cycle_key, cycle_date, cycle_day, activity_window_start, activity_window_end_exclusive,
        feedback_window_start, feedback_window_end_exclusive, window_days_and_dates, active_student_count,
        students_with_activity_count, students_without_activity_count, total_parts, test_mode, test_recipient_email,
        status, payload_json, created_at, updated_at
      ) values (
        $1::uuid, $2, $3::date, $4, $5::timestamptz, $6::timestamptz,
        $7::timestamptz, $8::timestamptz, $9, $10::integer,
        $11::integer, $12::integer, $13::integer, $14::boolean, $15,
        'GENERATING_PDFS', $16::jsonb, now(), now()
      )
      on conflict (teacher_id, cycle_key) where test_mode = false do update
      set
        activity_window_start = excluded.activity_window_start,
        activity_window_end_exclusive = excluded.activity_window_end_exclusive,
        feedback_window_start = excluded.feedback_window_start,
        feedback_window_end_exclusive = excluded.feedback_window_end_exclusive,
        window_days_and_dates = excluded.window_days_and_dates,
        active_student_count = excluded.active_student_count,
        students_with_activity_count = excluded.students_with_activity_count,
        students_without_activity_count = excluded.students_without_activity_count,
        total_parts = excluded.total_parts,
        status = 'GENERATING_PDFS',
        payload_json = excluded.payload_json,
        updated_at = now()
      returning *
    `,
    [
      teacher.teacher_id,
      window.cycle_key,
      window.cycle_date,
      window.cycle_day,
      window.activity_window_start,
      window.activity_window_end_exclusive,
      window.feedback_window_start,
      window.feedback_window_end_exclusive,
      window.window_days_and_dates,
      base.summary.active_student_count,
      base.summary.students_with_activity_count,
      base.summary.students_without_activity_count,
      totalParts,
      Boolean(testRecipientEmail),
      testRecipientEmail,
      JSON.stringify(currentPayloadJson)
    ]
    );

    run = runResult.rows[0];
    if (regenerateAfterTerminalEmailFailure) {
      const refreshedRun = await client.query(
        `
          update teacher_digest_runs
          set
            activity_window_start = $2::timestamptz,
            activity_window_end_exclusive = $3::timestamptz,
            feedback_window_start = $4::timestamptz,
            feedback_window_end_exclusive = $5::timestamptz,
            window_days_and_dates = $6,
            active_student_count = $7::integer,
            students_with_activity_count = $8::integer,
            students_without_activity_count = $9::integer,
            total_parts = $10::integer,
            status = 'GENERATING_PDFS',
            payload_json = $11::jsonb,
            updated_at = now()
          where id = $1::uuid
          returning *
        `,
        [
          run.id,
          window.activity_window_start,
          window.activity_window_end_exclusive,
          window.feedback_window_start,
          window.feedback_window_end_exclusive,
          window.window_days_and_dates,
          base.summary.active_student_count,
          base.summary.students_with_activity_count,
          base.summary.students_without_activity_count,
          totalParts,
          JSON.stringify(currentPayloadJson)
        ]
      );
      run = refreshedRun.rows[0] || run;
    }
    await linkDeepSeekRunToDigestRun(client, {
      deepSeekRunId: base._deepSeek.run_id,
      teacherDigestRunId: run.id
    });
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  const pdfs = [];

  for (const payload of payloads) {
    const filename = buildTeacherDigestFilename_(teacher.teacher_name, window.cycle_date, payload.document.part_number, payload.document.total_parts);
    if (!regenerateAfterTerminalEmailFailure) {
      const existingJob = await client.query(
        `
          select id, part_number, total_parts, student_range_label, pdf_filename,
                 pdf_drive_url, pdfmonkey_document_id, google_drive_file_id
          from teacher_digest_pdf_jobs
          where teacher_digest_run_id = $1::uuid
            and part_number = $2::integer
            and payload_json -> 'document' ->> 'deepseek_generation_run_id' = $3
            and upper(coalesce(status, '')) = 'PDF_READY'
            and nullif(btrim(coalesce(pdf_drive_url, '')), '') is not null
          limit 1
        `,
        [run.id, payload.document.part_number, base._deepSeek.run_id]
      );
      if (existingJob.rows[0]) {
        pdfs.push(existingJob.rows[0]);
        continue;
      }
    }
    const generated = await createAndUploadPdf_(client, teacher, payload, filename);
    const jobResult = await client.query(
      `
        insert into teacher_digest_pdf_jobs (
          teacher_digest_run_id, teacher_id, cycle_key, part_number, total_parts, student_start_index,
          student_end_index, student_range_label, status, payload_json, pdf_filename, pdfmonkey_document_id,
          google_drive_file_id, pdf_drive_url, created_at, updated_at
        ) values (
          $1::uuid, $2::uuid, $3, $4::integer, $5::integer, $6::integer,
          $7::integer, $8, 'PDF_READY', $9::jsonb, $10, $11,
          $12, $13, now(), now()
        )
        on conflict (teacher_digest_run_id, part_number) do update
        set
          status = excluded.status,
          payload_json = excluded.payload_json,
          pdf_filename = excluded.pdf_filename,
          pdfmonkey_document_id = excluded.pdfmonkey_document_id,
          google_drive_file_id = excluded.google_drive_file_id,
          pdf_drive_url = excluded.pdf_drive_url,
          updated_at = now()
        returning *
      `,
      [
        run.id,
        teacher.teacher_id,
        window.cycle_key,
        payload.document.part_number,
        payload.document.total_parts,
        payload.document.student_start_index,
        payload.document.student_end_index,
        payload.document.student_range_label,
        JSON.stringify(payload),
        generated.pdf_filename,
        generated.pdfmonkey_document_id,
        generated.google_drive_file_id,
        generated.pdf_drive_url
      ]
    );
    pdfs.push({
      id: jobResult.rows[0].id,
      part_number: payload.document.part_number,
      total_parts: payload.document.total_parts,
      student_range_label: payload.document.student_range_label,
      pdf_filename: generated.pdf_filename,
      pdf_drive_url: generated.pdf_drive_url,
      pdfmonkey_document_id: generated.pdfmonkey_document_id,
      google_drive_file_id: generated.google_drive_file_id
    });
  }

  const queued = await insertEmailQueue_(client, teacher, window, pdfs, options);
  const queueStatus = clean_(queued?.status).toUpperCase();
  if (!["QUEUED", "FAILED_RETRYABLE", "SENDING", "SENT"].includes(queueStatus)) {
    throw new Error(
      `Teacher digest PDFs were generated, but email queue row ${clean_(queued?.id) || "UNKNOWN"} is not deliverable. ` +
      `Queue status: ${queueStatus || "MISSING"}.`
    );
  }
  await client.query(
    `update teacher_digest_runs set status = 'EMAIL_QUEUED', email_queue_id = $2::uuid, updated_at = now() where id = $1::uuid`,
    [run.id, queued.id]
  );

  return {
    ok: true,
    status: testRecipientEmail ? "TEST_TEACHER_DIGEST_GENERATED_AND_QUEUED" : "TEACHER_DIGEST_GENERATED_AND_QUEUED",
    source_type: testRecipientEmail ? TEST_SOURCE_TYPE : REAL_SOURCE_TYPE,
    window,
    teacher,
    students_per_pdf: studentsPerPdf,
    pdf_count: pdfs.length,
    pdfs,
    recovered_terminal_email_failure: regenerateAfterTerminalEmailFailure,
    pdfs_regenerated_after_terminal_email_failure: regenerateAfterTerminalEmailFailure,
    deepseek_generation: {
      run_id: base._deepSeek.run_id,
      status: base._deepSeek.status,
      expected_count: base._deepSeek.expected_count,
      validated_count: base._deepSeek.validated_count
    },
    queued,
    checked_at: nowIso_()
  };
}

function teacherDigestTeacherLimit_(options = {}) {
  const hasTestRecipient = Boolean(clean_(options.testRecipientEmail || options.test_recipient_email));
  const hasTeacherFilter = Boolean(clean_(options.teacherId || options.teacher_id || options.teacherEmail || options.teacher_email));
  const explicitLimit = options.teacherLimit || options.teacher_limit || options.limit;
  const fallback = hasTestRecipient && !hasTeacherFilter && !explicitLimit
    ? 1
    : Number(process.env.TEACHER_DIGEST_TEACHER_LIMIT || 50);

  return normaliseLimit_(explicitLimit || fallback, 50, 500);
}

function teacherDigestLockKey_(teacherId, cycleKey, options = {}) {
  const testEmail = cleanLower_(options.testRecipientEmail || options.test_recipient_email);
  return testEmail
    ? `teacher-digest-test:${teacherId}:${cycleKey}:${hashKey_([testEmail])}`
    : `teacher-digest:${teacherId}:${cycleKey}`;
}

export async function generateTeacherDigestForOneTeacher(options = {}) {
  const window = buildTeacherDigestWindow(options);
  const force = Boolean(options.force || options.force_run);
  if (!window.should_run && !force) {
    return { ok: true, status: "SKIPPED_NOT_DIGEST_DAY", window, queued: null, pdfs: [], checked_at: nowIso_() };
  }

  return withSupabaseClient(async (client) => {
    const teachers = await loadTeachers_(client, { ...options, limit: 1, requireActiveStudents: true });
    if (!teachers.length) return { ok: true, status: "NO_ACTIVE_TEACHER_WITH_ACTIVE_STUDENTS", window, queued: null, pdfs: [], checked_at: nowIso_() };
    const teacher = teachers[0];
    return withDigestAdvisoryLock_(
      client,
      teacherDigestLockKey_(teacher.teacher_id, window.cycle_key, options),
      () => generateTeacherDigestForTeacher_(client, teacher, window, options)
    );
  });
}

export async function generateTeacherDigestsForActiveTeachers(options = {}) {
  const window = buildTeacherDigestWindow(options);
  const force = Boolean(options.force || options.force_run);
  const testRecipientEmail = cleanLower_(options.testRecipientEmail || options.test_recipient_email);
  if (!window.should_run && !force) {
    return {
      ok: true,
      status: "SKIPPED_NOT_DIGEST_DAY",
      window,
      teacher_count: 0,
      generated_count: 0,
      skipped_count: 0,
      failed_count: 0,
      results: [],
      checked_at: nowIso_()
    };
  }

  return withSupabaseClient(async (client) => {
    const limit = teacherDigestTeacherLimit_(options);
    const teachers = await loadTeachers_(client, { ...options, limit, requireActiveStudents: true });
    if (!teachers.length) {
      return {
        ok: true,
        status: "NO_ACTIVE_TEACHERS_WITH_ACTIVE_STUDENTS",
        window,
        teacher_count: 0,
        generated_count: 0,
        skipped_count: 0,
        failed_count: 0,
        results: [],
        checked_at: nowIso_()
      };
    }

    const results = [];
    for (const teacher of teachers) {
      try {
        results.push(await withDigestAdvisoryLock_(
          client,
          teacherDigestLockKey_(teacher.teacher_id, window.cycle_key, options),
          () => generateTeacherDigestForTeacher_(client, teacher, window, options)
        ));
      } catch (error) {
        results.push({
          ok: false,
          status: "TEACHER_DIGEST_GENERATION_FAILED",
          teacher,
          error: error instanceof Error ? error.message : String(error),
          checked_at: nowIso_()
        });
      }
    }

    const generatedCount = results.filter((item) => item.ok !== false && item.queued).length;
    const skippedCount = results.filter((item) => item.ok !== false && !item.queued).length;
    const failedCount = results.filter((item) => item.ok === false).length;

    return {
      ok: failedCount === 0,
      status: testRecipientEmail ? "TEST_TEACHER_DIGESTS_GENERATED_AND_QUEUED" : "TEACHER_DIGESTS_GENERATED_AND_QUEUED",
      source_type: testRecipientEmail ? TEST_SOURCE_TYPE : REAL_SOURCE_TYPE,
      window,
      teacher_count: teachers.length,
      generated_count: generatedCount,
      skipped_count: skippedCount,
      failed_count: failedCount,
      results,
      checked_at: nowIso_()
    };
  });
}

export function getTeacherDigestSourceTypes() {
  return { real: REAL_SOURCE_TYPE, test: TEST_SOURCE_TYPE };
}
