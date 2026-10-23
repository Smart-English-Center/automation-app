import { withSupabaseClient } from "./client.js";
import { getConfig } from "../config.js";

const REVIEWED_STATUSES = [
  "APPROVED",
  "FIXED",
  "REGENERATED",
  "PARTIAL_FEEDBACK",
  "BAD_SUBMISSION",
  "TEACHER_REVIEW"
];

const TERMINAL_NOT_ASSESSED_SPEAKING_STATUSES = ["NOT_ASSESSED"];
const TERMINAL_NOT_ASSESSED_REVIEW_STATUSES = ["PARTIAL_FEEDBACK", "BAD_SUBMISSION"];

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

function nowIso_() {
  return new Date().toISOString();
}

function normaliseLimit_(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_LIMIT);
}

function reviewedStatuses_() {
  return REVIEWED_STATUSES;
}

// When PDF_REQUIRE_SPEAKING=false, a writing-reviewed assignment can be assembled into
// final_feedback (and therefore become eligible for PDF generation) even while speaking
// has no reviewed or terminal outcome yet. The student sees this placeholder message in
// place of a speaking correction until speaking catches up.
function speakingRequiredForPdf_() {
  return getConfig().pdf.requireSpeakingForPdf;
}

function speakingUnavailableMessage_() {
  return getConfig().pdf.speakingUnavailableMessage;
}

const FINAL_FEEDBACK_SOURCE_CHANGED_SQL = `
  row(
    final_feedback.writing_draft_id,
    final_feedback.writing_status,
    final_feedback.writing_score_display,
    final_feedback.writing_feedback_markdown,
    final_feedback.writing_review_status,
    final_feedback.speaking_draft_id,
    final_feedback.speaking_status,
    final_feedback.speaking_score_display,
    final_feedback.speaking_feedback_markdown,
    final_feedback.speaking_review_status,
    final_feedback.speaking_problem_code,
    final_feedback.speaking_problem_message,
    final_feedback.speaking_original_link,
    final_feedback.final_score_display,
    final_feedback.final_status
  ) is distinct from row(
    excluded.writing_draft_id,
    excluded.writing_status,
    excluded.writing_score_display,
    excluded.writing_feedback_markdown,
    excluded.writing_review_status,
    excluded.speaking_draft_id,
    excluded.speaking_status,
    excluded.speaking_score_display,
    excluded.speaking_feedback_markdown,
    excluded.speaking_review_status,
    excluded.speaking_problem_code,
    excluded.speaking_problem_message,
    excluded.speaking_original_link,
    excluded.final_score_display,
    excluded.final_status
  )
`;

/**
 * Return the already-delivered final_feedback row for one student's writing
 * assignment, or null when no delivered writing correction exists.
 *
 * EMAIL_SENT is the current delivery status written by emailQueueRepository.
 * SENT is retained because other existing repository queries treat it as a
 * legacy delivered value.
 */
export async function findDeliveredWritingCorrection(
  { studentId, assignmentKey } = {},
  dependencies = {}
) {
  const normalizedStudentId = String(studentId || "").trim();
  const normalizedAssignmentKey = String(assignmentKey || "").trim();

  if (!normalizedStudentId) {
    throw new Error("studentId is required to check for delivered writing feedback.");
  }

  if (!normalizedAssignmentKey) {
    throw new Error("assignmentKey is required to check for delivered writing feedback.");
  }

  const withClient = dependencies.withSupabaseClient || withSupabaseClient;

  return withClient(async (client) => {
    const result = await client.query(
      `
        select
          id,
          submission_id,
          student_id,
          assignment_key,
          writing_draft_id,
          writing_status,
          delivery_status,
          email_sent_at
        from final_feedback
        where student_id = $1::uuid
          and assignment_key = $2
          and writing_draft_id is not null
          and upper(coalesce(writing_status, '')) = 'REVIEWED'
          and upper(coalesce(delivery_status, '')) in ('EMAIL_SENT', 'SENT')
        order by coalesce(email_sent_at, updated_at, created_at) desc nulls last, id desc
        limit 1
      `,
      [normalizedStudentId, normalizedAssignmentKey]
    );

    return result.rows[0] || null;
  });
}

export async function previewFinalFeedbackAssembly(options = {}) {
  const limit = normaliseLimit_(options.limit);

  return withSupabaseClient(async (client) => {
    const summaryResult = await client.query(
      `
        with source_drafts as (
          select d.*
          from ai_drafts d
          where d.submission_id is not null
            and (
              d.review_status = any($1::text[])
              or (
                d.job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')
                and (d.status = any($2::text[]) or d.review_status = any($3::text[]))
              )
            )
        ), reviewed_submissions as (
          select
            submission_id,
            bool_or(job_type = 'WRITING_CORRECTION' and review_status = any($1::text[])) as has_reviewed_writing,
            bool_or(
              job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')
              and (
                review_status = any($1::text[])
                or status = any($2::text[])
                or review_status = any($3::text[])
              )
            ) as has_speaking_outcome
          from source_drafts
          group by submission_id
        ), ready_assignments as (
          select rs.submission_id
          from reviewed_submissions rs
          where rs.has_reviewed_writing = true
            and (rs.has_speaking_outcome = true or $4::boolean = false)
            and not exists (
              select 1
              from speaking_link_remediation_cases rc
              where rc.submission_id = rs.submission_id
                and (
                  rc.status = 'AWAITING_ACTION'
                  or (rc.status = 'LINK_CORRECTED' and rs.has_speaking_outcome = false)
                )
            )
        ), existing_final as (
          select submission_id
          from final_feedback
          where submission_id is not null
        )
        select
          (select count(*)::integer from source_drafts) as reviewed_or_terminal_draft_count,
          (select count(*)::integer from source_drafts where job_type = 'WRITING_CORRECTION' and review_status = any($1::text[])) as reviewed_writing_draft_count,
          (select count(*)::integer from source_drafts where job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')) as speaking_outcome_draft_count,
          (select count(*)::integer from reviewed_submissions) as submissions_with_any_reviewed_or_terminal_draft,
          (select count(*)::integer from ready_assignments) as assignment_count_ready_for_final_feedback,
          (
            select count(*)::integer
            from ready_assignments ra
            left join existing_final ef on ef.submission_id = ra.submission_id
            where ef.submission_id is null
          ) as unassembled_assignment_count,
          (select count(*)::integer from final_feedback) as final_feedback_count
      `,
      [reviewedStatuses_(), TERMINAL_NOT_ASSESSED_SPEAKING_STATUSES, TERMINAL_NOT_ASSESSED_REVIEW_STATUSES, speakingRequiredForPdf_()]
    );

    const sampleResult = await client.query(
      `
        with source_drafts as (
          select
            d.*,
            row_number() over (
              partition by d.submission_id, d.job_type
              order by d.reviewed_at desc nulls last, d.updated_at desc nulls last, d.created_at desc nulls last, d.id
            ) as rn
          from ai_drafts d
          where d.submission_id is not null
            and (
              d.review_status = any($1::text[])
              or (
                d.job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')
                and (d.status = any($2::text[]) or d.review_status = any($3::text[]))
              )
            )
        ), per_submission as (
          select
            si.id as submission_id,
            si.id::text as old_submission_id,
            si.assignment_key,
            si.level,
            si.module,
            si.unit,
            si.day,
            s.full_name as student_name,
            s.email as student_email,
            t.full_name as teacher_name,
            fw.id as writing_draft_id,
            fw.id::text as old_writing_draft_id,
            fw.review_status as writing_review_status,
            fw.reviewed_at as writing_reviewed_at,
            case when fw.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION', 'TEACHER_REVIEW') then null else coalesce(fw.reviewed_score, fw.score) end as writing_score,
            fs.id as speaking_draft_id,
            fs.id::text as old_speaking_draft_id,
            fs.status as speaking_raw_status,
            fs.review_status as speaking_review_status,
            fs.reviewed_at as speaking_reviewed_at,
            case when fs.status = any($2::text[]) or fs.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION', 'TEACHER_REVIEW') then null else coalesce(fs.reviewed_score, fs.score) end as speaking_score,
            case when fs.status = any($2::text[]) or fs.review_status = any($3::text[]) then true else false end as speaking_is_not_assessed,
            ff.id as existing_final_feedback_id,
            ff.final_status as existing_final_status,
            ff.pdf_status as existing_pdf_status
          from submission_inbox si
          left join students s on s.id = si.student_id
          left join teachers t on t.id = si.teacher_id
          left join source_drafts fw on fw.submission_id = si.id and fw.job_type = 'WRITING_CORRECTION' and fw.rn = 1
          left join source_drafts fs on fs.submission_id = si.id and fs.job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION') and fs.rn = 1
          left join final_feedback ff on ff.submission_id = si.id
          where fw.id is not null
            and fw.review_status = any($1::text[])
            and ($5::boolean = false or fs.id is not null)
            and not exists (
              select 1
              from speaking_link_remediation_cases rc
              where rc.submission_id = si.id
                and (
                  rc.status = 'AWAITING_ACTION'
                  or (rc.status = 'LINK_CORRECTED' and fs.id is null)
                )
            )
            and coalesce(si.status, '') <> 'SUPERSEDED_BY_LATEST_SUBMISSION'
            and not (coalesce(fw.score, fw.reviewed_score) = 0 and nullif(trim(coalesce(si.writing_answer, '')), '') is null and nullif(trim(coalesce(si.writing_choice_text, '')), '') is not null)
        )
        select *
        from per_submission
        order by existing_final_feedback_id nulls first, assignment_key, student_name
        limit $4
      `,
      [reviewedStatuses_(), TERMINAL_NOT_ASSESSED_SPEAKING_STATUSES, TERMINAL_NOT_ASSESSED_REVIEW_STATUSES, limit, speakingRequiredForPdf_()]
    );

    return {
      ok: true,
      mode: "preview_only",
      rule: speakingRequiredForPdf_()
        ? "One assignment is ready for final feedback when writing has reviewed feedback and speaking has either reviewed feedback or a terminal not-assessed outcome."
        : "PDF_REQUIRE_SPEAKING is false: an assignment is ready for final feedback as soon as writing has reviewed feedback, regardless of speaking readiness.",
      speaking_required_for_pdf: speakingRequiredForPdf_(),
      reviewed_statuses: reviewedStatuses_(),
      terminal_not_assessed_speaking_statuses: TERMINAL_NOT_ASSESSED_SPEAKING_STATUSES,
      terminal_not_assessed_review_statuses: TERMINAL_NOT_ASSESSED_REVIEW_STATUSES,
      limit,
      summary: summaryResult.rows[0] || {},
      sample: sampleResult.rows,
      checked_at: nowIso_()
    };
  });
}

export async function assembleFinalFeedback(options = {}, dependencies = {}) {
  const limit = normaliseLimit_(options.limit);
  const assembledBy = String(options.assembledBy || "manual-final-feedback-route").trim() || "manual-final-feedback-route";
  const withClient = dependencies.withSupabaseClient || withSupabaseClient;

  return withClient(async (client) => {
    await client.query("begin");

    try {
      const result = await client.query(
        `
          with source_drafts as (
            select
              d.*,
              row_number() over (
                partition by
                  d.submission_id,
                  case
                    when d.job_type = 'WRITING_CORRECTION' then 'WRITING'
                    when d.job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION') then 'SPEAKING'
                    else d.job_type
                  end
                order by d.reviewed_at desc nulls last, d.updated_at desc nulls last, d.created_at desc nulls last, d.id
              ) as rn
            from ai_drafts d
            where d.submission_id is not null
              and (
                d.review_status = any($1::text[])
                or (
                  d.job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')
                  and (d.status = any($4::text[]) or d.review_status = any($5::text[]))
                )
              )
          ), ready_submissions as (
            select
              si.id as submission_id,
              greatest(
                coalesce(fw.reviewed_at, fw.updated_at, fw.created_at),
                coalesce(fs.reviewed_at, fs.updated_at, fs.created_at)
              ) as both_reviewed_at,
              ff.id as existing_final_feedback_id
            from submission_inbox si
            join source_drafts fw on fw.submission_id = si.id and fw.job_type = 'WRITING_CORRECTION' and fw.rn = 1
            left join source_drafts fs on fs.submission_id = si.id and fs.job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION') and fs.rn = 1
            left join final_feedback ff on ff.submission_id = si.id
            where fw.review_status = any($1::text[])
              and coalesce(si.status, '') <> 'SUPERSEDED_BY_LATEST_SUBMISSION'
              and not (coalesce(fw.score, fw.reviewed_score) = 0 and nullif(trim(coalesce(si.writing_answer, '')), '') is null and nullif(trim(coalesce(si.writing_choice_text, '')), '') is not null)
              and ($6::boolean = false or fs.id is not null)
              and not exists (
                select 1
                from speaking_link_remediation_cases rc
                where rc.submission_id = si.id
                  and (
                    rc.status = 'AWAITING_ACTION'
                    or (rc.status = 'LINK_CORRECTED' and fs.id is null)
                  )
              )
              and (
                ff.id is null
                or ff.pdf_ready_at is null
                or greatest(
                  coalesce(fw.reviewed_at, fw.updated_at, fw.created_at),
                  coalesce(fs.reviewed_at, fs.updated_at, fs.created_at)
                ) > ff.pdf_ready_at
              )
            order by
              case when ff.id is null then 0 else 1 end,
              both_reviewed_at asc nulls last,
              si.id
            limit $2
          ), assembled as (
            select
              si.id as submission_id,
              si.student_id,
              st.full_name as student_name,
              st.email as student_email,
              si.teacher_id as teacher_id,
              si.level as level,
              si.assignment_key,
              si.module,
              si.unit,
              si.day,
              fw.id as writing_draft_id,
              fw.review_status as writing_review_status,
              case
                when fw.review_status = 'TEACHER_REVIEW' then 'NEEDS_TEACHER_REVIEW'
                when fw.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION') then 'NOT_ASSESSED'
                else 'REVIEWED'
              end as writing_status,
              case
                when fw.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION', 'TEACHER_REVIEW') then null
                else coalesce(fw.reviewed_score, fw.score)
              end as writing_score,
              case
                when fw.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION', 'TEACHER_REVIEW') then 'Not assessed'
                when coalesce(fw.reviewed_score, fw.score) is null then null
                else coalesce(fw.reviewed_score, fw.score)::text || '/100'
              end as writing_score_display,
              case
                when fw.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION') then ''
                else coalesce(nullif(trim(fw.reviewed_student_feedback), ''), fw.student_draft_feedback)
              end as writing_feedback_markdown,
              fs.id as speaking_draft_id,
              fs.review_status as speaking_review_status,
              case
                when fs.id is null then 'NOT_ASSESSED'
                when fs.review_status = 'TEACHER_REVIEW' then 'NEEDS_TEACHER_REVIEW'
                when fs.status = any($4::text[]) or fs.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION') then 'NOT_ASSESSED'
                else 'REVIEWED'
              end as speaking_status,
              case
                when fs.id is null then null
                when fs.status = any($4::text[]) or fs.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION', 'TEACHER_REVIEW') then null
                else coalesce(fs.reviewed_score, fs.score)
              end as speaking_score,
              case
                when fs.id is null then 'Not assessed'
                when fs.status = any($4::text[]) or fs.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION', 'TEACHER_REVIEW') then 'Not assessed'
                when coalesce(fs.reviewed_score, fs.score) is null then null
                else coalesce(fs.reviewed_score, fs.score)::text || '/100'
              end as speaking_score_display,
              case
                when fs.id is null then ''
                when fs.status = any($4::text[]) or fs.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION') then ''
                else coalesce(nullif(trim(fs.reviewed_student_feedback), ''), fs.student_draft_feedback)
              end as speaking_feedback_markdown,
              coalesce(nullif(trim(si.speakpipe_link), ''), nullif(trim(si.audio_link), '')) as speaking_original_link,
              case
                when fw.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION') then coalesce(nullif(trim(fw.review_note), ''), 'Writing was not assessed for this assignment.')
                else null
              end as writing_problem_message,
              case
                when fs.id is null then $7::text
                when fs.status = any($4::text[]) or fs.review_status in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION') then coalesce(nullif(trim(fs.review_note), ''), 'Speaking was not assessed because the audio/link was invalid, inaccessible, or unprocessable.')
                else null
              end as speaking_problem_message,
              greatest(
                coalesce(fw.reviewed_at, fw.updated_at, fw.created_at),
                coalesce(fs.reviewed_at, fs.updated_at, fs.created_at)
              ) as both_reviewed_at,
              concat('final-feedback:', si.id::text) as idempotency_key
            from ready_submissions rs
            join submission_inbox si on si.id = rs.submission_id
            left join students st on st.id = si.student_id
            join source_drafts fw on fw.submission_id = si.id and fw.job_type = 'WRITING_CORRECTION' and fw.rn = 1
            left join source_drafts fs on fs.submission_id = si.id and fs.job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION') and fs.rn = 1
          ), scored as (
            select
              *,
              array_remove(array[writing_score, speaking_score], null) as available_scores
            from assembled
          ), finalised as (
            select
              *,
              case
                when writing_status = 'NEEDS_TEACHER_REVIEW' or speaking_status = 'NEEDS_TEACHER_REVIEW' then 'NEEDS_TEACHER_REVIEW'
                when cardinality(available_scores) = 0 then 'NOT_READY'
                else 'REVIEWED'
              end as final_status,
              case
                when cardinality(available_scores) = 0 then null
                else ceiling((select avg(value) from unnest(available_scores) as value))
              end as final_score
            from scored
          )
          insert into final_feedback (
            submission_id,
            student_id,
            student_name,
            student_email,
            teacher_id,
            level,
            assignment_key,
            module,
            unit,
            day,
            writing_draft_id,
            writing_status,
            writing_score,
            writing_score_display,
            writing_feedback_markdown,
            writing_review_status,
            speaking_draft_id,
            speaking_status,
            speaking_score,
            speaking_score_display,
            speaking_feedback_markdown,
            speaking_review_status,
            speaking_problem_code,
            speaking_problem_message,
            speaking_original_link,
            final_score,
            final_score_display,
            final_status,
            final_feedback_markdown,
            pdf_status,
            pdf_ready_at,
            delivery_status,
            idempotency_key,
            created_at,
            updated_at,
            notes
          )
          select
            submission_id,
            student_id,
            student_name,
            student_email,
            teacher_id,
            level,
            assignment_key,
            module,
            unit,
            day,
            writing_draft_id,
            writing_status,
            writing_score,
            writing_score_display,
            writing_feedback_markdown,
            writing_review_status,
            speaking_draft_id,
            speaking_status,
            speaking_score,
            speaking_score_display,
            case
              when speaking_feedback_markdown is null then null
              else regexp_replace(speaking_feedback_markdown, '(^|[^*])\\*([^*\\n][^*\\n]*?)\\*([^*]|$)', '\\1"\\2"\\3', 'g')
            end,
            speaking_review_status,
            case
              when speaking_status = 'NOT_ASSESSED' and speaking_draft_id is null then 'SPEAKING_PROCESSING_DELAYED'
              when speaking_status = 'NOT_ASSESSED' then 'SPEAKING_NOT_ASSESSED'
              else null
            end,
            case when speaking_status = 'NOT_ASSESSED' then speaking_problem_message else null end,
            speaking_original_link,
            final_score,
            case when final_score is null then 'Not assessed' else final_score::text || '/100' end,
            final_status,
            null,
            case when final_status = 'REVIEWED' then 'READY_FOR_PDF' else 'NOT_READY' end,
            case when final_status = 'REVIEWED' then coalesce(both_reviewed_at, now()) else null end,
            'NOT_QUEUED',
            idempotency_key,
            now(),
            now(),
            'Assembled by ' || $3 || ' from reviewed writing and speaking outcome ai_drafts sharing the same submission_id.'
          from finalised
          on conflict (idempotency_key) do update
          set
            student_id = excluded.student_id,
            student_name = excluded.student_name,
            student_email = excluded.student_email,
            teacher_id = excluded.teacher_id,
            level = excluded.level,
            assignment_key = excluded.assignment_key,
            module = excluded.module,
            unit = excluded.unit,
            day = excluded.day,
            writing_draft_id = excluded.writing_draft_id,
            writing_status = excluded.writing_status,
            writing_score = excluded.writing_score,
            writing_score_display = excluded.writing_score_display,
            writing_feedback_markdown = excluded.writing_feedback_markdown,
            writing_review_status = excluded.writing_review_status,
            speaking_draft_id = excluded.speaking_draft_id,
            speaking_status = excluded.speaking_status,
            speaking_score = excluded.speaking_score,
            speaking_score_display = excluded.speaking_score_display,
            speaking_feedback_markdown = excluded.speaking_feedback_markdown,
            speaking_review_status = excluded.speaking_review_status,
            speaking_problem_code = excluded.speaking_problem_code,
            speaking_problem_message = excluded.speaking_problem_message,
            speaking_original_link = excluded.speaking_original_link,
            final_score = excluded.final_score,
            final_score_display = excluded.final_score_display,
            final_status = excluded.final_status,
            pdf_status = case
              when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then excluded.pdf_status
              else final_feedback.pdf_status
            end,
            pdf_ready_at = case
              when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then excluded.pdf_ready_at
              else coalesce(final_feedback.pdf_ready_at, excluded.pdf_ready_at)
            end,
            delivery_status = case
              when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then excluded.delivery_status
              when final_feedback.delivery_status in ('READY_FOR_EMAIL', 'EMAIL_QUEUED', 'EMAIL_FAILED') then final_feedback.delivery_status
              else excluded.delivery_status
            end,
            pdf_job_id = case when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then null else final_feedback.pdf_job_id end,
            pdf_drive_file_id = case when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then null else final_feedback.pdf_drive_file_id end,
            pdf_drive_url = case when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then null else final_feedback.pdf_drive_url end,
            pdf_filename = case when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then null else final_feedback.pdf_filename end,
            email_queue_id = case when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then null else final_feedback.email_queue_id end,
            email_queued_at = case when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then null else final_feedback.email_queued_at end,
            email_sent_at = case when (${FINAL_FEEDBACK_SOURCE_CHANGED_SQL}) then null else final_feedback.email_sent_at end,
            updated_at = now(),
            notes = excluded.notes
          returning
            id,
            submission_id,
            student_id,
            student_name,
            student_email,
            assignment_key,
            writing_status,
            writing_score_display,
            writing_review_status,
            speaking_status,
            speaking_score_display,
            speaking_review_status,
            speaking_problem_code,
            speaking_problem_message,
            final_status,
            final_score_display,
            pdf_status,
            pdf_ready_at,
            delivery_status,
            idempotency_key
        `,
        [
          reviewedStatuses_(),
          limit,
          assembledBy,
          TERMINAL_NOT_ASSESSED_SPEAKING_STATUSES,
          TERMINAL_NOT_ASSESSED_REVIEW_STATUSES,
          speakingRequiredForPdf_(),
          speakingUnavailableMessage_()
        ]
      );

      await client.query("commit");

      return {
        ok: true,
        status: result.rowCount > 0 ? "ASSEMBLED" : "NO_FULLY_REVIEWED_ASSIGNMENTS",
        rule: speakingRequiredForPdf_()
          ? "One final_feedback row is created when writing is reviewed and speaking is either reviewed or terminal not assessed for the same submission_id."
          : "PDF_REQUIRE_SPEAKING is false: one final_feedback row is created as soon as writing is reviewed, regardless of speaking readiness. Speaking shows a technical-difficulties placeholder until it catches up.",
        speaking_required_for_pdf: speakingRequiredForPdf_(),
        assembled_count: result.rowCount,
        final_feedback: result.rows,
        checked_at: nowIso_()
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}
