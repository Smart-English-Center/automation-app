import { markdownToHtml, plainTextToHtml, linkToHtml } from "../pdf/html.js";
import { withSupabaseClient } from "./client.js";

const DEFAULT_LIMIT = 7;
const MAX_LIMIT = 7;
const READY_PDF_STATUS = "READY_FOR_PDF";
const DEFAULT_ACADEMY_NAME = "John's English Academy";
const TEMPLATE_VERSION = "JEA_STUDENT_FEEDBACK_APPROVED_STYLE_V2";

function nowIso_() {
  return new Date().toISOString();
}

function normaliseLimit_(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function normaliseBoolean_(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const clean = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(clean);
}

function schedulerTimezone_() {
  return clean_(process.env.SCHEDULER_TIMEZONE || process.env.TZ) || "Africa/Douala";
}

function clean_(value) {
  return String(value ?? "").trim();
}

function scoreDisplay_(value) {
  if (value === null || value === undefined || value === "") return "Not assessed";
  return `${value}/100`;
}

function localIsoDate_(date = new Date()) {
  const timezone = schedulerTimezone_();

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
}

function deliveryDate_() {
  const configured = clean_(process.env.PDF_TARGET_DELIVERY_DATE);
  if (configured) return configured;
  return localIsoDate_();
}

function generatedAt_() {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: process.env.SCHEDULER_TIMEZONE || process.env.TZ || "Africa/Douala"
  }).format(new Date());
}

function assignmentCountLabel_(count) {
  return count === 1 ? "1 corrected assignment" : `${count} corrected assignments`;
}

function average_(values) {
  const usable = values.filter((value) => Number.isFinite(Number(value))).map(Number);
  if (!usable.length) return null;
  return Math.ceil(usable.reduce((sum, value) => sum + value, 0) / usable.length);
}

function finalScoreRule_(row) {
  const writingStatus = clean_(row.writing_status);
  const speakingStatus = clean_(row.speaking_status);
  const hasWritingScore = row.writing_score !== null && row.writing_score !== undefined && row.writing_score !== "";
  const hasSpeakingScore = row.speaking_score !== null && row.speaking_score !== undefined && row.speaking_score !== "";

  if (hasWritingScore && hasSpeakingScore) {
    return "Final score = average of writing and speaking scores, rounded up.";
  }

  if (hasWritingScore && speakingStatus === "NOT_ASSESSED") {
    return "Final score = writing score only because speaking was not assessed.";
  }

  if (hasSpeakingScore && writingStatus === "NOT_ASSESSED") {
    return "Final score = speaking score only because writing was not assessed.";
  }

  return "Final score is based on the available assessed skill score(s).";
}

function buildSkillPayload_(kind, row) {
  const prefix = kind === "writing" ? "writing" : "speaking";
  const available = Boolean(row[`${prefix}_draft_id`] || row[`${prefix}_feedback_markdown`]);
  const feedbackMarkdown = clean_(row[`${prefix}_feedback_markdown`]);
  const taskInstruction = clean_(row[`${prefix}_task_instruction`]);
  const choiceText = clean_(row[`${prefix}_choice_text`]);
  const score = row[`${prefix}_score`] === null || row[`${prefix}_score`] === undefined ? null : Number(row[`${prefix}_score`]);
  const status = clean_(row[`${prefix}_status`]) || (available ? "REVIEWED" : "NOT_AVAILABLE");

  const base = {
    available,
    status,
    score,
    score_display: clean_(row[`${prefix}_score_display`]) || scoreDisplay_(score),
    choice_text: choiceText,
    task_instruction: taskInstruction,
    task_instruction_html: plainTextToHtml(taskInstruction),
    reviewed_feedback_markdown: feedbackMarkdown,
    reviewed_feedback_html: markdownToHtml(feedbackMarkdown),
    review_status: clean_(row[`${prefix}_review_status`])
  };

  if (kind === "writing") {
    const answer = clean_(row.writing_answer);
    return {
      ...base,
      student_answer: answer,
      student_answer_html: plainTextToHtml(answer)
    };
  }

  const audioLink = clean_(row.speaking_original_link || row.speakpipe_link || row.audio_link);
  return {
    ...base,
    audio_link: audioLink,
    audio_link_html: linkToHtml(audioLink, "Open submitted audio"),
    not_assessed_reason: status === "NOT_ASSESSED" ? clean_(row.speaking_problem_message) : ""
  };
}

function buildAssignment_(row) {
  const finalScore = row.final_score === null || row.final_score === undefined ? null : Number(row.final_score);

  return {
    assignment_key: clean_(row.assignment_key),
    level: clean_(row.level),
    module: clean_(row.module),
    unit: clean_(row.unit),
    day: clean_(row.day),
    final_score: finalScore,
    final_score_display: clean_(row.final_score_display) || scoreDisplay_(finalScore),
    final_score_rule: finalScoreRule_(row),
    writing: buildSkillPayload_("writing", row),
    speaking: buildSkillPayload_("speaking", row)
  };
}

function buildPayload_(rows) {
  if (!rows.length) return null;

  const first = rows[0];
  const assignments = rows.map(buildAssignment_);
  const averageFinalScore = average_(assignments.map((assignment) => assignment.final_score));
  const assignmentKeys = assignments.map((assignment) => assignment.assignment_key).filter(Boolean);
  const assignmentCount = assignments.length;

  return {
    academy: {
      name: process.env.ACADEMY_NAME || DEFAULT_ACADEMY_NAME
    },
    document: {
      title: "Student Feedback Report",
      subtitle: assignmentCountLabel_(assignmentCount),
      generated_at: generatedAt_(),
      target_delivery_date: deliveryDate_(),
      assignment_count: assignmentCount,
      assignment_count_label: assignmentCountLabel_(assignmentCount),
      template_version: TEMPLATE_VERSION
    },
    style_profile: {
      name: "approved_student_feedback_style_v2",
      writing_answer_font_size: "14px",
      feedback_font_size: "13px",
      assignment_key_visible: true,
      clickable_links: true,
      hide_batch_id: true,
      hide_final_teacher_feedback: true
    },
    student: {
      id: first.student_id,
      name: clean_(first.student_name),
      email: clean_(first.student_email),
      level: clean_(first.level)
    },
    summary: {
      assignment_count: assignmentCount,
      assignment_keys: assignmentKeys,
      average_final_score: averageFinalScore,
      average_final_score_display: scoreDisplay_(averageFinalScore)
    },
    assignments
  };
}

async function getReadyRowsForStudent_(client, options = {}) {
  const limit = normaliseLimit_(options.limit);
  const studentId = clean_(options.studentId);
  const studentEmail = clean_(options.studentEmail).toLowerCase();
  const includeSameDayReady = normaliseBoolean_(options.includeSameDayReady, normaliseBoolean_(process.env.PDF_INCLUDE_SAME_DAY_READY, false));
  const timezone = schedulerTimezone_();

  const params = [READY_PDF_STATUS, limit, includeSameDayReady, timezone];
  let studentFilter = "";

  if (studentId) {
    params.push(studentId);
    studentFilter = `and ff.student_id = $${params.length}::uuid`;
  } else if (studentEmail) {
    params.push(studentEmail);
    studentFilter = `and lower(ff.student_email) = $${params.length}`;
  } else {
    studentFilter = `and ff.student_id = (
      select student_id
      from final_feedback
      where pdf_status = $1
        and final_status = 'REVIEWED'
        and (
          $3::boolean = true
          or coalesce(pdf_ready_at, updated_at, created_at) < (date_trunc('day', now() at time zone $4) at time zone $4)
        )
      order by coalesce(pdf_ready_at, updated_at, created_at) asc, created_at asc nulls last, id
      limit 1
    )`;
  }

  const result = await client.query(
    `
      select
        ff.id as final_feedback_id,
        ff.submission_id,
        ff.student_id,
        ff.student_name,
        ff.student_email,
        ff.teacher_id,
        ff.level,
        ff.assignment_key,
        ff.module,
        ff.unit,
        ff.day,
        ff.writing_draft_id,
        ff.writing_status,
        ff.writing_score,
        ff.writing_score_display,
        ff.writing_feedback_markdown,
        ff.writing_review_status,
        ff.speaking_draft_id,
        ff.speaking_status,
        ff.speaking_score,
        ff.speaking_score_display,
        ff.speaking_feedback_markdown,
        ff.speaking_review_status,
        ff.speaking_problem_code,
        ff.speaking_problem_message,
        ff.speaking_original_link,
        ff.final_score,
        ff.final_score_display,
        ff.final_status,
        ff.pdf_status,
        ff.delivery_status,
        si.writing_answer,
        si.writing_task_instruction,
        si.speaking_task_instruction,
        si.writing_choice_text,
        si.speaking_choice_text,
        si.speakpipe_link,
        si.audio_link
      from final_feedback ff
      left join submission_inbox si on si.id = ff.submission_id
      where ff.pdf_status = $1
        and ff.final_status = 'REVIEWED'
        and coalesce(si.status, '') <> 'SUPERSEDED_BY_LATEST_SUBMISSION'
        and (
          $3::boolean = true
          or coalesce(ff.pdf_ready_at, ff.updated_at, ff.created_at) < (date_trunc('day', now() at time zone $4) at time zone $4)
        )
        ${studentFilter}
      order by coalesce(ff.pdf_ready_at, ff.updated_at, ff.created_at) asc, ff.assignment_key, ff.created_at, ff.id
      limit $2
    `,
    params
  );

  return result.rows;
}


async function getRowsByFinalFeedbackIds_(client, finalFeedbackIds = []) {
  const ids = finalFeedbackIds.map((id) => clean_(id)).filter(Boolean);

  if (!ids.length) return [];

  const result = await client.query(
    `
      select
        ff.id as final_feedback_id,
        ff.submission_id,
        ff.student_id,
        ff.student_name,
        ff.student_email,
        ff.teacher_id,
        ff.level,
        ff.assignment_key,
        ff.module,
        ff.unit,
        ff.day,
        ff.writing_draft_id,
        ff.writing_status,
        ff.writing_score,
        ff.writing_score_display,
        ff.writing_feedback_markdown,
        ff.writing_review_status,
        ff.speaking_draft_id,
        ff.speaking_status,
        ff.speaking_score,
        ff.speaking_score_display,
        ff.speaking_feedback_markdown,
        ff.speaking_review_status,
        ff.speaking_problem_code,
        ff.speaking_problem_message,
        ff.speaking_original_link,
        ff.final_score,
        ff.final_score_display,
        ff.final_status,
        ff.pdf_status,
        ff.delivery_status,
        si.writing_answer,
        si.writing_task_instruction,
        si.speaking_task_instruction,
        si.writing_choice_text,
        si.speaking_choice_text,
        si.speakpipe_link,
        si.audio_link
      from final_feedback ff
      left join submission_inbox si on si.id = ff.submission_id
      where ff.id = any($1::uuid[])
        and coalesce(si.status, '') <> 'SUPERSEDED_BY_LATEST_SUBMISSION'
      order by ff.assignment_key, ff.created_at, ff.id
    `,
    [ids]
  );

  return result.rows;
}

export async function buildPdfPayloadForFinalFeedbackIds(client, finalFeedbackIds = []) {
  const rows = await getRowsByFinalFeedbackIds_(client, finalFeedbackIds);
  const payload = buildPayload_(rows);

  return {
    rows,
    payload,
    final_feedback_ids: rows.map((row) => row.final_feedback_id)
  };
}

function filenameSlug_(value, fallback = "Student") {
  const cleaned = clean_(value)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");

  return cleaned || fallback;
}

export function buildDefaultStudentPdfFilename(payload) {
  if (!payload || !payload.student || !payload.document || !payload.summary) {
    return `Student_${new Date().toISOString().slice(0, 10)}_feedback.pdf`;
  }

  const studentName = filenameSlug_(payload.student.name, "Student");
  const deliveryDate = clean_(payload.document.target_delivery_date) || new Date().toISOString().slice(0, 10);

  /*
    Storage naming convention:
    Student_Name_YYYY-MM-DD_feedback.pdf

    Assignment keys are intentionally not added to the filename because the PDF
    already displays them in summary.assignment_keys and inside each assignment card.
    This keeps filenames readable and aligned with the approved sample format.
  */
  return `${studentName}_${deliveryDate}_feedback.pdf`
    .replace(/[\/:*?"<>|]+/g, "_")
    .replace(/_+/g, "_")
    .trim()
    .slice(0, 180);
}


export async function previewPdfPayload(options = {}) {
  return withSupabaseClient(async (client) => {
    const rows = await getReadyRowsForStudent_(client, options);

    if (!rows.length) {
      return {
        ok: true,
        status: "NO_READY_PDF_PAYLOAD",
        message: "No final_feedback rows are ready for PDF payload preview.",
        checked_at: nowIso_()
      };
    }

    return {
      ok: true,
      status: "PDF_PAYLOAD_READY",
      final_feedback_ids: rows.map((row) => row.final_feedback_id),
      payload: buildPayload_(rows),
      checked_at: nowIso_()
    };
  });
}

export async function getPdfPayloadSummary() {
  return withSupabaseClient(async (client) => {
    const result = await client.query(
      `
        select
          pdf_status,
          final_status,
          delivery_status,
          count(*)::integer as row_count,
          count(distinct student_id)::integer as student_count
        from final_feedback
        group by pdf_status, final_status, delivery_status
        order by pdf_status, final_status, delivery_status
      `
    );

    return {
      ok: true,
      summary: result.rows,
      checked_at: nowIso_()
    };
  });
}
