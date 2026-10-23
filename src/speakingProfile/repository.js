import { withSupabaseClient } from "../supabase/client.js";

export async function claimIngest({ eventHash, submittedAt }) {
  return withSupabaseClient(async (client) => {
    const result = await client.query(`
      insert into speaking_profile_ingest_receipts(event_id_hash,status,submitted_at)
      values($1,'processing',$2)
      on conflict(event_id_hash) do update set
        duplicate_count=speaking_profile_ingest_receipts.duplicate_count+1,
        last_received_at=now()
      returning *, (xmax=0) as inserted
    `, [eventHash, submittedAt]);
    return result.rows[0];
  });
}

export async function findActiveStudentByEmail(email) {
  const normalisedEmail = String(email ?? "").trim().toLowerCase();
  return withSupabaseClient(async (client) => {
    const result = await client.query(`
      select id, full_name, lower(trim(email)) as email
      from students
      where lower(trim(email))=$1 and active is true and upper(trim(status))='ACTIVE'
      limit 1
    `, [normalisedEmail]);
    return result.rows[0] || null;
  });
}

export async function createGeneratingReview({ eventHash, email, studentId }) {
  return withSupabaseClient(async (client) => {
    const result = await client.query(`
      insert into speaking_profile_reviews(event_id_hash,student_id,verified_email,workflow_status)
      values($1,$2,$3,'generating_summary')
      on conflict(event_id_hash) do nothing
      returning *
    `, [eventHash, studentId || null, email]);
    if (result.rows[0]) return result.rows[0];
    const existing = await client.query("select * from speaking_profile_reviews where event_id_hash=$1", [eventHash]);
    return existing.rows[0] || null;
  });
}

export async function loadReviewByEventHash(eventHash) {
  return withSupabaseClient(async (client) => (await client.query("select * from speaking_profile_reviews where event_id_hash=$1", [eventHash])).rows[0] || null);
}

export async function loadReviewByTokenHash(tokenHash) {
  return withSupabaseClient(async (client) => (await client.query("select * from speaking_profile_reviews where approval_token_hash=$1", [tokenHash])).rows[0] || null);
}

export async function completeDraft({ reviewId, studentId, summary, tokenHash, expiresAt, pendingMatch }) {
  return withSupabaseClient(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query(`
        update speaking_profile_reviews set
          student_id=$2, workflow_status=$3, draft_summary=$4,
          revision_instructions=null, draft_version=draft_version+1,
          approval_token_hash=$5, approval_token_expires_at=$6,
          email_delivery_status='not_sent', last_email_sent_at=null
        where id=$1 returning *
      `, [reviewId, studentId || null, pendingMatch ? "pending_match" : "pending_review", summary, tokenHash, expiresAt]);
      await client.query("update speaking_profile_ingest_receipts set status=$2 where event_id_hash=$1", [result.rows[0].event_id_hash, pendingMatch ? "pending_match" : "pending_review"]);
      await client.query("commit");
      return result.rows[0];
    } catch (error) { await client.query("rollback"); throw error; }
  });
}

export async function markReviewEmail(reviewId, { sent }) {
  return withSupabaseClient(async (client) => (await client.query(`
    update speaking_profile_reviews set
      email_delivery_status=$2, email_attempt_count=email_attempt_count+1,
      last_email_attempt_at=now(), last_email_sent_at=case when $2='sent' then now() else null end
    where id=$1 returning *
  `, [reviewId, sent ? "sent" : "failed"])).rows[0]);
}

export async function beginRevision({ reviewId, instructions }) {
  return withSupabaseClient(async (client) => (await client.query(`
    update speaking_profile_reviews set workflow_status='revising', revision_instructions=$2,
      revision_number=revision_number+1, email_delivery_status='not_sent', last_email_sent_at=null
    where id=$1 returning *
  `, [reviewId, instructions])).rows[0]);
}

export async function restoreReviewAfterRevisionFailure({ reviewId, summary, tokenHash, expiresAt }) {
  return withSupabaseClient(async (client) => (await client.query(`
    update speaking_profile_reviews set
      workflow_status=case when student_id is null then 'pending_match' else 'pending_review' end,
      draft_summary=$2, revision_instructions=null,
      approval_token_hash=$3, approval_token_expires_at=$4,
      email_delivery_status='failed', last_email_attempt_at=now()
    where id=$1 returning *
  `, [reviewId, summary, tokenHash, expiresAt])).rows[0]);
}

export async function matchReviewStudent({ reviewId, studentId }) {
  return withSupabaseClient(async (client) => (await client.query(`
    update speaking_profile_reviews set student_id=$2, workflow_status='pending_review'
    where id=$1 returning *
  `, [reviewId, studentId])).rows[0]);
}

export async function rotateReviewToken({ reviewId, tokenHash, expiresAt }) {
  return withSupabaseClient(async (client) => (await client.query(`
    update speaking_profile_reviews set approval_token_hash=$2, approval_token_expires_at=$3,
      email_delivery_status='not_sent', last_email_sent_at=null where id=$1 returning *
  `, [reviewId, tokenHash, expiresAt])).rows[0]);
}

export async function approveAndDeleteReview({ reviewId, summary }) {
  return withSupabaseClient(async (client) => {
    await client.query("begin");
    try {
      const locked = (await client.query("select * from speaking_profile_reviews where id=$1 for update", [reviewId])).rows[0];
      if (!locked?.student_id) throw new Error("The review must be matched to an active student before approval.");
      await client.query(`
        insert into student_speaking_profiles(student_id,approved_summary,summary_source,approved_at,updated_at)
        values($1,$2,'form_approval',now(),now())
        on conflict(student_id) do update set approved_summary=excluded.approved_summary,
          summary_source='form_approval', approved_at=now(), updated_at=now()
      `, [locked.student_id, summary]);
      await client.query("update speaking_profile_ingest_receipts set status='approved', resolved_at=now() where event_id_hash=$1", [locked.event_id_hash]);
      await client.query("delete from speaking_profile_reviews where id=$1", [reviewId]);
      await client.query("commit");
      return { ok: true, student_id: locked.student_id };
    } catch (error) { await client.query("rollback"); throw error; }
  });
}

export async function discardAndDeleteReview({ reviewId }) {
  return withSupabaseClient(async (client) => {
    await client.query("begin");
    try {
      const locked = (await client.query(
        "select id,event_id_hash from speaking_profile_reviews where id=$1 for update",
        [reviewId]
      )).rows[0];

      if (!locked) {
        await client.query("rollback");
        return { ok: false, status: "NOT_FOUND" };
      }

      const receipt = await client.query(`
        update speaking_profile_ingest_receipts
        set status='discarded', resolved_at=now()
        where event_id_hash=$1
        returning event_id_hash
      `, [locked.event_id_hash]);

      if (!receipt.rows[0]) {
        throw new Error(
          "The speaking-profile ingest receipt could not be resolved."
        );
      }

      await client.query(
        "delete from speaking_profile_reviews where id=$1",
        [reviewId]
      );
      await client.query("commit");

      return { ok: true, status: "discarded" };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}
