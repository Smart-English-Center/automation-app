import crypto from "node:crypto";
import { withSupabaseClient } from "./client.js";
import { studentFacingName } from "../studentFacingName.js";

const STUDENT_FEEDBACK_SOURCE_TYPE = "STUDENT_FEEDBACK_PDF";
const STUDENT_FEEDBACK_TEST_SOURCE_TYPE = "STUDENT_FEEDBACK_PDF_TEST";
const RETIRED_AUTOMATIC_REMINDER_SOURCE_TYPES = [
  "BAD_SPEAKPIPE_LINK_STUDENT",
  "STUDENT_NO_SUBMISSION_REMINDER",
  "STUDENT_NO_SUBMISSION_REMINDER_TEST",
  "WEEKLY_NO_ASSIGNMENT_WARNING",
  "WEEKLY_NO_ASSIGNMENT_TEACHER_ALERT",
  "MONTHLY_INACTIVE_STUDENT_REACTIVATION",
  "MONTHLY_INACTIVE_STUDENT_REACTIVATION_TEST"
];
const DEFAULT_SUMMARY_SOURCE_TYPES = [
  STUDENT_FEEDBACK_SOURCE_TYPE,
  STUDENT_FEEDBACK_TEST_SOURCE_TYPE,
  "WEEKLY_ACTIVE_STUDENT_ENCOURAGEMENT",
  "WEEKLY_ACTIVE_STUDENT_ENCOURAGEMENT_TEST",
  "WEEKLY_ACTIVE_TEACHER_ENCOURAGEMENT",
  "WEEKLY_ACTIVE_TEACHER_ENCOURAGEMENT_TEST",
  "ASSIGNMENT_RECEIPT_ACK",
  "BAD_SPEAKPIPE_LINK_TEACHER_ALERT",
  "BAD_WRITING_SUBMISSION_STUDENT",
  "BAD_WRITING_SUBMISSION_TEACHER_ALERT",
  "QUIZ_COMPLETION_ACK",
  "TWICE_MONTHLY_PROGRESS_REPORT",
  "TWICE_MONTHLY_PROGRESS_REPORT_TEST",
  "MAINTAINER_ALERT",
  "EMAIL_DESIGN_SAMPLE_ASSIGNMENT_RECEIPT",
  "EMAIL_DESIGN_SAMPLE_BAD_SPEAKPIPE_STUDENT",
  "EMAIL_DESIGN_SAMPLE_BAD_SPEAKPIPE_TEACHER",
  "EMAIL_DESIGN_SAMPLE_QUIZ_CONFIRMATION",
  "TEACHER_PROGRESS_DIGEST",
  "TEACHER_PROGRESS_DIGEST_TEST"
];
const DEFAULT_QUEUE_LIMIT = 10;
const DEFAULT_SEND_LIMIT = 1;
const MAX_LIMIT = 100;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_MINUTES = 30;

function nowIso_() {
  return new Date().toISOString();
}

function clean_(value) {
  return String(value ?? "").trim();
}

function cleanLower_(value) {
  return clean_(value).toLowerCase();
}

function normaliseLimit_(value, fallback = DEFAULT_QUEUE_LIMIT, max = MAX_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normaliseBoolean_(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const clean = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(clean)) return true;
  if (["0", "false", "no", "n", "off"].includes(clean)) return false;
  return fallback;
}

function normaliseSourceTypes_(value, fallback = [STUDENT_FEEDBACK_SOURCE_TYPE]) {
  if (Array.isArray(value)) {
    const cleaned = value.map((item) => clean_(item).toUpperCase()).filter(Boolean);
    return cleaned.length ? [...new Set(cleaned)] : fallback;
  }

  const cleaned = clean_(value)
    .split(/[;,]/)
    .map((item) => clean_(item).toUpperCase())
    .filter(Boolean);

  return cleaned.length ? [...new Set(cleaned)] : fallback;
}

function hashKey_(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => clean_(part)).join("|"))
    .digest("hex")
    .slice(0, 32);
}

function baseIdempotencyKeyForGroup_(group) {
  if (clean_(group.pdf_job_id)) {
    return `student-feedback-pdf:${clean_(group.pdf_job_id)}`;
  }

  return `student-feedback-pdf:legacy:${hashKey_([
    group.student_id,
    group.student_email,
    group.pdf_drive_url,
    group.pdf_filename,
    (group.final_feedback_ids || []).join(",")
  ])}`;
}

function idempotencyKeyForGroup_(group, options = {}) {
  const baseKey = baseIdempotencyKeyForGroup_(group);
  const testRecipientEmail = cleanLower_(options.testRecipientEmail);

  if (testRecipientEmail) {
    return `${baseKey}:test:${hashKey_([testRecipientEmail])}`;
  }

  return baseKey;
}

function buildSubject_(group, options = {}) {
  const prefix = clean_(options.subjectPrefix || process.env.STUDENT_FEEDBACK_EMAIL_SUBJECT_PREFIX);
  const assignmentCount = Number(group.assignment_count || 0);
  const countLabel = assignmentCount === 1 ? "1 corrected assignment" : `${assignmentCount} corrected assignments`;
  const base = `Your feedback PDF is ready - ${countLabel}`;
  return prefix ? `${prefix} ${base}` : base;
}

function buildHtmlBody_(group, options = {}) {
  const studentName = studentFacingName(group.student_name, "there");
  const pdfDriveUrl = clean_(group.pdf_drive_url);
  const assignmentKeys = Array.isArray(group.assignment_keys) ? group.assignment_keys.filter(Boolean) : [];
  const assignmentCount = Number(group.assignment_count || assignmentKeys.length || 0);
  const countLabel = assignmentCount === 1 ? "1 corrected assignment" : `${assignmentCount} corrected assignments`;
  const readyMessage = "Your corrected feedback PDF is ready.";
  const assignmentList = assignmentKeys.length
    ? `<p><strong>Assignments included:</strong> ${escapeHtml_(assignmentKeys.join(", "))}</p>`
    : "";
  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml_(buildSubject_(group, options))}</title>
  </head>
  <body style="font-family: Arial, sans-serif; line-height: 1.55; color: #111827; background: #f9fafb; margin: 0; padding: 24px;">
    <div style="max-width: 640px; margin: 0 auto; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 24px;">
      <h2 style="margin: 0 0 16px; color: #111827;">John's English Academy</h2>
      <p>Hello ${escapeHtml_(studentName)},</p>
      <p>${escapeHtml_(readyMessage)}</p>
      <p><strong>Report content:</strong> ${escapeHtml_(countLabel)}</p>
      ${assignmentList}
      <p style="margin: 24px 0;">
        <a href="${escapeHtml_(pdfDriveUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:bold;">
          Open your feedback PDF
        </a>
      </p>
      <p>If the button does not open, copy and paste this link into your browser:</p>
      <p style="word-break: break-all;"><a href="${escapeHtml_(pdfDriveUrl)}">${escapeHtml_(pdfDriveUrl)}</a></p>
      <p>Read the corrections carefully and keep practising. Your progress depends on regular review and consistent practice.</p>
      <p>John's English Academy</p>
    </div>
  </body>
</html>
`.trim();
}

function buildTextBody_(group, options = {}) {
  const studentName = studentFacingName(group.student_name, "there");
  const assignmentKeys = Array.isArray(group.assignment_keys) ? group.assignment_keys.filter(Boolean) : [];
  const assignmentCount = Number(group.assignment_count || assignmentKeys.length || 0);
  const countLabel = assignmentCount === 1 ? "1 corrected assignment" : `${assignmentCount} corrected assignments`;
  const readyMessage = "Your corrected feedback PDF is ready.";
  return [
    "John's English Academy",
    `Hello ${studentName},`,
    readyMessage,
    `Report content: ${countLabel}`,
    assignmentKeys.length ? `Assignments included: ${assignmentKeys.join(", ")}` : "",
    `Open your feedback PDF: ${clean_(group.pdf_drive_url)}`,
    "Read the corrections carefully and keep practising.",
    "John's English Academy"
  ].filter(Boolean).join("\n\n");
}

function buildQueuePayload_(group, options = {}) {
  return {
    source: "supabase-email-queue",
    mode: clean_(options.testRecipientEmail) ? "TEST_RECIPIENT_OVERRIDE" : "REAL_STUDENT_DELIVERY",
    actual_student_email: clean_(group.student_email),
    actual_student_name: clean_(group.student_name),
    test_recipient_email: clean_(options.testRecipientEmail),
    test_recipient_name: clean_(options.testRecipientName),
    final_feedback_ids: group.final_feedback_ids || [],
    assignment_keys: group.assignment_keys || [],
    pdf_job_id: clean_(group.pdf_job_id),
    pdf_drive_url: clean_(group.pdf_drive_url),
    pdf_filename: clean_(group.pdf_filename),
    queued_at: nowIso_()
  };
}

function escapeHtml_(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function getEmailQueueSummary(options = {}) {
  const limit = normaliseLimit_(options.limit, 10, 50);
  const sourceTypes = normaliseSourceTypes_(options.sourceTypes || options.source_types, DEFAULT_SUMMARY_SOURCE_TYPES);

  return withSupabaseClient(async (client) => {
    const statusResult = await client.query(
      `
        select
          source_type,
          status,
          count(*)::integer as row_count,
          min(created_at) as oldest_created_at,
          max(updated_at) as newest_updated_at
        from email_queue
        group by source_type, status
        order by source_type, status
      `
    );

    const readyFeedbackResult = await client.query(
      `
        select
          count(*)::integer as ready_final_feedback_count,
          count(distinct coalesce(pdf_job_id::text, pdf_drive_url))::integer as ready_pdf_group_count,
          count(distinct student_id)::integer as ready_student_count
        from final_feedback
        where final_status = 'REVIEWED'
          and pdf_status = 'PDF_READY'
          and delivery_status = 'READY_FOR_EMAIL'
          and nullif(pdf_drive_url, '') is not null
      `
    );

    const sampleResult = await client.query(
      `
        select
          id,
          source_type,
          status,
          recipient_email,
          recipient_name,
          subject,
          pdf_job_id,
          pdf_drive_url,
          pdf_filename,
          attempt_count,
          next_attempt_at,
          error_code,
          left(coalesce(error_message, ''), 500) as error_message,
          created_at,
          updated_at,
          sent_at
        from email_queue
        where source_type = any($1::text[])
        order by
          case status
            when 'QUEUED' then 1
            when 'FAILED_RETRYABLE' then 2
            when 'SENDING' then 3
            when 'FAILED' then 4
            when 'SENT' then 5
            else 6
          end,
          created_at asc
        limit $2
      `,
      [sourceTypes, limit]
    );

    return {
      ok: true,
      status: "EMAIL_QUEUE_SUMMARY",
      ready_student_feedback: readyFeedbackResult.rows[0] || {},
      source_types: sourceTypes,
      counts: statusResult.rows,
      sample: sampleResult.rows,
      checked_at: nowIso_()
    };
  });
}

export async function queueStudentFeedbackEmails(options = {}) {
  const testRecipientEmail = clean_(options.testRecipientEmail || options.test_recipient_email);
  const testRecipientName = clean_(options.testRecipientName || options.test_recipient_name);
  const limit = testRecipientEmail ? 1 : normaliseLimit_(options.limit, DEFAULT_QUEUE_LIMIT);
  const studentId = clean_(options.studentId || options.student_id);
  const studentEmail = cleanLower_(options.studentEmail || options.student_email);
  const pdfJobId = clean_(options.pdfJobId || options.pdf_job_id);
  const finalFeedbackId = clean_(options.finalFeedbackId || options.final_feedback_id);

  return withSupabaseClient(async (client) => {
    await client.query("begin");

    try {
      const groups = await findReadyStudentFeedbackGroups_(client, {
        limit,
        studentId,
        studentEmail,
        pdfJobId,
        finalFeedbackId
      });

      if (!groups.length) {
        await client.query("commit");
        return {
          ok: true,
          status: "NO_READY_STUDENT_FEEDBACK_EMAILS",
          message: "No final_feedback rows are READY_FOR_EMAIL with a Google Drive PDF link.",
          queued_count: 0,
          queued: [],
          checked_at: nowIso_()
        };
      }

      const queued = [];

      for (const group of groups) {
        const queueRow = await upsertStudentFeedbackEmailQueueRow_(client, group, {
          testRecipientEmail,
          testRecipientName
        });

        if (!testRecipientEmail && queueRow?.id) {
          await client.query(
            `
              update final_feedback
              set
                delivery_status = case when $2 = 'SENT' then 'EMAIL_SENT' else 'EMAIL_QUEUED' end,
                email_queue_id = $1,
                email_queued_at = coalesce(email_queued_at, now()),
                updated_at = now(),
                notes = coalesce(notes, '') || ' | Student feedback email queued in Supabase email_queue.'
              where id = any($3::uuid[])
            `,
            [queueRow.id, queueRow.status, group.final_feedback_ids || []]
          );
        }

        queued.push(queueRow);
      }

      await client.query("commit");

      return {
        ok: true,
        status: testRecipientEmail ? "TEST_STUDENT_FEEDBACK_EMAIL_QUEUED" : "STUDENT_FEEDBACK_EMAILS_QUEUED",
        mode: testRecipientEmail ? "TEST_RECIPIENT_OVERRIDE_NO_FINAL_FEEDBACK_STATUS_CHANGE" : "REAL_STUDENT_DELIVERY",
        queued_count: queued.length,
        queued,
        checked_at: nowIso_()
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function findReadyStudentFeedbackGroups_(client, options = {}) {
  const params = [options.limit];
  const filters = [];

  if (options.studentId) {
    params.push(options.studentId);
    filters.push(`ff.student_id = $${params.length}::uuid`);
  }

  if (options.studentEmail) {
    params.push(options.studentEmail);
    filters.push(`lower(ff.student_email) = $${params.length}`);
  }

  if (options.pdfJobId) {
    params.push(options.pdfJobId);
    filters.push(`ff.pdf_job_id = $${params.length}::uuid`);
  }

  if (options.finalFeedbackId) {
    params.push(options.finalFeedbackId);
    filters.push(`ff.id = $${params.length}::uuid`);
  }

  const filterSql = filters.length ? `and ${filters.join(" and ")}` : "";

  const result = await client.query(
    `
      select
        ff.pdf_job_id,
        ff.student_id,
        max(nullif(ff.student_name, '')) as student_name,
        max(nullif(ff.student_email, '')) as student_email,
        ff.pdf_drive_url,
        max(nullif(ff.pdf_filename, '')) as pdf_filename,
        array_agg(ff.id order by ff.assignment_key, ff.created_at, ff.id) as final_feedback_ids,
        array_remove(array_agg(nullif(ff.assignment_key, '') order by ff.assignment_key, ff.created_at, ff.id), null::text) as assignment_keys,
        count(*)::integer as assignment_count,
        min(coalesce(ff.updated_at, ff.created_at)) as oldest_ready_at
      from final_feedback ff
      where ff.final_status = 'REVIEWED'
        and ff.pdf_status = 'PDF_READY'
        and ff.delivery_status = 'READY_FOR_EMAIL'
        and nullif(ff.pdf_drive_url, '') is not null
        ${filterSql}
      group by ff.pdf_job_id, ff.student_id, lower(ff.student_email), ff.pdf_drive_url
      order by min(coalesce(ff.updated_at, ff.created_at)) asc, max(ff.student_name) asc
      limit $1
    `,
    params
  );

  return result.rows;
}

async function upsertStudentFeedbackEmailQueueRow_(client, group, options = {}) {
  const testRecipientEmail = clean_(options.testRecipientEmail);
  const testRecipientName = clean_(options.testRecipientName);
  const sourceType = testRecipientEmail ? STUDENT_FEEDBACK_TEST_SOURCE_TYPE : STUDENT_FEEDBACK_SOURCE_TYPE;
  const recipientEmail = testRecipientEmail || clean_(group.student_email);
  const recipientName = studentFacingName(group.student_name, clean_(group.student_email));

  if (!recipientEmail) {
    throw new Error("Cannot queue student feedback email because recipient_email is missing.");
  }

  const subject = buildSubject_(group, options);
  const bodyHtml = buildHtmlBody_(group, options);
  const bodyText = buildTextBody_(group, options);
  const payloadJson = buildQueuePayload_(group, options);
  const idempotencyKey = idempotencyKeyForGroup_(group, options);

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
        pdf_job_id,
        final_feedback_ids,
        pdf_drive_url,
        pdf_filename,
        payload_json,
        provider,
        created_at,
        updated_at
      )
      values (
        $1,
        $2::uuid,
        $3,
        'QUEUED',
        $4,
        $5,
        $6,
        $7,
        $8,
        $2::uuid,
        $9::uuid[],
        $10,
        $11,
        $12::jsonb,
        'BREVO',
        now(),
        now()
      )
      on conflict (idempotency_key) do update
      set
        updated_at = now(),
        recipient_email = case when email_queue.status = 'SENT' then email_queue.recipient_email else excluded.recipient_email end,
        recipient_name = case when email_queue.status = 'SENT' then email_queue.recipient_name else excluded.recipient_name end,
        subject = case when email_queue.status = 'SENT' then email_queue.subject else excluded.subject end,
        body_html = case when email_queue.status = 'SENT' then email_queue.body_html else excluded.body_html end,
        body_text = case when email_queue.status = 'SENT' then email_queue.body_text else excluded.body_text end,
        payload_json = case when email_queue.status = 'SENT' then email_queue.payload_json else excluded.payload_json end,
        pdf_drive_url = coalesce(email_queue.pdf_drive_url, excluded.pdf_drive_url),
        pdf_filename = coalesce(email_queue.pdf_filename, excluded.pdf_filename)
      returning
        id,
        source_type,
        source_id,
        idempotency_key,
        status,
        recipient_email,
        recipient_name,
        subject,
        pdf_job_id,
        final_feedback_ids,
        pdf_drive_url,
        pdf_filename,
        attempt_count,
        created_at,
        updated_at,
        sent_at
    `,
    [
      sourceType,
      clean_(group.pdf_job_id) || null,
      idempotencyKey,
      recipientEmail,
      recipientName || recipientEmail,
      subject,
      bodyHtml,
      bodyText,
      group.final_feedback_ids || [],
      clean_(group.pdf_drive_url),
      clean_(group.pdf_filename),
      JSON.stringify(payloadJson)
    ]
  );

  return result.rows[0];
}

export async function claimOneQueuedStudentFeedbackEmail(options = {}) {
  const emailId = clean_(options.emailId || options.email_id);
  const sourceTypes = normaliseSourceTypes_(options.sourceTypes || options.source_types, [STUDENT_FEEDBACK_SOURCE_TYPE]);
  const staleMinutes = normaliseLimit_(options.staleMinutes || process.env.EMAIL_SENDING_STALE_MINUTES, 30, 24 * 60);

  return withSupabaseClient(async (client) => {
    await client.query("begin");

    try {
      const workerId = clean_(options.workerId || options.worker_id || "manual-email-send-one-route");
      const params = [sourceTypes, staleMinutes, workerId, RETIRED_AUTOMATIC_REMINDER_SOURCE_TYPES];
      let emailFilter = "";

      if (emailId) {
        params.push(emailId);
        emailFilter = `and id = $${params.length}::uuid`;
      }

      const result = await client.query(
        `
          with candidate as (
            select id
            from email_queue
            where source_type = any($1::text[])
              and source_type <> all($4::text[])
              and (
                status in ('QUEUED', 'FAILED_RETRYABLE')
                or (
                  status = 'SENDING'
                  and locked_at < now() - make_interval(mins => $2::integer)
                )
              )
              and coalesce(next_attempt_at, now()) <= now()
              ${emailFilter}
            order by created_at asc
            limit 1
            for update skip locked
          )
          update email_queue q
          set
            status = 'SENDING',
            locked_at = now(),
            locked_by = $3,
            attempt_count = coalesce(q.attempt_count, 0) + 1,
            last_attempt_at = now(),
            updated_at = now(),
            error_code = null,
            error_message = null
          where q.id in (select id from candidate)
          returning *
        `,
        params
      );

      await client.query("commit");

      return result.rows[0] || null;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function storeRenderedQueuedEmailContent(options = {}, dependencies = {}) {
  const emailId=clean_(options.emailId||options.email_id);
  const subject=clean_(options.subject);
  const bodyHtml=String(options.bodyHtml??options.body_html??"");
  const bodyText=String(options.bodyText??options.body_text??"");
  if(!emailId)throw new Error("email_id is required to store rendered email content.");
  if(!subject)throw new Error("Rendered email subject must not be empty.");
  if(!clean_(bodyHtml)&&!clean_(bodyText))throw new Error("Rendered email body must not be empty.");
  const withClient=dependencies.withSupabaseClient||withSupabaseClient;
  return withClient(async(client)=>(await client.query(`
    update email_queue
    set subject=$2,body_html=$3,body_text=$4,updated_at=now()
    where id=$1::uuid and status='SENDING'
    returning *
  `,[emailId,subject,bodyHtml||null,bodyText||null])).rows[0]||null);
}

export async function markQueuedEmailSent(options = {}, dependencies = {}) {
  const emailId = clean_(options.emailId || options.email_id);
  const providerMessageId = clean_(options.providerMessageId || options.provider_message_id);

  if (!emailId) {
    throw new Error("email_id is required to mark an email as sent.");
  }

  const withClient = dependencies.withSupabaseClient || withSupabaseClient;
  const queueRow = await withClient(async (client) => {
    await client.query("begin");

    try {
      const result = await client.query(
        `
          update email_queue
          set
            status = 'SENT',
            provider_message_id = coalesce(nullif(provider_message_id, ''), nullif($2, '')),
            sent_at = coalesce(sent_at, now()),
            locked_at = null,
            locked_by = null,
            updated_at = now(),
            error_code = null,
            error_message = null
          where id = $1::uuid
          returning *
        `,
        [emailId, providerMessageId]
      );

      const queueRow = result.rows[0];

      await client.query("commit");
      return queueRow;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  if (!queueRow) return null;

  try {
    const finalization = await withClient(async (client) => {
      await client.query("begin");

      try {
        const result = await finalizeQueuedEmailSideEffects_(client, queueRow);
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    });

    return {
      ...queueRow,
      post_send_finalization_status: "COMPLETED",
      post_send_finalization: finalization
    };
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    console.error(JSON.stringify({
      ok: false,
      event: "EMAIL_POST_SEND_FINALIZATION_FAILED",
      email_queue_id: queueRow.id,
      source_type: queueRow.source_type,
      provider_message_id: queueRow.provider_message_id || providerMessageId || null,
      error: message,
      at: new Date().toISOString()
    }));

    return {
      ...queueRow,
      post_send_finalization_status: "FAILED",
      post_send_finalization_error: message
    };
  }
}

async function finalizeQueuedEmailSideEffects_(client, queueRow) {
  const summary = {
    source_type: clean_(queueRow?.source_type),
    teacher_digest_run_count: 0,
    teacher_digest_message_count: 0,
    teacher_digest_feedback_item_count: 0,
    teacher_digest_quiz_item_count: 0
  };

  if (queueRow?.source_type === STUDENT_FEEDBACK_SOURCE_TYPE) {
    await client.query(
      `
            update final_feedback
            set
              delivery_status = 'EMAIL_SENT',
              email_sent_at = coalesce(email_sent_at, now()),
              updated_at = now(),
              notes = coalesce(notes, '') || ' | Student feedback email sent through Brevo.'
            where id = any($1::uuid[])
          `,
      [queueRow.final_feedback_ids || []]
    );
  }

  if (queueRow?.source_type === 'MAINTAINER_ALERT') {
    await client.query(
      `
            update system_alerts
            set
              email_status = 'SENT',
              email_id = $1::uuid,
              updated_at = now()
            where alert_id = $2::uuid
          `,
      [queueRow.id, queueRow.source_id]
    );
  }

  if (String(queueRow?.source_type || '').includes('TWICE_MONTHLY_PROGRESS_REPORT')) {
    await client.query(
      `
            update student_progress_reports
            set
              email_status = 'SENT',
              email_id = $1::uuid,
              sent_at = coalesce(sent_at, now()),
              updated_at = now()
            where progress_report_id = $2::uuid
          `,
      [queueRow.id, queueRow.source_id]
    );
  }

  if (String(queueRow?.source_type || '') === 'TEACHER_PROGRESS_DIGEST') {
    /*
      email_queue.status is the delivery authority. teacher_digest_runs deliberately
      remains EMAIL_QUEUED because production schemas restrict that column to the
      digest-generation lifecycle values. Do not write EMAIL_SENT to the run row.
    */
    const runResult = await client.query(
      `
        select generated.id
        from teacher_digest_deepseek_runs generated
        join teacher_digest_runs digest on digest.id = generated.teacher_digest_run_id
        where digest.email_queue_id = $1::uuid
          and digest.test_mode = false
          and generated.test_mode = false
      `,
      [queueRow.id]
    );

    const runIds = runResult.rows.map((row) => row.id);
    summary.teacher_digest_run_count = runIds.length;
    if (runIds.length) {
      await client.query(
        `
          update teacher_digest_deepseek_messages
          set status = 'INCLUDED', included_at = coalesce(included_at,now()), updated_at = now()
          where run_id = any($1::uuid[])
            and status = 'VALIDATED'
            and is_test = false
        `,
        [runIds]
      );

      const messageResult = await client.query(
        `
          select id
          from teacher_digest_deepseek_messages
          where run_id = any($1::uuid[])
            and status = 'INCLUDED'
            and is_test = false
        `,
        [runIds]
      );
      const messageIds = messageResult.rows.map((row) => row.id);
      summary.teacher_digest_message_count = messageIds.length;

      if (messageIds.length) {
        const evidenceResult = await client.query(
          `
            with candidates as (
              select
                item.id,
                row_number() over (
                  partition by item.source_kind, item.source_id, item.delivery_key
                  order by generated.cycle_date, item.created_at, item.id
                ) as candidate_rank
              from teacher_digest_deepseek_evidence_items item
              join teacher_digest_deepseek_messages message on message.id = item.message_id
              join teacher_digest_deepseek_runs generated on generated.id = message.run_id
              where item.message_id = any($1::uuid[])
                and item.is_included = false
                and not exists (
                  select 1
                  from teacher_digest_deepseek_evidence_items protected
                  where protected.source_kind = item.source_kind
                    and protected.source_id = item.source_id
                    and protected.delivery_key = item.delivery_key
                    and protected.is_included = true
                )
            )
            update teacher_digest_deepseek_evidence_items item
            set is_included = true, included_at = now()
            from candidates
            where item.id = candidates.id
              and candidates.candidate_rank = 1
            returning item.id,item.source_kind
          `,
          [messageIds]
        );
        summary.teacher_digest_feedback_item_count = evidenceResult.rows.filter((row) => row.source_kind === 'FINAL_FEEDBACK').length;
        summary.teacher_digest_quiz_item_count = evidenceResult.rows.filter((row) => row.source_kind === 'QUIZ_SCORE').length;
      }
      await client.query(
        `update teacher_digest_deepseek_runs
         set status='PUBLISHED',published_at=coalesce(published_at,now()),updated_at=now()
         where id=any($1::uuid[])`,
        [runIds]
      );
    }
  }

  if (String(queueRow?.source_type || '') === 'SPEAKING_TEACHER_MATERIALS') {
    const documentJobIds = Array.isArray(queueRow?.payload_json?.document_job_ids)
      ? queueRow.payload_json.document_job_ids
      : [queueRow.source_id].filter(Boolean);
    await client.query(
      `update speaking_teacher_document_jobs job
       set status='COMPLETED', completed_at=coalesce(completed_at,now()), updated_at=now()
       where job.id=any($1::uuid[])
         and not exists (
           select 1
           from email_queue sibling
           where sibling.source_type='SPEAKING_TEACHER_MATERIALS'
             and sibling.status<>'SENT'
             and (
               coalesce(sibling.payload_json->'document_job_ids','[]'::jsonb) ? job.id::text
               or (sibling.payload_json is null and sibling.source_id=job.id)
             )
         )`,
      [documentJobIds]
    );
  }

  return summary;
}

export async function reconcileSentTeacherDigestInclusions(options = {}, dependencies = {}) {
  const limit = normaliseLimit_(options.limit || options.reconciliation_limit, 25, 500);
  const withClient = dependencies.withSupabaseClient || withSupabaseClient;

  return withClient(async (client) => {
    await client.query("begin");

    try {
      const queueResult = await client.query(
        `
          select eq.*
          from email_queue eq
          where eq.source_type = 'TEACHER_PROGRESS_DIGEST'
            and upper(coalesce(eq.status, '')) = 'SENT'
            and exists (
              select 1
              from teacher_digest_runs digest
              join teacher_digest_deepseek_runs generated on generated.teacher_digest_run_id = digest.id
              join teacher_digest_deepseek_messages message on message.run_id = generated.id
              where digest.email_queue_id = eq.id
                and digest.test_mode = false
                and generated.test_mode = false
                and message.is_test = false
                and (
                  message.status = 'VALIDATED'
                  or exists (
                    select 1
                    from teacher_digest_deepseek_evidence_items evidence
                    where evidence.message_id = message.id
                      and evidence.is_included = false
                  )
                )
            )
          order by eq.sent_at, eq.id
          limit $1::integer
          for update of eq skip locked
        `,
        [limit]
      );

      const finalized = [];
      for (const queueRow of queueResult.rows) {
        finalized.push(await finalizeQueuedEmailSideEffects_(client, queueRow));
      }

      await client.query("commit");
      return {
        ok: true,
        examined_count: queueResult.rows.length,
        finalized_count: finalized.length,
        finalized
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export async function markQueuedEmailFailed(options = {}, dependencies = {}) {
  const emailId = clean_(options.emailId || options.email_id);
  const errorCode = clean_(options.errorCode || options.error_code) || "BREVO_SEND_FAILED";
  const errorMessage = clean_(options.errorMessage || options.error_message);
  const maxAttempts = normaliseLimit_(options.maxAttempts || process.env.EMAIL_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS, 20);
  const retryMinutes = normaliseLimit_(options.retryMinutes || process.env.EMAIL_RETRY_MINUTES, DEFAULT_RETRY_MINUTES, 24 * 60);

  if (!emailId) {
    throw new Error("email_id is required to mark an email as failed.");
  }

  const withClient = dependencies.withSupabaseClient || withSupabaseClient;
  return withClient(async (client) => {
    await client.query("begin");

    try {
      const currentResult = await client.query(
        `select * from email_queue where id = $1::uuid for update`,
        [emailId]
      );
      const current = currentResult.rows[0];

      if (!current) {
        await client.query("commit");
        return null;
      }

      /* A provider-accepted email must never be downgraded and sent again. */
      if (clean_(current.status).toUpperCase() === "SENT") {
        await client.query("commit");
        return current;
      }

      const attempts = Number(current.attempt_count || 0);
      const retryable = attempts < maxAttempts;
      const nextAttemptAt = retryable ? new Date(Date.now() + retryMinutes * 60 * 1000).toISOString() : null;
      const finalStatus = retryable ? "FAILED_RETRYABLE" : "FAILED";

      const result = await client.query(
        `
          update email_queue
          set
            status = $2,
            error_code = $3,
            error_message = $4,
            next_attempt_at = $5::timestamptz,
            locked_at = null,
            locked_by = null,
            updated_at = now()
          where id = $1::uuid
          returning *
        `,
        [emailId, finalStatus, errorCode, errorMessage.slice(0, 4000), nextAttemptAt]
      );

      if (current.source_type === STUDENT_FEEDBACK_SOURCE_TYPE && !retryable) {
        await client.query(
          `
            update final_feedback
            set
              delivery_status = 'EMAIL_FAILED',
              updated_at = now(),
              notes = coalesce(notes, '') || ' | Student feedback email failed after max retries.'
            where id = any($1::uuid[])
          `,
          [current.final_feedback_ids || []]
        );
      }

      if (current.source_type === 'MAINTAINER_ALERT' && !retryable) {
        await client.query(
          `
            update system_alerts
            set
              email_status = 'FAILED',
              updated_at = now()
            where alert_id = $1::uuid
          `,
          [current.source_id]
        );
      }

      if (String(current.source_type || '').includes('TWICE_MONTHLY_PROGRESS_REPORT') && !retryable) {
        await client.query(
          `
            update student_progress_reports
            set
              email_status = 'FAILED',
              updated_at = now()
            where progress_report_id = $1::uuid
          `,
          [current.source_id]
        );
      }

      await client.query("commit");
      return result.rows[0];
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

export function getStudentFeedbackEmailSourceTypes() {
  return {
    real: STUDENT_FEEDBACK_SOURCE_TYPE,
    test: STUDENT_FEEDBACK_TEST_SOURCE_TYPE
  };
}

export function getDefaultStudentFeedbackSendLimit() {
  return DEFAULT_SEND_LIMIT;
}
