import { withSupabaseClient } from "./client.js";
import { createRemediationToken, hashRemediationToken } from "../speakingLinkRemediation/security.js";
import {
  claimSpeakingAudioLinkForAssignment,
  SpeakingAudioLinkOwnershipError
} from "./speakingAudioLinkRepository.js";

const SAFE_AUDIO_STATUSES = ["READY_FOR_STORAGE", "STORAGE_FAILED_RETRYABLE", "FAILED_RETRYABLE", "NOT_ASSESSED"];
const SAFE_DRAFT_STATUSES = ["WAITING_FOR_AUDIO_STORAGE", "QUEUED", "FAILED_RETRYABLE", "NOT_ASSESSED"];

function clean_(value) { return String(value ?? "").trim(); }
function lower_(value) { return clean_(value).toLowerCase(); }
function nowIso_() { return new Date().toISOString(); }

export class SpeakingLinkRemediationError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.name = "SpeakingLinkRemediationError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = false;
  }
}

function assertVersion_(row, expectedVersion) {
  const expected = Number(expectedVersion);
  if (!Number.isInteger(expected) || expected < 1) {
    throw new SpeakingLinkRemediationError("INVALID_CASE_VERSION", "Refresh the page before submitting this action.", 409);
  }
  if (Number(row.version) !== expected) {
    throw new SpeakingLinkRemediationError("CASE_CHANGED", "This case was changed in another browser. Refresh the page before continuing.", 409);
  }
}

async function insertAction_(client, row) {
  await client.query(
    `insert into speaking_link_remediation_actions(
       case_id, action_type, previous_status, new_status, previous_link, new_link,
       actor_email, metadata_json, created_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,now())`,
    [
      row.case_id,
      row.action_type,
      row.previous_status || null,
      row.new_status || null,
      row.previous_link || null,
      row.new_link || null,
      lower_(row.actor_email),
      JSON.stringify(row.metadata_json || {})
    ]
  );
}

export async function createSpeakingLinkRemediationCase(client, {
  submission,
  student,
  enrollment,
  speakingTask,
  linkInfo
} = {}) {
  if (!client || !submission?.id || !speakingTask?.id) {
    throw new SpeakingLinkRemediationError("INVALID_REMEDIATION_INPUT", "A submission and speaking task are required.");
  }

  const token = createRemediationToken();
  const result = await client.query(
    `insert into speaking_link_remediation_cases(
       submission_id, student_id, teacher_id, enrollment_id, speaking_task_id,
       original_link, issue_code, issue_message, status, access_token_hash,
       recipient_email, recipient_name, version, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,'AWAITING_ACTION',$9,$10,$11,1,now(),now())
     on conflict(submission_id) do nothing
     returning *`,
    [
      submission.id,
      student?.id || submission.student_id || null,
      enrollment?.teacher_id || submission.teacher_id || null,
      enrollment?.id || null,
      speakingTask.id,
      clean_(submission.audio_link || submission.speakpipe_link),
      clean_(linkInfo?.issue_code || "BAD_SPEAKPIPE_LINK"),
      clean_(linkInfo?.issue_message || "The submitted speaking link is invalid or incomplete."),
      token.hash,
      lower_(enrollment?.teacher_email),
      clean_(enrollment?.teacher_name) || lower_(enrollment?.teacher_email)
    ]
  );

  if (result.rows[0]) {
    await insertAction_(client, {
      case_id: result.rows[0].id,
      action_type: "CASE_CREATED",
      new_status: "AWAITING_ACTION",
      actor_email: enrollment?.teacher_email,
      metadata_json: { issue_code: linkInfo?.issue_code || "BAD_SPEAKPIPE_LINK" }
    });
    return { case: result.rows[0], created: true, token_raw: token.raw };
  }

  const existing = await client.query(
    "select * from speaking_link_remediation_cases where submission_id=$1 limit 1",
    [submission.id]
  );
  return { case: existing.rows[0] || null, created: false, token_raw: "" };
}

async function loadCaseContextWithClient_(client, tokenHash, { forUpdate = false } = {}) {
  const result = await client.query(
    `select
       c.*,
       si.assignment_key, si.level, si.module, si.unit, si.day,
       si.writing_answer, si.answer_text, si.audio_link as submission_audio_link,
       si.speakpipe_link as submission_speakpipe_link,
       s.full_name as student_name, lower(s.email) as student_email,
       t.full_name as teacher_name, lower(t.email) as teacher_email,
       aa.id as audio_asset_id, aa.status as audio_status, aa.source_url as audio_source_url,
       aa.stored_drive_file_id, aa.stored_drive_url,
       d.id as speaking_draft_id, d.status as speaking_draft_status,
       d.review_status as speaking_review_status,
       exists(select 1 from final_feedback ff where ff.submission_id=c.submission_id) as has_final_feedback
     from speaking_link_remediation_cases c
     join submission_inbox si on si.id=c.submission_id
     left join students s on s.id=c.student_id
     left join teachers t on t.id=c.teacher_id
     left join lateral (
       select candidate.* from audio_assets candidate
       where candidate.submission_id=c.submission_id
       order by candidate.created_at desc nulls last, candidate.id desc limit 1
     ) aa on true
     left join lateral (
       select candidate.* from ai_drafts candidate
       where candidate.submission_id=c.submission_id
         and candidate.job_type in ('SPEAKING_EVALUATION','SPEAKING_CORRECTION')
       order by candidate.updated_at desc nulls last, candidate.created_at desc nulls last, candidate.id desc limit 1
     ) d on true
     where c.access_token_hash=$1
     limit 1
     ${forUpdate ? "for update of c" : ""}`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

export async function loadSpeakingLinkRemediationCase(token) {
  const tokenHash = hashRemediationToken(token);
  return withSupabaseClient((client) => loadCaseContextWithClient_(client, tokenHash));
}

async function lockCase_(client, token, expectedVersion) {
  const row = await loadCaseContextWithClient_(client, hashRemediationToken(token), { forUpdate: true });
  if (!row) throw new SpeakingLinkRemediationError("CASE_NOT_FOUND", "This remediation link is invalid.", 404);
  assertVersion_(row, expectedVersion);
  if (row.has_final_feedback) {
    throw new SpeakingLinkRemediationError(
      "FEEDBACK_ALREADY_ASSEMBLED",
      "Feedback processing has already reached its final stage. This page is now read-only.",
      409
    );
  }
  return row;
}

function downstreamStarted_(row) {
  if (!row.audio_asset_id) return false;
  const audioSafe = SAFE_AUDIO_STATUSES.includes(clean_(row.audio_status).toUpperCase()) && !clean_(row.stored_drive_file_id);
  const draftSafe = !row.speaking_draft_id || SAFE_DRAFT_STATUSES.includes(clean_(row.speaking_draft_status).toUpperCase());
  return !(audioSafe && draftSafe);
}

export function speakingLinkRemediationEditState(row) {
  const processingStarted = row.status === "LINK_CORRECTED" && downstreamStarted_(row);
  const canCorrect = !row.has_final_feedback && !processingStarted;
  return {
    canCorrect,
    canResolve: canCorrect && row.status !== "RESOLVED_WITHOUT_SPEAKING",
    processingStarted
  };
}

async function upsertCorrectedAudioAsset_(client, row, canonicalLink) {
  if (row.audio_asset_id) {
    const updated = await client.query(
      `update audio_assets set
         source_url=$2,
         status='READY_FOR_STORAGE',
         resolved_download_url=null,
         stored_drive_file_id=null,
         stored_drive_url=null,
         mime_type=null,
         file_size_bytes=null,
         storage_attempt_count=0,
         last_error_code=null,
         last_error_message=null,
         next_storage_retry_at=null,
         updated_at=now(),
         notes=concat_ws(E'\n',nullif(notes,''),'Speaking link corrected from secure teacher remediation page.')
       where id=$1 returning *`,
      [row.audio_asset_id, canonicalLink]
    );
    return updated.rows[0];
  }

  const inserted = await client.query(
    `insert into audio_assets(
       submission_id, student_id, teacher_id, task_id, source_url, status, created_at, updated_at, notes
     ) values ($1,$2,$3,$4,$5,'READY_FOR_STORAGE',now(),now(),'Created from secure teacher speaking-link remediation page.')
     returning *`,
    [row.submission_id, row.student_id, row.teacher_id, row.speaking_task_id, canonicalLink]
  );
  return inserted.rows[0];
}

async function upsertCorrectedSpeakingDraft_(client, row, canonicalLink) {
  const rawJson = JSON.stringify({
    created_by: "speaking_link_remediation",
    remediation_case_id: row.id,
    corrected_link: canonicalLink,
    corrected_at: nowIso_()
  });

  if (row.speaking_draft_id) {
    const updated = await client.query(
      `update ai_drafts set
         task_id=$2,
         status='WAITING_FOR_AUDIO_STORAGE',
         review_status='NOT_READY',
         score=null,
         reviewed_score=null,
         student_draft_feedback=null,
         teacher_draft_feedback=null,
         reviewed_student_feedback=null,
         review_note=null,
         reviewed_at=null,
         review_provider=null,
         review_model=null,
         transcript=null,
         raw_json=$3::jsonb,
         ai_provider='openai',
         updated_at=now()
       where id=$1 returning *`,
      [row.speaking_draft_id, row.speaking_task_id, rawJson]
    );
    return updated.rows[0];
  }

  const inserted = await client.query(
    `insert into ai_drafts(
       submission_id, student_id, teacher_id, task_id, job_type, status, review_status,
       level, raw_json, ai_provider, created_at, updated_at
     ) values ($1,$2,$3,$4,'SPEAKING_EVALUATION','WAITING_FOR_AUDIO_STORAGE','NOT_READY',$5,$6::jsonb,'openai',now(),now())
     returning *`,
    [row.submission_id, row.student_id, row.teacher_id, row.speaking_task_id, row.level, rawJson]
  );
  return inserted.rows[0];
}

export async function applyCorrectedSpeakingLink({ token, expectedVersion, canonicalLink } = {}, dependencies = {}) {
  const withClient = dependencies.withSupabaseClient || withSupabaseClient;
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const row = await lockCase_(client, token, expectedVersion);
      if (row.status === "LINK_CORRECTED" && clean_(row.canonical_link) === canonicalLink) {
        await client.query("commit");
        return { ok: true, status: "LINK_ALREADY_CORRECTED", case: row, idempotent: true };
      }
      if (row.status === "LINK_CORRECTED" && downstreamStarted_(row)) {
        throw new SpeakingLinkRemediationError(
          "SPEAKING_PROCESSING_ALREADY_STARTED",
          "Speaking processing has already started. The link can no longer be replaced safely from this page.",
          409
        );
      }

      try {
        await claimSpeakingAudioLinkForAssignment(client, {
          canonicalSourceUrl: canonicalLink,
          studentId: row.student_id,
          assignmentKey: row.assignment_key,
          submissionId: row.submission_id
        });
      } catch (error) {
        if (!(error instanceof SpeakingAudioLinkOwnershipError)) throw error;
        throw new SpeakingLinkRemediationError(
          error.code,
          "This SpeakPipe recording already belongs to another student assignment.",
          409
        );
      }
      await client.query(
        `update submission_inbox set speakpipe_link=$2,audio_link=$2,updated_at=now(),
           notes=concat_ws(E'\n',nullif(notes,''),'Speaking link corrected from secure teacher remediation page.')
         where id=$1`,
        [row.submission_id, canonicalLink]
      );
      const audioAsset = await upsertCorrectedAudioAsset_(client, row, canonicalLink);
      const draft = await upsertCorrectedSpeakingDraft_(client, row, canonicalLink);
      const updated = await client.query(
        `update speaking_link_remediation_cases set
           status='LINK_CORRECTED', canonical_link=$2, resolved_action='CORRECT_LINK',
           resolved_at=now(), last_error_code=null, last_error_message=null,
           version=version+1, updated_at=now()
         where id=$1 returning *`,
        [row.id, canonicalLink]
      );
      await insertAction_(client, {
        case_id: row.id,
        action_type: row.status === "LINK_CORRECTED" ? "LINK_REPLACED" : "LINK_CORRECTED",
        previous_status: row.status,
        new_status: "LINK_CORRECTED",
        previous_link: row.canonical_link || row.original_link,
        new_link: canonicalLink,
        actor_email: row.recipient_email,
        metadata_json: { audio_asset_id: audioAsset.id, speaking_draft_id: draft.id }
      });
      await client.query("commit");
      return { ok: true, status: "LINK_CORRECTED", case: updated.rows[0], audio_asset: audioAsset, speaking_draft: draft };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

async function upsertTerminalDraft_(client, row, reason) {
  const rawJson = JSON.stringify({
    created_by: "speaking_link_remediation",
    remediation_case_id: row.id,
    resolution: "CONTINUE_WITHOUT_SPEAKING",
    original_link: row.original_link,
    resolved_at: nowIso_()
  });
  if (row.speaking_draft_id) {
    return (await client.query(
      `update ai_drafts set
         status='NOT_ASSESSED', review_status='BAD_SUBMISSION', score=null, reviewed_score=null,
         student_draft_feedback=null, reviewed_student_feedback='', review_note=$2,
         reviewed_at=now(), review_provider='system', review_model='speaking-link-remediation',
         raw_json=$3::jsonb, updated_at=now()
       where id=$1 returning *`,
      [row.speaking_draft_id, reason, rawJson]
    )).rows[0];
  }
  return (await client.query(
    `insert into ai_drafts(
       submission_id,student_id,teacher_id,task_id,job_type,status,review_status,level,
       score,reviewed_score,student_draft_feedback,reviewed_student_feedback,review_note,
       reviewed_at,review_provider,review_model,raw_json,ai_provider,created_at,updated_at
     ) values ($1,$2,$3,$4,'SPEAKING_EVALUATION','NOT_ASSESSED','BAD_SUBMISSION',$5,
       null,null,null,'',$6,now(),'system','speaking-link-remediation',$7::jsonb,'system',now(),now())
     returning *`,
    [row.submission_id, row.student_id, row.teacher_id, row.speaking_task_id, row.level, reason, rawJson]
  )).rows[0];
}

export async function resolveSpeakingWithoutAudio({ token, expectedVersion } = {}, dependencies = {}) {
  const withClient = dependencies.withSupabaseClient || withSupabaseClient;
  return withClient(async (client) => {
    await client.query("begin");
    try {
      const row = await lockCase_(client, token, expectedVersion);
      if (row.status === "RESOLVED_WITHOUT_SPEAKING") {
        await client.query("commit");
        return { ok: true, status: "ALREADY_RESOLVED_WITHOUT_SPEAKING", case: row, idempotent: true };
      }
      if (row.status === "LINK_CORRECTED" && downstreamStarted_(row)) {
        throw new SpeakingLinkRemediationError(
          "SPEAKING_PROCESSING_ALREADY_STARTED",
          "Speaking processing has already started. This case can no longer be resolved without speaking from this page.",
          409
        );
      }
      const reason = "Speaking was not assessed because the teacher confirmed that no valid SpeakPipe recording could be found.";
      if (row.audio_asset_id) {
        await client.query(
          `update audio_assets set status='NOT_ASSESSED',last_error_code='TEACHER_RESOLVED_WITHOUT_SPEAKING',
             last_error_message=$2,next_storage_retry_at=null,updated_at=now(),
             notes=concat_ws(E'\n',nullif(notes,''),'Teacher resolved remediation without speaking.')
           where id=$1`,
          [row.audio_asset_id, reason]
        );
      }
      const draft = await upsertTerminalDraft_(client, row, reason);
      const updated = await client.query(
        `update speaking_link_remediation_cases set
           status='RESOLVED_WITHOUT_SPEAKING',resolved_action='CONTINUE_WITHOUT_SPEAKING',
           resolved_at=now(),last_error_code=null,last_error_message=null,
           version=version+1,updated_at=now()
         where id=$1 returning *`,
        [row.id]
      );
      await insertAction_(client, {
        case_id: row.id,
        action_type: "RESOLVED_WITHOUT_SPEAKING",
        previous_status: row.status,
        new_status: "RESOLVED_WITHOUT_SPEAKING",
        previous_link: row.canonical_link || row.original_link,
        actor_email: row.recipient_email,
        metadata_json: { speaking_draft_id: draft.id, reason }
      });
      await client.query("commit");
      return { ok: true, status: "RESOLVED_WITHOUT_SPEAKING", case: updated.rows[0], speaking_draft: draft };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}
