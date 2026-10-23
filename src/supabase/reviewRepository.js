import { callDeepSeekReview, getDeepSeekReviewModel } from "../deepseek/reviewClient.js";
import { getDeepSeekReviewConfig } from "../review/reviewProviderConfig.js";
import {
  buildReviewedStudentFeedback,
  parseDeepSeekReviewResponse
} from "../review/reviewResultParser.js";
import { withSupabaseClient } from "./client.js";

const READY_FOR_REVIEW = "READY_FOR_REVIEW";
const REVIEW_IN_PROGRESS = "REVIEW_IN_PROGRESS";
const REVIEW_FAILED_RETRYABLE = "REVIEW_FAILED_RETRYABLE";
const REVIEW_FAILED_FINAL = "REVIEW_FAILED_FINAL";

const DEFAULT_PREVIEW_LIMIT = 10;
const MAX_PREVIEW_LIMIT = 100;
const DEFAULT_STALE_REVIEW_CLAIM_MINUTES = 30;

const REVIEWABLE_STATUSES = [READY_FOR_REVIEW, REVIEW_FAILED_RETRYABLE];
const FINAL_REVIEW_STATUSES = [
  "APPROVED",
  "FIXED",
  "REGENERATED",
  "PARTIAL_FEEDBACK",
  "BAD_SUBMISSION",
  "TEACHER_REVIEW"
];

const TERMINAL_NOT_ASSESSED_SPEAKING_STATUSES = ["NOT_ASSESSED"];
const TERMINAL_NOT_ASSESSED_REVIEW_STATUSES = ["PARTIAL_FEEDBACK", "BAD_SUBMISSION"];

function nowIso_() {
  return new Date().toISOString();
}

function normaliseLimit_(value, fallback = DEFAULT_PREVIEW_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_PREVIEW_LIMIT);
}

function normaliseStaleReviewClaimMinutes_() {
  const parsed = Number(process.env.REVIEW_STALE_IN_PROGRESS_MINUTES || DEFAULT_STALE_REVIEW_CLAIM_MINUTES);
  if (!Number.isFinite(parsed) || parsed < 5) return DEFAULT_STALE_REVIEW_CLAIM_MINUTES;
  return Math.min(Math.floor(parsed), 24 * 60);
}

function isSpeakingJobSql_() {
  return "job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')";
}

function buildCustomId_(draft) {
  const draftToken = String(draft?.id || "").replace(/-/g, "");
  const submissionToken = String(draft?.submission_id || "").replace(/-/g, "");
  return `review_${submissionToken}_${draftToken}`;
}

function isReviewableStatus_(status) {
  return REVIEWABLE_STATUSES.includes(String(status || "").toUpperCase());
}

export async function getReviewPreparationPreview(options = {}) {
  const limit = normaliseLimit_(options.limit);
  const config = getDeepSeekReviewConfig();

  return withSupabaseClient(async (client) => {
    const summaryResult = await client.query(
      `
        with paired_submissions as (
          select
            si.id as submission_id,
            max(w.id::text)::uuid as writing_draft_id,
            max(sp.id::text)::uuid as speaking_draft_id,
            max(w.review_status) as writing_review_status,
            max(sp.review_status) as speaking_review_status,
            max(sp.status) as speaking_status,
            bool_or(sp.status = any($3::text[]) or sp.review_status = any($4::text[])) as speaking_is_terminal_not_assessed
          from submission_inbox si
          join ai_drafts w on w.submission_id = si.id and w.job_type = 'WRITING_CORRECTION'
          join ai_drafts sp on sp.submission_id = si.id and ${isSpeakingJobSql_().replace(/job_type/g, "sp.job_type")}
          group by si.id
        )
        select
          count(*) filter (
            where writing_review_status = any($1::text[])
              and (speaking_review_status = any($1::text[]) or speaking_is_terminal_not_assessed)
          )::integer as complete_ready_submission_count,
          count(*) filter (
            where writing_review_status = any($1::text[])
               or speaking_review_status = any($1::text[])
               or speaking_is_terminal_not_assessed
          )::integer as submission_count_with_reviewable_part,
          count(*) filter (
            where writing_review_status = any($2::text[])
              and speaking_review_status = any($1::text[])
          )::integer as reviewed_writing_missing_speaking_count,
          count(*) filter (
            where (speaking_review_status = any($2::text[]) or speaking_is_terminal_not_assessed)
              and writing_review_status = any($1::text[])
          )::integer as reviewed_speaking_or_not_assessed_missing_writing_count
        from paired_submissions
      `,
      [REVIEWABLE_STATUSES, FINAL_REVIEW_STATUSES, TERMINAL_NOT_ASSESSED_SPEAKING_STATUSES, TERMINAL_NOT_ASSESSED_REVIEW_STATUSES]
    );

    const sampleResult = await client.query(
      `
        select
          si.id as submission_id,
          si.assignment_key,
          si.module,
          si.unit,
          si.day,
          s.full_name as student_name,
          s.email as student_email,
          w.id as writing_draft_id,
          w.id::text as writing_old_import_id,
          w.review_status as writing_review_status,
          w.score as writing_score,
          sp.id as speaking_draft_id,
          sp.id::text as speaking_old_import_id,
          sp.review_status as speaking_review_status,
          sp.status as speaking_status,
          sp.score as speaking_score,
          (sp.status = any($3::text[]) or sp.review_status = any($4::text[])) as speaking_is_terminal_not_assessed
        from submission_inbox si
        join ai_drafts w on w.submission_id = si.id and w.job_type = 'WRITING_CORRECTION'
        join ai_drafts sp on sp.submission_id = si.id and ${isSpeakingJobSql_().replace(/job_type/g, "sp.job_type")}
        left join students s on s.id = si.student_id
        where (
          (w.review_status = any($1::text[]) and (sp.review_status = any($1::text[]) or sp.status = any($3::text[]) or sp.review_status = any($4::text[])))
          or (w.review_status = any($2::text[]) and sp.review_status = any($1::text[]))
          or ((sp.review_status = any($2::text[]) or sp.status = any($3::text[]) or sp.review_status = any($4::text[])) and w.review_status = any($1::text[]))
        )
        order by
          case
            when w.review_status = any($1::text[]) and sp.review_status = any($1::text[]) then 0
            when w.review_status = any($1::text[]) and (sp.status = any($3::text[]) or sp.review_status = any($4::text[])) then 1
            else 2
          end,
          si.created_at nulls last,
          si.id
        limit $5
      `,
      [REVIEWABLE_STATUSES, FINAL_REVIEW_STATUSES, TERMINAL_NOT_ASSESSED_SPEAKING_STATUSES, TERMINAL_NOT_ASSESSED_REVIEW_STATUSES, limit]
    );

    return {
      ok: true,
      mode: "submission_pair_separate_request_preview",
      provider: "deepseek",
      endpoint: config.endpoint,
      model: config.model,
      strategy: "Claim one submission pair, then send writing and speaking to DeepSeek as two separate requests using the normal single-draft prompt.",
      summary: summaryResult.rows[0] || {},
      sample: sampleResult.rows,
      checked_at: nowIso_()
    };
  });
}

async function resetStaleReviewClaims_(client) {
  const staleMinutes = normaliseStaleReviewClaimMinutes_();

  const result = await client.query(
    `
      update ai_drafts
      set
        review_status = $2,
        reviewed_score = null,
        reviewed_student_feedback = null,
        review_note = null,
        reviewed_at = null,
        review_provider = null,
        review_model = null,
        teacher_review_reason = null,
        updated_at = now()
      where job_type in ('WRITING_CORRECTION', 'SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')
        and status = 'COMPLETED'
        and review_status = $1
        and score is not null
        and nullif(trim(coalesce(student_draft_feedback, '')), '') is not null
        and coalesce(updated_at, created_at) < now() - make_interval(mins => $3::integer)
      returning id, submission_id, job_type, status, review_status, updated_at
    `,
    [REVIEW_IN_PROGRESS, READY_FOR_REVIEW, staleMinutes]
  );

  return {
    stale_minutes: staleMinutes,
    reset_count: result.rowCount || 0,
    reset_drafts: result.rows
  };
}

async function claimSubmissionPair_(client) {
  const result = await client.query(
    `
      with latest_writing as (
        select distinct on (submission_id)
          *
        from ai_drafts
        where job_type = 'WRITING_CORRECTION'
        order by submission_id, updated_at desc nulls last, created_at desc nulls last, id
      ), latest_speaking as (
        select distinct on (submission_id)
          *
        from ai_drafts
        where ${isSpeakingJobSql_()}
        order by submission_id, updated_at desc nulls last, created_at desc nulls last, id
      )
      select
        si.id as submission_id,
        si.assignment_key,
        si.module,
        si.unit,
        si.day,
        s.full_name as student_name,
        s.email as student_email,
        w.id as writing_draft_id,
        w.review_status as writing_review_status,
        sp.id as speaking_draft_id,
        sp.review_status as speaking_review_status,
        sp.status as speaking_status,
        coalesce((sp.status = any($3::text[]) or sp.review_status = any($4::text[])), false) as speaking_is_terminal_not_assessed
      from submission_inbox si
      left join latest_writing w on w.submission_id = si.id
      left join latest_speaking sp on sp.submission_id = si.id
      left join students s on s.id = si.student_id
      where si.skill_type = 'ASSIGNMENT'
        and coalesce(si.status, '') <> 'SUPERSEDED_BY_LATEST_SUBMISSION'
        and (
          w.review_status = any($1::text[])
          or sp.review_status = any($1::text[])
          or (
            w.review_status = any($2::text[])
            and sp.review_status = any($1::text[])
          )
          or (
            (sp.review_status = any($2::text[]) or sp.status = any($3::text[]) or sp.review_status = any($4::text[]))
            and w.review_status = any($1::text[])
          )
        )
      order by
        case
          when w.review_status = any($1::text[]) and sp.review_status = any($1::text[]) then 0
          when w.review_status = any($1::text[]) or sp.review_status = any($1::text[]) then 1
          else 2
        end,
        si.created_at nulls last,
        si.id
      limit 1
      for update of si skip locked
    `,
    [REVIEWABLE_STATUSES, FINAL_REVIEW_STATUSES, TERMINAL_NOT_ASSESSED_SPEAKING_STATUSES, TERMINAL_NOT_ASSESSED_REVIEW_STATUSES]
  );

  if (result.rows.length === 0) return null;

  const pair = result.rows[0];
  const draftIdsToClaim = [];

  if (pair.writing_draft_id && isReviewableStatus_(pair.writing_review_status)) draftIdsToClaim.push(pair.writing_draft_id);
  if (pair.speaking_draft_id && !pair.speaking_is_terminal_not_assessed && isReviewableStatus_(pair.speaking_review_status)) draftIdsToClaim.push(pair.speaking_draft_id);

  if (draftIdsToClaim.length === 0) return null;

  await client.query(
    `
      update ai_drafts
      set
        review_status = $2,
        review_provider = 'deepseek',
        review_model = $3,
        updated_at = now()
      where id = any($1::uuid[])
    `,
    [draftIdsToClaim, REVIEW_IN_PROGRESS, getDeepSeekReviewModel()]
  );

  return {
    ...pair,
    claimed_draft_ids: draftIdsToClaim
  };
}

async function loadDraftsForReview_(client, draftIds) {
  const result = await client.query(
    `
      select
        d.id,
        d.id::text as old_import_id,
        d.submission_id,
        d.student_id,
        d.teacher_id,
        d.job_type,
        d.level,
        d.score,
        d.transcript,
        d.student_draft_feedback,
        d.raw_json,
        d.task_achievement_score,
        d.grammar_score,
        d.vocabulary_score,
        d.organisation_score,
        d.spelling_score,
        d.clarity_naturalness_score,
        d.pronunciation_score,
        d.fluency_score,
        si.assignment_key,
        si.module,
        si.unit,
        si.day,
        si.writing_answer,
        si.writing_task_instruction,
        si.speaking_task_instruction,
        si.writing_choice_text,
        si.speaking_choice_text,
        si.speakpipe_link,
        si.audio_link,
        s.full_name as student_name,
        s.email as student_email,
        t.full_name as teacher_name,
        coalesce(tc.task_code, tc.task_key, tc.id::text) as task_old_import_id,
        tc.choice_text,
        tc.full_instruction
      from ai_drafts d
      left join submission_inbox si on si.id = d.submission_id
      left join students s on s.id = d.student_id
      left join teachers t on t.id = d.teacher_id
      left join task_catalog tc on tc.id = d.task_id
      where d.id = any($1::uuid[])
      order by case when d.job_type = 'WRITING_CORRECTION' then 0 else 1 end, d.id
    `,
    [draftIds]
  );

  return result.rows.map((draft) => ({
    ...draft,
    custom_id: buildCustomId_(draft)
  }));
}

async function saveDraftReviewSuccess_(client, { draft, parsed, model }) {
  const reviewedFeedback = buildReviewedStudentFeedback({
    originalFeedback: draft.student_draft_feedback,
    parsedReview: parsed
  });

  await client.query(
    `
      update ai_drafts
      set
        review_status = $2,
        reviewed_score = $3,
        reviewed_student_feedback = $4,
        review_note = $5,
        reviewed_at = now(),
        review_provider = 'deepseek',
        review_model = $6,
        teacher_review_reason = $7,
        teacher_email_subject = coalesce(nullif($8, ''), teacher_email_subject),
        updated_at = now()
      where id = $1
    `,
    [
      draft.id,
      parsed.review_status,
      parsed.final_score,
      reviewedFeedback,
      parsed.review_note,
      model,
      parsed.teacher_review_reason,
      parsed.email_subject
    ]
  );
}

async function saveDraftReviewFailure_(client, { draft, errorCode, errorMessage, details = null }) {
  await client.query(
    `
      update ai_drafts
      set
        review_status = $2,
        review_provider = 'deepseek',
        review_model = $3,
        review_note = $4,
        updated_at = now()
      where id = $1
    `,
    [
      draft.id,
      REVIEW_FAILED_RETRYABLE,
      getDeepSeekReviewModel(),
      String(errorMessage || "DeepSeek review failed.").slice(0, 2000)
    ]
  );

  await client.query(
    `
      insert into errors (
        severity,
        status,
        source_type,
        source_id,
        stage,
        error_code,
        message,
        details_json,
        created_at,
        updated_at
      )
      values ('ERROR', 'OPEN', 'ai_drafts', $1, 'DEEPSEEK_REVIEW_QC', $2, $3, $4::jsonb, now(), now())
    `,
    [
      draft.id,
      errorCode || "DEEPSEEK_REVIEW_ERROR",
      String(errorMessage || "DeepSeek review failed.").slice(0, 2000),
      JSON.stringify(details || {})
    ]
  );
}

async function processSingleDraft_(draft) {
  const model = getDeepSeekReviewModel();

  try {
    const response = await callDeepSeekReview({ draft, model });
    const parsed = parseDeepSeekReviewResponse({
      customId: draft.custom_id,
      response
    });

    if (!parsed.ok) {
      return {
        ok: false,
        draft,
        parsed,
        error_code: parsed.error_code || "REVIEW_JSON_PARSE_FAILED",
        error_message: parsed.error_message || "Could not parse DeepSeek review JSON.",
        provider_response: {
          provider: response.provider,
          model: response.model,
          usage: response.usage,
          content_preview: String(response.content || "").slice(0, 1000),
          reasoning_content_available: Boolean(response.reasoning_content)
        }
      };
    }

    return {
      ok: true,
      draft,
      parsed,
      provider_response: {
        provider: response.provider,
        model: response.model,
        usage: response.usage,
        reasoning_content_available: Boolean(response.reasoning_content)
      }
    };
  } catch (error) {
    return {
      ok: false,
      draft,
      error_code: error.status ? `DEEPSEEK_HTTP_${error.status}` : "DEEPSEEK_REVIEW_ERROR",
      error_message: String(error && error.message ? error.message : error),
      error_body: error.body || null
    };
  }
}

export async function processReviewSubmissionPair(options = {}) {
  let pair = null;
  let drafts = [];
  let staleClaimRecovery = { stale_minutes: normaliseStaleReviewClaimMinutes_(), reset_count: 0, reset_drafts: [] };

  await withSupabaseClient(async (client) => {
    await client.query("begin");

    try {
      staleClaimRecovery = await resetStaleReviewClaims_(client);
      pair = await claimSubmissionPair_(client);

      if (pair) {
        drafts = await loadDraftsForReview_(client, pair.claimed_draft_ids);
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  if (!pair || drafts.length === 0) {
    return {
      ok: true,
      status: "NO_READY_SUBMISSION_PAIR",
      message: "No submission has a reviewable writing/speaking pair right now.",
      stale_review_claim_recovery: staleClaimRecovery,
      checked_at: nowIso_()
    };
  }

  const results = [];

  for (const draft of drafts) {
    const result = await processSingleDraft_(draft);
    results.push(result);

    await withSupabaseClient(async (client) => {
      await client.query("begin");

      try {
        if (result.ok) {
          await saveDraftReviewSuccess_(client, {
            draft,
            parsed: result.parsed,
            model: getDeepSeekReviewModel()
          });
        } else {
          await saveDraftReviewFailure_(client, {
            draft,
            errorCode: result.error_code,
            errorMessage: result.error_message,
            details: {
              submission_id: pair.submission_id,
              assignment_key: pair.assignment_key,
              job_type: draft.job_type,
              parsed: result.parsed || null,
              provider_response: result.provider_response || null,
              error_body: result.error_body || null
            }
          });
        }

        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });
  }

  const successCount = results.filter((result) => result.ok).length;
  const failedCount = results.length - successCount;

  return {
    ok: failedCount === 0,
    status: failedCount === 0 ? "SUBMISSION_PAIR_REVIEWED" : "SUBMISSION_PAIR_REVIEWED_WITH_ERRORS",
    provider: "deepseek",
    model: getDeepSeekReviewModel(),
    submission: {
      submission_id: pair.submission_id,
      assignment_key: pair.assignment_key,
      student_name: pair.student_name,
      student_email: pair.student_email
    },
    processed_count: results.length,
    stale_review_claim_recovery: staleClaimRecovery,
    success_count: successCount,
    failed_count: failedCount,
    items: results.map((result) => ({
      old_import_id: result.draft.old_import_id,
      draft_id: result.draft.id,
      job_type: result.draft.job_type,
      ok: result.ok,
      review_status: result.parsed?.review_status || (result.ok ? null : REVIEW_FAILED_RETRYABLE),
      reviewed_score: result.parsed?.final_score ?? null,
      error_code: result.ok ? null : result.error_code,
      error_message: result.ok ? null : result.error_message
    })),
    checked_at: nowIso_()
  };
}

export async function listReviewBatches() {
  return {
    ok: true,
    status: "REVIEW_QC_BATCHES_DISABLED",
    provider: "deepseek",
    message: "Review QC no longer uses ai_batches. Use /worker/review/process-submission to process one submission pair as two separate DeepSeek requests.",
    checked_at: nowIso_()
  };
}

export async function prepareReviewBatch() {
  return {
    ok: false,
    status: "REVIEW_QC_BATCHES_DISABLED",
    provider: "deepseek",
    message: "Review QC no longer prepares batches. Use /worker/review/process-submission.",
    checked_at: nowIso_()
  };
}

export async function submitPreparedReviewBatch() {
  return {
    ok: false,
    status: "REVIEW_QC_BATCHES_DISABLED",
    provider: "deepseek",
    message: "Review QC no longer submits batches. Use /worker/review/process-submission.",
    checked_at: nowIso_()
  };
}

export async function pollSubmittedReviewBatch() {
  return {
    ok: false,
    status: "REVIEW_QC_BATCHES_DISABLED",
    provider: "deepseek",
    message: "Review QC no longer polls review batches. Use /worker/review/process-submission.",
    checked_at: nowIso_()
  };
}
