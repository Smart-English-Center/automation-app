import crypto from "node:crypto";
import { withSupabaseClient } from "./client.js";

const ALLOWED_LEVELS = new Set(["A1", "A2", "B1"]);

const REGISTRATION_STATUSES = new Set([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled_duplicate",
  "invalid_teacher",
  "invalid_level",
  "approval_link_expired",
  "approval_failed",
  "already_active_same_teacher"
]);

const NOTIFICATION_STATUSES = new Set([
  "not_sent",
  "sent",
  "partially_failed",
  "failed"
]);

function nowIso_() {
  return new Date().toISOString();
}

function clean_(value) {
  return String(value ?? "").trim();
}

function lower_(value) {
  return clean_(value).toLowerCase();
}

function upper_(value) {
  return clean_(value).toUpperCase();
}

function intOrNull_(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : null;
}

function normalisePhone_(value) {
  return clean_(value).replace(/[\s().-]+/g, "");
}

function hashToken_(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createDecisionToken_() {
  return crypto.randomBytes(32).toString("base64url");
}

function addDays_(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + Number(days || 0));
  return copy;
}

function isoDate_(date) {
  if (!date) return null;
  return new Date(date).toISOString().slice(0, 10);
}

function createRegistrationCohort_(requestId, startAt) {
  const datePart = isoDate_(startAt || new Date()).replace(/-/g, "");
  const idPart = clean_(requestId).replace(/[^a-fA-F0-9]/g, "").slice(0, 10) || crypto.randomBytes(5).toString("hex");
  return `REGISTRATION-${datePart}-${idPart.toUpperCase()}`;
}

function safeJson_(value, fallback = {}) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;

  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normaliseNotificationStatus_(value, fallback = "not_sent") {
  const status = lower_(value || fallback);
  return NOTIFICATION_STATUSES.has(status) ? status : fallback;
}

function normaliseRegistrationStatus_(value, fallback = "pending") {
  const status = lower_(value || fallback);
  return REGISTRATION_STATUSES.has(status) ? status : fallback;
}

function payloadValue_(payload, keys) {
  for (const key of keys) {
    const value = payload?.[key];
    if (value !== undefined && value !== null && clean_(value) !== "") return value;
  }
  return "";
}

function normaliseRegistrationPayload_(payload = {}) {
  const source = payload.source && typeof payload.source === "object" ? payload.source : {};

  const studentEmail = lower_(payloadValue_(payload, [
    "student_email",
    "email",
    "respondent_email",
    "email_address"
  ]));

  const teacherEmail = lower_(payloadValue_(payload, [
    "teacher_email",
    "assigned_teacher_email",
    "requested_teacher_email"
  ]));

  const submittedAt = clean_(payloadValue_(payload, [
    "submitted_at",
    "timestamp",
    "created_at"
  ])) || nowIso_();

  return {
    student_name: clean_(payloadValue_(payload, ["student_name", "full_name", "student_full_name", "name"])),
    student_email: studentEmail,
    student_phone: normalisePhone_(payloadValue_(payload, ["student_phone", "phone", "whatsapp", "student_whatsapp", "whatsapp_number"])),
    country: clean_(payloadValue_(payload, ["country", "student_country", "country_submitted"])),
    level: upper_(payloadValue_(payload, ["level", "student_level", "requested_level"])),
    teacher_email: teacherEmail,
    submitted_at: submittedAt,
    form_id: clean_(payloadValue_(payload, ["form_id", "google_form_id"])) || clean_(source.form_id),
    form_title: clean_(payloadValue_(payload, ["form_title", "google_form_title"])) || clean_(source.form_title),
    response_id: clean_(payloadValue_(payload, ["response_id", "google_response_id"])) || clean_(source.response_id),
    sheet_id: clean_(payloadValue_(payload, ["sheet_id", "spreadsheet_id", "google_spreadsheet_id"])) || clean_(source.sheet_id || source.google_spreadsheet_id),
    sheet_name: clean_(payloadValue_(payload, ["sheet_name", "tab_name", "source_tab"])) || clean_(source.sheet_name || source.source_tab),
    row_number: intOrNull_(payloadValue_(payload, ["row_number", "source_row_number"])),
    raw_answers: safeJson_(payload.raw_answers || payload.named_values || payload.answers, {}),
    raw_payload: payload && typeof payload === "object" ? payload : {}
  };
}

function requestPublicShape_(row = {}) {
  if (!row) return null;

  return {
    id: row.id,
    status: row.status,
    notification_status: row.notification_status,
    submitted_at: row.submitted_at,
    received_at: row.received_at,
    student_name: row.reviewed_student_name || row.student_name_submitted,
    student_email: row.student_email_submitted,
    student_phone: row.reviewed_student_phone || row.student_phone_submitted,
    country: row.reviewed_country || row.country_submitted,
    level: row.reviewed_level || row.level_submitted,
    teacher_email: row.teacher_email_submitted,
    form_id: row.form_id,
    form_title: row.form_title,
    response_id: row.response_id,
    sheet_id: row.sheet_id,
    sheet_name: row.sheet_name,
    row_number: row.row_number,
    existing_student_id: row.existing_student_id,
    existing_student_found: row.existing_student_found,
    teacher_id: row.teacher_id,
    teacher_found: row.teacher_found,
    has_active_enrollment_same_teacher: row.has_active_enrollment_same_teacher,
    same_teacher_active_enrollment_id: row.same_teacher_active_enrollment_id,
    active_enrollments: row.active_enrollments_json || [],
    duplicate_update_count: row.duplicate_update_count || 0,
    approval_token_expires_at: row.approval_token_expires_at,
    approved_by_email: row.approved_by_email,
    approved_at: row.approved_at,
    rejected_by_email: row.rejected_by_email,
    rejected_at: row.rejected_at,
    decision: row.decision,
    access_type: row.access_type,
    enrollment_id: row.enrollment_id,
    registration_start_at: row.registration_start_at,
    registration_end_at: row.registration_end_at,
    decision_error: row.decision_error,
    rejection_reason: row.rejection_reason,
    reviewed_student_name: row.reviewed_student_name,
    reviewed_student_phone: row.reviewed_student_phone,
    reviewed_country: row.reviewed_country,
    reviewed_level: row.reviewed_level,
    reviewed_teacher_email: row.reviewed_teacher_email_normalized,
    student_type: row.raw_payload?.approved_student_type || "group",
    updated_at: row.updated_at
  };
}

async function tableExists_(client, tableName) {
  const result = await client.query("select to_regclass($1) as table_name", [`public.${tableName}`]);
  return Boolean(result.rows[0]?.table_name);
}

async function ensureRegistrationTables_(client) {
  const requestsExists = await tableExists_(client, "registration_requests");
  const logsExists = await tableExists_(client, "registration_email_logs");

  if (!requestsExists) {
    throw new Error("registration_requests table does not exist. Run the corrected registration SQL before using this feature.");
  }

  if (!logsExists) {
    throw new Error("registration_email_logs table does not exist. Run the corrected registration SQL before using this feature.");
  }
}

async function findTeacherByEmail_(client, teacherEmail) {
  if (!teacherEmail) return null;

  const result = await client.query(
    `
      select
        id as teacher_id,
        coalesce(nullif(trim(full_name), ''), nullif(trim(email), ''), 'Teacher') as teacher_name,
        lower(trim(email)) as teacher_email,
        coalesce(nullif(trim(whatsapp_number), ''), nullif(trim(phone), '')) as teacher_phone,
        active,
        status
      from teachers
      where lower(trim(email)) = $1
      limit 1
    `,
    [teacherEmail]
  );

  return result.rows[0] || null;
}

async function findStudentByEmail_(client, studentEmail) {
  if (!studentEmail) return null;

  const result = await client.query(
    `
      select
        id,
        full_name,
        email,
        phone,
        whatsapp_number,
        status,
        active,
        created_at,
        updated_at,
        notes,
        nullif(trim(full_name), '') as resolved_student_name,
        lower(trim(email)) as resolved_student_email,
        coalesce(nullif(trim(whatsapp_number), ''), nullif(trim(phone), '')) as resolved_student_phone,
        nullif(trim(status), '') as resolved_student_status,
        active as resolved_student_active
      from students
      where lower(trim(email)) = $1
      limit 1
    `,
    [studentEmail]
  );

  return result.rows[0] || null;
}

async function loadActiveEnrollmentsForStudent_(client, studentId) {
  if (!studentId) return [];

  const result = await client.query(
    `
      select
        e.id as enrollment_id,
        e.teacher_id,
        lower(trim(t.email)) as teacher_email,
        nullif(trim(t.full_name), '') as teacher_name,
        nullif(trim(e.level), '') as level,
        e.start_date,
        e.end_date,
        e.registration_start_at,
        e.registration_end_at,
        e.access_type
      from enrollments e
      left join teachers t on t.id = e.teacher_id
      where e.student_id = $1
        and e.active is true
        and upper(trim(e.status)) = 'ACTIVE'
      order by coalesce(e.registration_start_at, e.created_at) desc nulls last, e.id
    `,
    [studentId]
  );

  return result.rows;
}

function activeEnrollmentForTeacher_(activeEnrollments, teacherId) {
  if (!teacherId) return null;
  return activeEnrollments.find((enrollment) => String(enrollment.teacher_id) === String(teacherId)) || null;
}

async function closeExpiredRegistrationEnrollmentsForStudent_(client, studentId) {
  if (!studentId) {
    return { expired_enrollment_ids: [], expired_request_ids: [] };
  }

  const expiredResult = await client.query(
    `
      select id, registration_request_id
      from enrollments
      where student_id = $1
        and registration_request_id is not null
        and access_type = 'one_week'
        and registration_end_at is not null
        and registration_end_at <= now()
        and active is true
        and upper(trim(status)) = 'ACTIVE'
      for update
    `,
    [studentId]
  );

  const expiredEnrollmentIds = expiredResult.rows.map((row) => row.id);
  const expiredRequestIds = [...new Set(expiredResult.rows.map((row) => row.registration_request_id).filter(Boolean))];

  if (expiredEnrollmentIds.length) {
    await client.query(
      `
        update enrollments
        set
          active = false,
          status = 'INACTIVE',
          closed_reason = 'REGISTRATION_ACCESS_EXPIRED',
          notes = concat_ws(E'\n', nullif(notes, ''), 'Closed automatically because one-week registration access expired.'),
          updated_at = now()
        where id = any($1::uuid[])
      `,
      [expiredEnrollmentIds]
    );
  }

  if (expiredRequestIds.length) {
    await client.query(
      `
        update registration_requests
        set status = 'expired', updated_at = now()
        where id = any($1::uuid[])
          and status = 'approved'
          and access_type = 'one_week'
      `,
      [expiredRequestIds]
    );
  }

  return {
    expired_enrollment_ids: expiredEnrollmentIds,
    expired_request_ids: expiredRequestIds
  };
}

async function closeActiveEnrollmentsForStudent_(client, studentId, reason = "REGISTRATION_REPLACED_BY_NEW_ENROLLMENT") {
  if (!studentId) return [];

  const activeResult = await client.query(
    `
      select
        e.id as enrollment_id,
        e.teacher_id,
        lower(trim(t.email)) as teacher_email,
        nullif(trim(t.full_name), '') as teacher_name,
        nullif(trim(e.level), '') as level,
        e.cohort,
        e.start_date,
        e.end_date,
        e.registration_start_at,
        e.registration_end_at,
        e.access_type
      from enrollments e
      left join teachers t on t.id = e.teacher_id
      where e.student_id = $1
        and e.active is true
        and upper(trim(e.status)) = 'ACTIVE'
      order by coalesce(e.registration_start_at, e.created_at) desc nulls last, e.id
      for update of e
    `,
    [studentId]
  );

  const activeEnrollments = activeResult.rows;
  const activeEnrollmentIds = activeEnrollments.map((row) => row.enrollment_id).filter(Boolean);

  if (activeEnrollmentIds.length) {
    await client.query(
      `
        update enrollments
        set
          active = false,
          status = 'INACTIVE',
          closed_reason = $2,
          notes = concat_ws(E'\n', nullif(notes, ''), 'Closed automatically because a new registration enrollment replaced this enrollment.'),
          updated_at = now()
        where id = any($1::uuid[])
      `,
      [activeEnrollmentIds, reason]
    );
  }

  return activeEnrollments;
}

async function insertStudent_(client, submitted) {
  const result = await client.query(
    `
      insert into students (
        full_name,
        email,
        phone,
        whatsapp_number,
        status,
        active,
        notes,
        student_type,
        created_at,
        updated_at
      ) values ($1,$2,$3,$3,'ACTIVE',true,$4,$5,now(),now())
      returning *
    `,
    [
      submitted.student_name || submitted.student_email,
      submitted.student_email,
      submitted.student_phone || null,
      "Created automatically from registration approval.",
      submitted.student_type
    ]
  );

  return result.rows[0];
}

async function activateExistingStudent_(client, student, submitted) {
  if (!student?.id) return null;

  const result = await client.query(
    `
      update students
      set
        full_name = coalesce(nullif(trim(full_name), ''), $2),
        phone = coalesce(nullif($3, ''), phone),
        whatsapp_number = coalesce(nullif($3, ''), whatsapp_number),
        status = 'ACTIVE',
        active = true,
        student_type = $4,
        updated_at = now()
      where id = $1
      returning *
    `,
    [
      student.id,
      submitted.student_name || student.full_name || submitted.student_email,
      submitted.student_phone || "",
      submitted.student_type
    ]
  );

  return result.rows[0] || student;
}

async function insertEnrollment_(client, { studentId, teacherId, level, startAt, endAt, registrationRequestId, accessType }) {
  const cohort = createRegistrationCohort_(registrationRequestId, startAt);
  const result = await client.query(
    `
      insert into enrollments (
        student_id,
        teacher_id,
        level,
        cohort,
        status,
        active,
        start_date,
        end_date,
        registration_start_at,
        registration_end_at,
        access_type,
        registration_request_id,
        notes,
        created_at,
        updated_at
      ) values ($1,$2,$3,$4,'ACTIVE',true,$5,$6,$7,$8,$9,$10,$11,now(),now())
      returning *
    `,
    [
      studentId,
      teacherId,
      level,
      cohort,
      isoDate_(startAt),
      endAt ? isoDate_(endAt) : null,
      startAt,
      endAt || null,
      accessType,
      registrationRequestId,
      `Created automatically from registration approval (${accessType}). Cohort: ${cohort}.`
    ]
  );

  return result.rows[0];
}

async function insertRegistrationRequest_(client, submitted, context) {
  const status = normaliseRegistrationStatus_(context.status || "pending");
  const tokenRaw = status === "pending" ? createDecisionToken_() : "";
  const tokenHash = tokenRaw ? hashToken_(tokenRaw) : null;
  const tokenExpiresAt = tokenRaw ? addDays_(new Date(), 7).toISOString() : null;

  const result = await client.query(
    `
      insert into registration_requests (
        status,
        notification_status,
        submitted_at,
        student_name_submitted,
        student_email_submitted,
        student_email_normalized,
        student_phone_submitted,
        country_submitted,
        level_submitted,
        teacher_email_submitted,
        teacher_email_normalized,
        form_id,
        form_title,
        response_id,
        sheet_id,
        sheet_name,
        row_number,
        raw_answers,
        raw_payload,
        existing_student_id,
        existing_student_found,
        teacher_id,
        teacher_found,
        same_teacher_active_enrollment_id,
        has_active_enrollment_same_teacher,
        active_enrollments_json,
        approval_token_hash,
        approval_token_expires_at,
        duplicate_update_count,
        decision_error,
        updated_at
      ) values (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,
        $20,$21,$22,$23,$24,$25,$26::jsonb,$27,$28,$29,$30,now()
      )
      returning *
    `,
    [
      status,
      "not_sent",
      submitted.submitted_at,
      submitted.student_name,
      submitted.student_email,
      submitted.student_email,
      submitted.student_phone,
      submitted.country,
      submitted.level,
      submitted.teacher_email,
      submitted.teacher_email,
      submitted.form_id,
      submitted.form_title,
      submitted.response_id,
      submitted.sheet_id,
      submitted.sheet_name,
      submitted.row_number,
      JSON.stringify(submitted.raw_answers || {}),
      JSON.stringify(submitted.raw_payload || {}),
      context.student?.id || null,
      Boolean(context.student),
      context.teacher?.teacher_id || null,
      Boolean(context.teacher),
      context.sameTeacherActiveEnrollment?.enrollment_id || null,
      Boolean(context.sameTeacherActiveEnrollment),
      JSON.stringify(context.activeEnrollments || []),
      tokenHash,
      tokenExpiresAt,
      0,
      context.decisionError || null
    ]
  );

  return { request: result.rows[0], token_raw: tokenRaw };
}

async function updateDuplicatePendingRequest_(client, existingRequestId, submitted, context) {
  const tokenRaw = createDecisionToken_();
  const tokenHash = hashToken_(tokenRaw);
  const tokenExpiresAt = addDays_(new Date(), 7).toISOString();

  const result = await client.query(
    `
      update registration_requests
      set
        submitted_at = $2,
        received_at = now(),
        student_name_submitted = $3,
        student_email_submitted = $4,
        student_email_normalized = $5,
        student_phone_submitted = $6,
        country_submitted = $7,
        level_submitted = $8,
        teacher_email_submitted = $9,
        teacher_email_normalized = $10,
        form_id = $11,
        form_title = $12,
        response_id = $13,
        sheet_id = $14,
        sheet_name = $15,
        row_number = $16,
        raw_answers = $17::jsonb,
        raw_payload = $18::jsonb,
        existing_student_id = $19,
        existing_student_found = $20,
        teacher_id = $21,
        teacher_found = $22,
        same_teacher_active_enrollment_id = $23,
        has_active_enrollment_same_teacher = $24,
        active_enrollments_json = $25::jsonb,
        approval_token_hash = $26,
        approval_token_expires_at = $27,
        approval_token_used_at = null,
        duplicate_update_count = coalesce(duplicate_update_count, 0) + 1,
        notification_status = 'not_sent',
        decision_error = $28,
        updated_at = now()
      where id = $1
      returning *
    `,
    [
      existingRequestId,
      submitted.submitted_at,
      submitted.student_name,
      submitted.student_email,
      submitted.student_email,
      submitted.student_phone,
      submitted.country,
      submitted.level,
      submitted.teacher_email,
      submitted.teacher_email,
      submitted.form_id,
      submitted.form_title,
      submitted.response_id,
      submitted.sheet_id,
      submitted.sheet_name,
      submitted.row_number,
      JSON.stringify(submitted.raw_answers || {}),
      JSON.stringify(submitted.raw_payload || {}),
      context.student?.id || null,
      Boolean(context.student),
      context.teacher?.teacher_id || null,
      Boolean(context.teacher),
      context.sameTeacherActiveEnrollment?.enrollment_id || null,
      Boolean(context.sameTeacherActiveEnrollment),
      JSON.stringify(context.activeEnrollments || []),
      tokenHash,
      tokenExpiresAt,
      context.decisionError || null
    ]
  );

  return { request: result.rows[0], token_raw: tokenRaw };
}

export async function createOrUpdateRegistrationRequest(payload = {}) {
  return withSupabaseClient(async (client) => {
    await ensureRegistrationTables_(client);

    const submitted = normaliseRegistrationPayload_(payload);
    const validationErrors = [];

    if (!submitted.student_email) validationErrors.push("Missing student email.");
    if (!submitted.level || !ALLOWED_LEVELS.has(submitted.level)) validationErrors.push("Invalid level. Allowed levels: A1, A2, B1.");

    await client.query("begin");

    try {
      const teacher = submitted.teacher_email ? await findTeacherByEmail_(client, submitted.teacher_email) : null;
      const student = submitted.student_email ? await findStudentByEmail_(client, submitted.student_email) : null;
      if (student?.id) {
        await closeExpiredRegistrationEnrollmentsForStudent_(client, student.id);
      }
      const activeEnrollments = student?.id ? await loadActiveEnrollmentsForStudent_(client, student.id) : [];
      const sameTeacherActiveEnrollment = teacher?.teacher_id ? activeEnrollmentForTeacher_(activeEnrollments, teacher.teacher_id) : null;

      let status = "pending";
      let decisionError = "";

      if (validationErrors.some((message) => /level/i.test(message))) {
        status = "invalid_level";
        decisionError = "The submitted level is invalid. Allowed levels: A1, A2, B1.";
      }

      if (!submitted.student_email) {
        status = "approval_failed";
        decisionError = validationErrors.join(" ") || "Required registration fields are missing.";
      }

      const context = {
        status,
        teacher,
        student,
        activeEnrollments,
        sameTeacherActiveEnrollment,
        decisionError
      };

      let writeResult;
      let duplicateUpdated = false;

      if (status === "pending") {
        const duplicate = await client.query(
          `
            select id
            from registration_requests
            where student_email_normalized = $1
              and status = 'pending'
            order by received_at desc
            limit 1
            for update
          `,
          [submitted.student_email]
        );

        if (duplicate.rows[0]?.id) {
          writeResult = await updateDuplicatePendingRequest_(client, duplicate.rows[0].id, submitted, context);
          duplicateUpdated = true;
        } else {
          writeResult = await insertRegistrationRequest_(client, submitted, context);
        }
      } else {
        writeResult = await insertRegistrationRequest_(client, submitted, context);
      }

      await client.query("commit");

      return {
        ok: true,
        status,
        duplicate_updated: duplicateUpdated,
        request: requestPublicShape_(writeResult.request),
        raw_request: writeResult.request,
        token_raw: writeResult.token_raw,
        teacher,
        existing_student: student ? {
          id: student.id,
          name: student.resolved_student_name || student.full_name || "",
          email: student.resolved_student_email || submitted.student_email,
          phone: student.resolved_student_phone || "",
          status: student.resolved_student_status || student.status || "",
          active: student.resolved_student_active
        } : null,
        active_enrollments: activeEnrollments,
        validation_errors: validationErrors,
        checked_at: nowIso_()
      };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

export async function getRegistrationRequestByDecisionToken(token) {
  const tokenHash = hashToken_(token);

  return withSupabaseClient(async (client) => {
    await ensureRegistrationTables_(client);

    const result = await client.query(
      `select * from registration_requests where approval_token_hash = $1 limit 1`,
      [tokenHash]
    );

    return result.rows[0] ? requestPublicShape_(result.rows[0]) : null;
  });
}

export async function updateRegistrationNotificationStatus(requestId, notificationStatus) {
  const status = normaliseNotificationStatus_(notificationStatus);

  return withSupabaseClient(async (client) => {
    await ensureRegistrationTables_(client);

    const result = await client.query(
      `update registration_requests set notification_status = $2, updated_at = now() where id = $1 returning *`,
      [requestId, status]
    );

    return result.rows[0] ? requestPublicShape_(result.rows[0]) : null;
  });
}

export async function logRegistrationEmailAttempt(entry = {}) {
  return withSupabaseClient(async (client) => {
    await ensureRegistrationTables_(client);

    const status = lower_(entry.status || "failed") === "sent" ? "sent" : "failed";
    const result = await client.query(
      `
        insert into registration_email_logs (
          registration_request_id,
          email_type,
          recipient_email,
          recipient_name,
          status,
          sent_at,
          failed_at,
          error_message,
          brevo_message_id,
          metadata_json
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
        returning *
      `,
      [
        entry.registration_request_id || null,
        clean_(entry.email_type || "registration_email"),
        lower_(entry.recipient_email || entry.to_email || ""),
        clean_(entry.recipient_name || entry.to_name || ""),
        status,
        status === "sent" ? new Date() : null,
        status === "failed" ? new Date() : null,
        clean_(entry.error_message || ""),
        clean_(entry.brevo_message_id || entry.message_id || ""),
        JSON.stringify(entry.metadata_json || entry.metadata || {})
      ]
    );

    return result.rows[0];
  });
}

function normaliseReviewedDecisionData_(request = {}, reviewedData = {}) {
  const originalLevel = upper_(request.level_submitted);
  const reviewedLevel = upper_(reviewedData.level || originalLevel);

  return {
    student_name: clean_(reviewedData.student_name) || clean_(request.student_name_submitted),
    student_phone: normalisePhone_(reviewedData.student_phone || request.student_phone_submitted),
    country: clean_(reviewedData.country) || clean_(request.country_submitted),
    level: reviewedLevel || originalLevel,
    teacher_email: lower_(reviewedData.teacher_email || request.reviewed_teacher_email_normalized || request.teacher_email_normalized || request.teacher_email_submitted),
    student_type: lower_(reviewedData.student_type || request.raw_payload?.approved_student_type || "group")
  };
}

function normaliseRejectionReason_(value) {
  const reason = clean_(value);
  if (!reason) return "";
  return reason.slice(0, 1200);
}

export async function processRegistrationDecision({ token, action, approverEmail, reviewedData = {}, rejectionReason = "", reviewerRole = "" } = {}) {
  const tokenHash = hashToken_(token);
  const normalizedAction = lower_(action);
  const normalizedApproverEmail = lower_(approverEmail);

  if (!["approve_indefinite", "reject"].includes(normalizedAction)) {
    return {
      ok: false,
      status: "INVALID_ACTION",
      message: "Invalid registration decision action.",
      checked_at: nowIso_()
    };
  }

  return withSupabaseClient(async (client) => {
    await ensureRegistrationTables_(client);
    await client.query("begin");

    try {
      const requestResult = await client.query(
        `select * from registration_requests where approval_token_hash = $1 limit 1 for update`,
        [tokenHash]
      );

      const request = requestResult.rows[0] || null;
      if (!request) {
        await client.query("rollback");
        return {
          ok: false,
          status: "INVALID_OR_SUPERSEDED_LINK",
          message: "This approval link is invalid or has been replaced by a newer registration request.",
          checked_at: nowIso_()
        };
      }

      if (request.status !== "pending") {
        await client.query("rollback");
        return {
          ok: false,
          status: "REQUEST_NOT_PENDING",
          message: `This registration request is no longer pending. Current status: ${request.status}.`,
          request: requestPublicShape_(request),
          checked_at: nowIso_()
        };
      }

      if (request.approval_token_used_at) {
        await client.query("rollback");
        return {
          ok: false,
          status: "LINK_ALREADY_USED",
          message: "This approval link has already been used.",
          request: requestPublicShape_(request),
          checked_at: nowIso_()
        };
      }

      const expiresAt = request.approval_token_expires_at ? new Date(request.approval_token_expires_at) : null;
      if (!expiresAt || expiresAt.getTime() <= Date.now()) {
        const expired = await client.query(
          `
            update registration_requests
            set status = 'approval_link_expired', approval_token_used_at = now(), updated_at = now()
            where id = $1
            returning *
          `,
          [request.id]
        );
        await client.query("commit");
        return {
          ok: false,
          status: "APPROVAL_LINK_EXPIRED",
          message: "This approval link has expired.",
          request: requestPublicShape_(expired.rows[0]),
          checked_at: nowIso_()
        };
      }

      const reviewed = normaliseReviewedDecisionData_(request, reviewedData);
      const cleanRejectionReason = normaliseRejectionReason_(rejectionReason);

      if (normalizedAction === "reject") {
        const rejected = await client.query(
          `
            update registration_requests
            set
              status = 'rejected',
              decision = 'reject',
              rejected_by_email = $2,
              rejected_at = now(),
              approval_token_used_at = now(),
              reviewed_student_name = $3,
              reviewed_student_phone = $4,
              reviewed_country = $5,
              reviewed_level = $6,
              reviewed_teacher_email_normalized = $7,
              rejection_reason = $8,
              reviewed_by_role = $9,
              updated_at = now()
            where id = $1
            returning *
          `,
          [
            request.id,
            normalizedApproverEmail,
            reviewed.student_name,
            reviewed.student_phone,
            reviewed.country,
            reviewed.level,
            reviewed.teacher_email,
            cleanRejectionReason,
            clean_(reviewerRole)
          ]
        );

        await client.query("commit");
        return {
          ok: true,
          status: "REJECTED",
          action: normalizedAction,
          request: requestPublicShape_(rejected.rows[0]),
          checked_at: nowIso_()
        };
      }

      if (!ALLOWED_LEVELS.has(reviewed.level)) {
        const failed = await client.query(
          `
            update registration_requests
            set status = 'invalid_level', decision_error = $2, updated_at = now()
            where id = $1
            returning *
          `,
          [request.id, "The submitted level is invalid. Allowed levels: A1, A2, B1."]
        );
        await client.query("commit");
        return {
          ok: false,
          status: "INVALID_LEVEL",
          message: "The submitted level is invalid. Approval was not completed.",
          request: requestPublicShape_(failed.rows[0]),
          checked_at: nowIso_()
        };
      }

      if (!new Set(["group", "private", "ielts"]).has(reviewed.student_type)) {
        await client.query("rollback");
        return { ok:false,status:"INVALID_STUDENT_TYPE",message:"Student type must be group, private, or ielts.",request:requestPublicShape_(request),checked_at:nowIso_() };
      }

      const teacher = await findTeacherByEmail_(client, reviewed.teacher_email);
      if (!teacher) {
        const pending = await client.query(
          `
            update registration_requests
            set reviewed_student_name=$2, reviewed_student_phone=$3, reviewed_country=$4,
              reviewed_level=$5, reviewed_teacher_email_normalized=$6,
              raw_payload=jsonb_set(coalesce(raw_payload,'{}'::jsonb),'{approved_student_type}',to_jsonb($7::text),true),
              decision_error='Teacher creation required before approval.', updated_at=now()
            where id = $1
            returning *
          `,
          [request.id,reviewed.student_name,reviewed.student_phone,reviewed.country,reviewed.level,reviewed.teacher_email,reviewed.student_type]
        );
        await client.query("commit");
        return {
          ok: true,
          status: "TEACHER_CREATION_REQUIRED",
          message: "Registration remains pending until the teacher profile is created.",
          request: requestPublicShape_(pending.rows[0]),
          teacher_email: reviewed.teacher_email,
          checked_at: nowIso_()
        };
      }

      if (!teacher.active || upper_(teacher.status) !== "ACTIVE") {
        const reactivated = (await client.query(`update teachers set active=true,status='ACTIVE',updated_at=now() where id=$1 returning id as teacher_id,coalesce(nullif(trim(full_name),''),email) teacher_name,lower(trim(email)) teacher_email,coalesce(nullif(trim(whatsapp_number),''),nullif(trim(phone),'')) teacher_phone,active,status`,[teacher.teacher_id])).rows[0];
        Object.assign(teacher,reactivated);
      }

      const submitted = {
        student_name: reviewed.student_name,
        student_email: lower_(request.student_email_normalized || request.student_email_submitted),
        student_phone: reviewed.student_phone,
        country: reviewed.country,
        level: reviewed.level,
        teacher_email: teacher.teacher_email,
        student_type: reviewed.student_type
      };

      let student = await findStudentByEmail_(client, submitted.student_email);
      if (student) {
        student = await activateExistingStudent_(client, student, submitted);
      } else {
        student = await insertStudent_(client, submitted);
      }

      await closeExpiredRegistrationEnrollmentsForStudent_(client, student.id);

      const activeEnrollments = await loadActiveEnrollmentsForStudent_(client, student.id);
      const sameTeacherActiveEnrollment = activeEnrollmentForTeacher_(activeEnrollments, teacher.teacher_id);

      const closedActiveEnrollments = activeEnrollments.length
        ? await closeActiveEnrollmentsForStudent_(client, student.id, "REGISTRATION_REPLACED_BY_NEW_ENROLLMENT")
        : [];

      const approvedAt = new Date();
      const accessType = "indefinite";
      const endAt = null;

      const enrollment = await insertEnrollment_(client, {
        studentId: student.id,
        teacherId: teacher.teacher_id,
        level: submitted.level,
        startAt: approvedAt,
        endAt,
        registrationRequestId: request.id,
        accessType
      });

      const approved = await client.query(
        `
          update registration_requests
          set
            status = 'approved',
            decision = $2,
            access_type = $3,
            approved_by_email = $4,
            approved_at = $5,
            approval_token_used_at = now(),
            existing_student_id = $6,
            existing_student_found = true,
            teacher_id = $7,
            teacher_found = true,
            enrollment_id = $8,
            registration_start_at = $5,
            registration_end_at = $9,
            active_enrollments_json = $10::jsonb,
            reviewed_student_name = $11,
            reviewed_student_phone = $12,
            reviewed_country = $13,
            reviewed_level = $14,
            reviewed_teacher_email_normalized = $15,
            reviewed_by_role = $16,
            updated_at = now()
          where id = $1
          returning *
        `,
        [
          request.id,
          normalizedAction,
          accessType,
          normalizedApproverEmail,
          approvedAt,
          student.id,
          teacher.teacher_id,
          enrollment.id,
          endAt,
          JSON.stringify(activeEnrollments || []),
          submitted.student_name,
          submitted.student_phone,
          submitted.country,
          submitted.level,
          teacher.teacher_email,
          clean_(reviewerRole)
        ]
      );

      await client.query("commit");

      return {
        ok: true,
        status: "APPROVED",
        action: normalizedAction,
        access_type: accessType,
        request: requestPublicShape_(approved.rows[0]),
        student,
        teacher,
        enrollment,
        closed_active_enrollments: closedActiveEnrollments,
        replaced_same_teacher_enrollment: sameTeacherActiveEnrollment || null,
        checked_at: nowIso_()
      };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

export async function createOrConfirmRegistrationTeacher({ email, fullName, whatsappNumber, confirmConflict = false } = {}) {
  const teacherEmail = lower_(email);
  const teacherName = clean_(fullName);
  const teacherPhone = normalisePhone_(whatsappNumber);
  if (!teacherEmail || !teacherName || !teacherPhone) {
    return { ok:false,status:"MISSING_TEACHER_FIELDS",message:"Full name, email, and WhatsApp number are required." };
  }
  return withSupabaseClient(async (client) => {
    await client.query("begin");
    try {
      const existing = await findTeacherByEmail_(client, teacherEmail);
      if (existing) {
        const conflicts = [];
        if (clean_(existing.teacher_name) && lower_(existing.teacher_name) !== lower_(teacherName)) conflicts.push({ field:"full_name",database:existing.teacher_name,submitted:teacherName });
        if (clean_(existing.teacher_phone) && normalisePhone_(existing.teacher_phone) !== teacherPhone) conflicts.push({ field:"whatsapp_number",database:existing.teacher_phone,submitted:teacherPhone });
        if (conflicts.length && !confirmConflict) {
          await client.query("rollback");
          return { ok:false,status:"TEACHER_DETAILS_CONFLICT",teacher:existing,conflicts };
        }
        const updated = (await client.query(`update teachers set full_name=$2,phone=$3,whatsapp_number=$3,active=true,status='ACTIVE',updated_at=now() where id=$1 returning id as teacher_id,full_name teacher_name,lower(trim(email)) teacher_email,coalesce(nullif(trim(whatsapp_number),''),nullif(trim(phone),'')) teacher_phone,active,status`,[existing.teacher_id,teacherName,teacherPhone])).rows[0];
        await client.query("commit");
        return { ok:true,status:existing.active&&upper_(existing.status)==="ACTIVE"?"EXISTING_TEACHER_CONFIRMED":"TEACHER_REACTIVATED",teacher:updated };
      }
      const created = (await client.query(`insert into teachers(full_name,email,phone,whatsapp_number,status,active,created_at,updated_at) values($1,$2,$3,$3,'ACTIVE',true,now(),now()) returning id as teacher_id,full_name teacher_name,lower(trim(email)) teacher_email,whatsapp_number teacher_phone,active,status`,[teacherName,teacherEmail,teacherPhone])).rows[0];
      await client.query("commit");
      return { ok:true,status:"TEACHER_CREATED",teacher:created };
    } catch(error) { await client.query("rollback"); throw error; }
  });
}

export async function expireRegistrationEnrollments() {
  return withSupabaseClient(async (client) => {
    await ensureRegistrationTables_(client);
    await client.query("begin");

    try {
      const expiredResult = await client.query(
        `
          select
            e.id,
            e.student_id,
            e.teacher_id,
            e.level,
            e.cohort,
            e.start_date,
            e.end_date,
            e.registration_start_at,
            e.registration_end_at,
            e.access_type,
            e.registration_request_id,
            s.full_name as student_full_name,
            lower(trim(s.email)) as student_email,
            coalesce(nullif(trim(s.whatsapp_number), ''), nullif(trim(s.phone), '')) as student_phone,
            t.full_name as teacher_name,
            lower(trim(t.email)) as teacher_email,
            coalesce(nullif(trim(t.whatsapp_number), ''), nullif(trim(t.phone), '')) as teacher_phone,
            rr.student_name_submitted,
            rr.student_email_submitted,
            rr.student_phone_submitted,
            rr.country_submitted,
            rr.level_submitted,
            rr.teacher_email_submitted,
            rr.registration_start_at as request_registration_start_at,
            rr.registration_end_at as request_registration_end_at,
            rr.access_type as request_access_type
          from enrollments e
          join students s on s.id = e.student_id
          left join teachers t on t.id = e.teacher_id
          left join registration_requests rr on rr.id = e.registration_request_id
          where e.registration_request_id is not null
            and e.access_type = 'one_week'
            and e.registration_end_at is not null
            and e.registration_end_at <= now()
            and e.active is true
            and upper(trim(e.status)) = 'ACTIVE'
          order by e.registration_end_at asc
          for update of e
        `
      );

      const expiredEnrollments = expiredResult.rows;
      const expiredEnrollmentIds = expiredEnrollments.map((row) => row.id);
      const studentIds = [...new Set(expiredEnrollments.map((row) => row.student_id).filter(Boolean))];
      const requestIds = [...new Set(expiredEnrollments.map((row) => row.registration_request_id).filter(Boolean))];

      if (expiredEnrollmentIds.length) {
        await client.query(
          `
            update enrollments
            set
              active = false,
              status = 'INACTIVE',
              closed_reason = 'REGISTRATION_ACCESS_EXPIRED',
              notes = concat_ws(E'\n', nullif(notes, ''), 'Closed automatically because one-week registration access expired.'),
              updated_at = now()
            where id = any($1::uuid[])
          `,
          [expiredEnrollmentIds]
        );
      }

      if (requestIds.length) {
        await client.query(
          `
            update registration_requests
            set status = 'expired', updated_at = now()
            where id = any($1::uuid[])
              and status = 'approved'
              and access_type = 'one_week'
          `,
          [requestIds]
        );
      }

      const deactivatedStudentIds = [];

      for (const studentId of studentIds) {
        const activeAfter = await loadActiveEnrollmentsForStudent_(client, studentId);
        if (activeAfter.length) continue;

        await client.query(
          `
            update students
            set status = 'INACTIVE', active = false, updated_at = now()
            where id = $1
          `,
          [studentId]
        );
        deactivatedStudentIds.push(studentId);
      }

      await client.query("commit");

      const expiredTrials = expiredEnrollments.map((row) => ({
        enrollment: {
          id: row.id,
          student_id: row.student_id,
          teacher_id: row.teacher_id,
          level: row.level,
          cohort: row.cohort,
          start_date: row.start_date,
          end_date: row.end_date,
          registration_start_at: row.registration_start_at,
          registration_end_at: row.registration_end_at,
          access_type: row.access_type,
          registration_request_id: row.registration_request_id
        },
        request: {
          id: row.registration_request_id,
          status: "expired",
          student_name: row.student_name_submitted || row.student_full_name,
          student_email: row.student_email_submitted || row.student_email,
          student_phone: row.student_phone_submitted || row.student_phone,
          country: row.country_submitted,
          level: row.level_submitted || row.level,
          teacher_email: row.teacher_email_submitted || row.teacher_email,
          access_type: row.request_access_type || row.access_type,
          registration_start_at: row.request_registration_start_at || row.registration_start_at,
          registration_end_at: row.request_registration_end_at || row.registration_end_at
        },
        student: {
          id: row.student_id,
          full_name: row.student_full_name,
          email: row.student_email,
          phone: row.student_phone,
          deactivated: deactivatedStudentIds.includes(row.student_id)
        },
        teacher: {
          teacher_id: row.teacher_id,
          teacher_name: row.teacher_name,
          teacher_email: row.teacher_email,
          teacher_phone: row.teacher_phone
        }
      }));

      return {
        ok: true,
        status: "REGISTRATION_ENROLLMENTS_EXPIRED",
        expired_enrollment_count: expiredEnrollments.length,
        affected_student_count: studentIds.length,
        deactivated_student_count: deactivatedStudentIds.length,
        expired_enrollment_ids: expiredEnrollmentIds,
        deactivated_student_ids: deactivatedStudentIds,
        expired_trials: expiredTrials,
        checked_at: nowIso_()
      };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}
