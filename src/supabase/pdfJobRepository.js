import { createPdfMonkeyDocument, getPdfMonkeyDocumentCard, getPdfMonkeyConfigStatus } from "../pdfmonkeyClient.js";
import { getGoogleDrivePdfConfigStatus, uploadPdfUrlToGoogleDrive } from "../google/driveClient.js";
import { buildDefaultStudentPdfFilename, buildPdfPayloadForFinalFeedbackIds } from "./pdfPayloadRepository.js";
import { withSupabaseClient } from "./client.js";

const DEFAULT_LIMIT = 1;
const MAX_LIMIT = 10;
const DEFAULT_MAX_ASSIGNMENTS_PER_PDF = 7;
const JOB_TYPE = "STUDENT_FEEDBACK_PDF";
const PROVIDER = "pdfmonkey";

const FINAL_FEEDBACK_FRESHNESS_GUARD_SQL = `
  ff.pdf_ready_at is not null
  and not exists (
    select 1
    from ai_drafts current_draft
    where current_draft.submission_id = ff.submission_id
      and current_draft.job_type in ('WRITING_CORRECTION', 'SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')
      and coalesce(
        current_draft.reviewed_at,
        current_draft.updated_at,
        current_draft.created_at
      ) > ff.pdf_ready_at
  )
`;

function nowIso_() {
  return new Date().toISOString();
}

function clean_(value) {
  return String(value ?? "").trim();
}

function normaliseLimit_(value, fallback = DEFAULT_LIMIT, max = MAX_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normaliseBoolean_(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const clean = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(clean);
}

function schedulerTimezone_() {
  return clean_(process.env.SCHEDULER_TIMEZONE || process.env.TZ) || "Africa/Douala";
}

function maxAssignmentsPerPdf_(value) {
  return normaliseLimit_(value || process.env.PDF_MAX_ASSIGNMENTS_PER_STUDENT || DEFAULT_MAX_ASSIGNMENTS_PER_PDF, DEFAULT_MAX_ASSIGNMENTS_PER_PDF, DEFAULT_MAX_ASSIGNMENTS_PER_PDF);
}

function statusFromPdfMonkey_(card = {}) {
  return clean_(card.status).toLowerCase();
}

function isPdfMonkeySuccess_(card = {}) {
  return statusFromPdfMonkey_(card) === "success" && clean_(card.download_url);
}

function isPdfMonkeyFailure_(card = {}) {
  return ["failure", "failed", "error"].includes(statusFromPdfMonkey_(card));
}

async function claimNextReadyPayload_(client, options = {}) {
  const studentEmail = clean_(options.studentEmail).toLowerCase();
  const studentId = clean_(options.studentId);
  const finalFeedbackId = clean_(options.finalFeedbackId || options.final_feedback_id);
  const maxAssignments = maxAssignmentsPerPdf_(options.maxAssignments);
  const includeSameDayReady = normaliseBoolean_(options.includeSameDayReady, normaliseBoolean_(process.env.PDF_INCLUDE_SAME_DAY_READY, false));
  const timezone = schedulerTimezone_();

  const params = [maxAssignments, includeSameDayReady, timezone];
  let filter = "";
  let selectedRowsFilter = "";

  if (finalFeedbackId) {
    params.push(finalFeedbackId);
    filter = `and ff.id = $${params.length}::uuid`;
    selectedRowsFilter = filter;
  } else if (studentId) {
    params.push(studentId);
    filter = `and ff.student_id = $${params.length}::uuid`;
  } else if (studentEmail) {
    params.push(studentEmail);
    filter = `and lower(ff.student_email) = $${params.length}`;
  }

  const claimResult = await client.query(
    `
      with eligible as (
        select
          ff.id,
          ff.student_id,
          coalesce(ff.pdf_ready_at, ff.updated_at, ff.created_at) as ready_at
        from final_feedback ff
        left join submission_inbox si on si.id = ff.submission_id
        where ff.final_status = 'REVIEWED'
          and ff.pdf_status = 'READY_FOR_PDF'
          and coalesce(si.status, '') <> 'SUPERSEDED_BY_LATEST_SUBMISSION'
          ${filter}
          and ${FINAL_FEEDBACK_FRESHNESS_GUARD_SQL}
          and (
            $2::boolean = true
            or coalesce(ff.pdf_ready_at, ff.updated_at, ff.created_at) < (date_trunc('day', now() at time zone $3) at time zone $3)
          )
      ), selected_student as (
        select student_id
        from eligible
        group by student_id
        order by min(ready_at) asc, student_id
        limit 1
      ), selected_rows as (
        select ff.id
        from final_feedback ff
        join selected_student ss on ss.student_id = ff.student_id
        left join submission_inbox si on si.id = ff.submission_id
        where ff.final_status = 'REVIEWED'
          and ff.pdf_status = 'READY_FOR_PDF'
          and coalesce(si.status, '') <> 'SUPERSEDED_BY_LATEST_SUBMISSION'
          ${selectedRowsFilter}
          and ${FINAL_FEEDBACK_FRESHNESS_GUARD_SQL}
          and (
            $2::boolean = true
            or coalesce(ff.pdf_ready_at, ff.updated_at, ff.created_at) < (date_trunc('day', now() at time zone $3) at time zone $3)
          )
        order by coalesce(ff.pdf_ready_at, ff.updated_at, ff.created_at) asc, ff.assignment_key, ff.created_at, ff.id
        limit $1
        for update of ff skip locked
      )
      update final_feedback ff
      set
        pdf_status = 'PDF_CLAIMED',
        updated_at = now(),
        notes = coalesce(ff.notes, '') || ' | Claimed for PDFMonkey generation.'
      where ff.id in (select id from selected_rows)
      returning ff.id
    `,
    params
  );

  const finalFeedbackIds = claimResult.rows.map((row) => row.id);

  if (!finalFeedbackIds.length) {
    return null;
  }

  const { rows, payload } = await buildPdfPayloadForFinalFeedbackIds(client, finalFeedbackIds);

  if (!payload || !rows.length) {
    throw new Error("Claimed final_feedback rows but could not build a PDF payload.");
  }

  const filename = buildDefaultStudentPdfFilename(payload);

  const jobResult = await client.query(
    `
      insert into pdf_jobs (
        job_type,
        provider,
        status,
        final_feedback_ids,
        student_id,
        student_email,
        student_name,
        payload_json,
        filename,
        notes,
        created_at,
        updated_at
      )
      values (
        $1,
        $2,
        'CLAIMED',
        $3::uuid[],
        $4::uuid,
        $5,
        $6,
        $7::jsonb,
        $8,
        $9,
        now(),
        now()
      )
      returning *
    `,
    [
      JOB_TYPE,
      PROVIDER,
      finalFeedbackIds,
      payload.student.id,
      payload.student.email,
      payload.student.name,
      JSON.stringify(payload),
      filename,
      `Claimed ${finalFeedbackIds.length} final_feedback row(s) for one student PDF. Max per PDF: ${maxAssignments}. Same-day ready included: ${includeSameDayReady}.`
    ]
  );

  return {
    job: jobResult.rows[0],
    payload,
    final_feedback_ids: finalFeedbackIds,
    filename,
    max_assignments_per_pdf: maxAssignments,
    include_same_day_ready: includeSameDayReady
  };
}

async function markPdfJobFailed_(client, jobId, finalFeedbackIds, error) {
  const message = String(error && error.message ? error.message : error);

  await client.query(
    `
      update pdf_jobs
      set
        status = 'FAILED',
        error_code = 'PDFMONKEY_CREATE_FAILED',
        error_message = $2,
        updated_at = now(),
        notes = coalesce(notes, '') || ' | PDFMonkey creation failed.'
      where id = $1
    `,
    [jobId, message]
  );

  await client.query(
    `
      update final_feedback
      set
        pdf_status = 'READY_FOR_PDF',
        updated_at = now(),
        notes = coalesce(notes, '') || ' | PDF generation failed before submission; reset to READY_FOR_PDF.'
      where id = any($1::uuid[])
    `,
    [finalFeedbackIds]
  );
}

export async function getPdfJobSummary() {
  return withSupabaseClient(async (client) => {
    const jobSummary = await client.query(
      `
        select
          status,
          provider,
          count(*)::integer as job_count
        from pdf_jobs
        where job_type = $1
        group by status, provider
        order by status, provider
      `,
      [JOB_TYPE]
    );

    const feedbackSummary = await client.query(
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
      pdfmonkey_config: getPdfMonkeyConfigStatus(),
      google_drive_config: getGoogleDrivePdfConfigStatus(),
      pdf_jobs: jobSummary.rows,
      final_feedback: feedbackSummary.rows,
      checked_at: nowIso_()
    };
  });
}

export async function generateNextPdfJob(options = {}) {
  return withSupabaseClient(async (client) => {
    await client.query("begin");

    let claimed;

    try {
      claimed = await claimNextReadyPayload_(client, options);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }

    if (!claimed) {
      return {
        ok: true,
        status: "NO_READY_PDF_PAYLOAD",
        message: "No reviewed final_feedback rows are ready for PDF generation.",
        checked_at: nowIso_()
      };
    }

    const { job, payload, final_feedback_ids: finalFeedbackIds, filename, max_assignments_per_pdf: maxAssignmentsPerPdf, include_same_day_ready: includeSameDayReady } = claimed;

    try {
      const created = await createPdfMonkeyDocument(payload, {
        filename,
        meta: {
          pdf_job_id: job.id,
          final_feedback_ids: finalFeedbackIds.join(",")
        }
      });

      return await withSupabaseClient(async (updateClient) => {
        await updateClient.query("begin");

        try {
          const updatedJob = await updateClient.query(
            `
              update pdf_jobs
              set
                status = 'SUBMITTED',
                provider_document_id = $2,
                submitted_at = now(),
                updated_at = now(),
                notes = coalesce(notes, '') || ' | Submitted to PDFMonkey.'
              where id = $1
              returning *
            `,
            [job.id, created.document_id]
          );

          await updateClient.query(
            `
              update final_feedback
              set
                pdf_status = 'PDF_SUBMITTED',
                updated_at = now(),
                notes = coalesce(notes, '') || ' | Submitted to PDFMonkey document ' || $2 || '.'
              where id = any($1::uuid[])
            `,
            [finalFeedbackIds, created.document_id]
          );

          await updateClient.query("commit");

          return {
            ok: true,
            status: "PDF_SUBMITTED",
            pdf_job: updatedJob.rows[0],
            final_feedback_ids: finalFeedbackIds,
            assignment_count: payload?.document?.assignment_count || finalFeedbackIds.length,
            max_assignments_per_pdf: maxAssignmentsPerPdf,
            include_same_day_ready: includeSameDayReady,
            pdfmonkey_document_id: created.document_id,
            filename,
            checked_at: nowIso_()
          };
        } catch (error) {
          await updateClient.query("rollback");
          throw error;
        }
      });
    } catch (error) {
      await withSupabaseClient(async (failedClient) => {
        await markPdfJobFailed_(failedClient, job.id, finalFeedbackIds, error);
      });
      throw error;
    }
  });
}

export async function pollPdfJobs(options = {}) {
  const limit = normaliseLimit_(options.limit, Number(process.env.PDFMONKEY_POLL_LIMIT || 3));

  return withSupabaseClient(async (client) => {
    const pendingResult = await client.query(
      `
        select *
        from pdf_jobs
        where job_type = $1
          and provider = $2
          and status in ('SUBMITTED', 'POLLING', 'DRIVE_UPLOAD_FAILED')
          and nullif(provider_document_id, '') is not null
        order by submitted_at asc nulls first, created_at asc
        limit $3
      `,
      [JOB_TYPE, PROVIDER, limit]
    );

    if (!pendingResult.rows.length) {
      return {
        ok: true,
        status: "NO_PENDING_PDF_JOBS",
        message: "No PDFMonkey student feedback jobs are pending.",
        checked_at: nowIso_()
      };
    }

    const results = [];

    for (const job of pendingResult.rows) {
      try {
        await client.query(
          `update pdf_jobs set status = 'POLLING', updated_at = now() where id = $1`,
          [job.id]
        );

        const cardResult = await getPdfMonkeyDocumentCard(job.provider_document_id);
        const card = cardResult.document_card || {};
        const status = statusFromPdfMonkey_(card);
        const downloadUrl = clean_(card.download_url);
        const previewUrl = clean_(card.preview_url);
        const publicShareLink = clean_(card.public_share_link);
        const filename = clean_(card.filename) || clean_(job.filename);

        if (isPdfMonkeySuccess_(card)) {
          await client.query("begin");

          try {
            const updatedJob = await client.query(
              `
                update pdf_jobs
                set
                  status = 'DRIVE_UPLOADING',
                  download_url = $2,
                  preview_url = $3,
                  public_share_link = $4,
                  filename = coalesce(nullif($5, ''), filename),
                  updated_at = now(),
                  error_code = null,
                  error_message = null,
                  notes = coalesce(notes, '') || ' | PDFMonkey completed successfully; Google Drive upload started.'
                where id = $1
                returning *
              `,
              [job.id, downloadUrl, previewUrl, publicShareLink, filename]
            );

            await client.query("commit");

            let driveResult;

            try {
              driveResult = await uploadPdfUrlToGoogleDrive(downloadUrl, {
                filename,
                folderId: process.env.GOOGLE_PDF_OUTPUT_FOLDER_ID || process.env.GOOGLE_DRIVE_PDF_FOLDER_ID || process.env.PDF_GOOGLE_DRIVE_FOLDER_ID || ""
              });
            } catch (driveError) {
              await client.query(
                `
                  update pdf_jobs
                  set
                    status = 'DRIVE_UPLOAD_FAILED',
                    error_code = 'GOOGLE_DRIVE_UPLOAD_FAILED',
                    error_message = $2,
                    updated_at = now(),
                    notes = coalesce(notes, '') || ' | Google Drive upload failed.'
                  where id = $1
                `,
                [job.id, String(driveError && driveError.message ? driveError.message : driveError)]
              );

              await client.query(
                `
                  update final_feedback
                  set
                    pdf_status = 'PDF_DRIVE_FAILED',
                    updated_at = now(),
                    notes = coalesce(notes, '') || ' | PDFMonkey completed, but Google Drive upload failed.'
                  where id = any($1::uuid[])
                `,
                [job.final_feedback_ids || []]
              );

              throw driveError;
            }

            await client.query("begin");

            try {
              const completedJob = await client.query(
                `
                  update pdf_jobs
                  set
                    status = 'COMPLETED',
                    drive_file_id = $2,
                    drive_url = $3,
                    drive_folder_id = $4,
                    drive_uploaded_at = now(),
                    completed_at = now(),
                    updated_at = now(),
                    error_code = null,
                    error_message = null,
                    notes = coalesce(notes, '') || ' | Uploaded to Google Drive and ready for email.'
                  where id = $1
                  returning *
                `,
                [job.id, driveResult.drive_file_id, driveResult.drive_url, driveResult.folder_id || null]
              );

              await client.query(
                `
                  update final_feedback
                  set
                    pdf_status = 'PDF_READY',
                    delivery_status = 'READY_FOR_EMAIL',
                    pdf_job_id = $2,
                    pdf_drive_file_id = $3,
                    pdf_drive_url = $4,
                    pdf_filename = $5,
                    updated_at = now(),
                    notes = coalesce(notes, '') || ' | PDF is stored in Google Drive and ready for email.'
                  where id = any($1::uuid[])
                `,
                [job.final_feedback_ids || [], job.id, driveResult.drive_file_id, driveResult.drive_url, driveResult.filename || filename]
              );

              await client.query("commit");

              results.push({
                ok: true,
                status: "COMPLETED",
                pdf_job: completedJob.rows[0],
                pdfmonkey_status: status,
                download_url: downloadUrl,
                preview_url: previewUrl,
                drive_file_id: driveResult.drive_file_id,
                drive_url: driveResult.drive_url
              });
            } catch (error) {
              await client.query("rollback");
              throw error;
            }
          } catch (error) {
            await client.query("rollback");
            throw error;
          }
        } else if (isPdfMonkeyFailure_(card)) {
          const failureMessage = JSON.stringify({
            status,
            failure_cause: card.failure_cause || "",
            generation_logs: card.generation_logs || []
          });

          await client.query("begin");

          try {
            const failedJob = await client.query(
              `
                update pdf_jobs
                set
                  status = 'FAILED',
                  error_code = 'PDFMONKEY_GENERATION_FAILED',
                  error_message = $2,
                  updated_at = now(),
                  notes = coalesce(notes, '') || ' | PDFMonkey reported a generation failure.'
                where id = $1
                returning *
              `,
              [job.id, failureMessage]
            );

            await client.query(
              `
                update final_feedback
                set
                  pdf_status = 'PDF_FAILED',
                  updated_at = now(),
                  notes = coalesce(notes, '') || ' | PDFMonkey generation failed.'
                where id = any($1::uuid[])
              `,
              [job.final_feedback_ids || []]
            );

            await client.query("commit");

            results.push({ ok: false, status: "FAILED", pdf_job: failedJob.rows[0], error: failureMessage });
          } catch (error) {
            await client.query("rollback");
            throw error;
          }
        } else {
          await client.query(
            `
              update pdf_jobs
              set
                status = 'SUBMITTED',
                updated_at = now(),
                notes = coalesce(notes, '') || ' | PDFMonkey still pending with status: ' || $2 || '.'
              where id = $1
            `,
            [job.id, status || "unknown"]
          );

          results.push({
            ok: true,
            status: "PENDING",
            pdf_job_id: job.id,
            pdfmonkey_document_id: job.provider_document_id,
            pdfmonkey_status: status || "unknown"
          });
        }
      } catch (error) {
        await client.query(
          `
            update pdf_jobs
            set
              status = 'FAILED',
              error_code = 'PDFMONKEY_POLL_FAILED',
              error_message = $2,
              updated_at = now(),
              notes = coalesce(notes, '') || ' | Polling failed.'
            where id = $1
          `,
          [job.id, String(error && error.message ? error.message : error)]
        );

        results.push({
          ok: false,
          status: "POLL_FAILED",
          pdf_job_id: job.id,
          error: String(error && error.message ? error.message : error)
        });
      }
    }

    return {
      ok: results.every((result) => result.ok !== false),
      status: "PDF_POLL_COMPLETE",
      processed_count: results.length,
      results,
      checked_at: nowIso_()
    };
  });
}
