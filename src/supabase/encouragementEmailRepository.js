import crypto from "node:crypto";
import { studentFacingName } from "../studentFacingName.js";
import { withSupabaseClient } from "./client.js";
import { renderEncouragementEmail } from "../encouragementEmailTemplate.js";

const MESSAGE_TYPES = {
  weeklyStudent: "WEEKLY_ACTIVE_STUDENT_ENCOURAGEMENT",
  weeklyTeacher: "WEEKLY_ACTIVE_TEACHER_ENCOURAGEMENT"
};

const SOURCE_TYPES = {
  weeklyStudent: "WEEKLY_ACTIVE_STUDENT_ENCOURAGEMENT",
  weeklyStudentTest: "WEEKLY_ACTIVE_STUDENT_ENCOURAGEMENT_TEST",
  weeklyTeacher: "WEEKLY_ACTIVE_TEACHER_ENCOURAGEMENT",
  weeklyTeacherTest: "WEEKLY_ACTIVE_TEACHER_ENCOURAGEMENT_TEST"
};

const CONFIG_BY_MESSAGE_TYPE = {
  [MESSAGE_TYPES.weeklyStudent]: {
    audienceType: "STUDENT",
    recipientKind: "ACTIVE_STUDENTS",
    sourceType: SOURCE_TYPES.weeklyStudent,
    testSourceType: SOURCE_TYPES.weeklyStudentTest,
    cycleKind: "WEEKLY",
    defaultLimit: 100
  },
  [MESSAGE_TYPES.weeklyTeacher]: {
    audienceType: "TEACHER",
    recipientKind: "ACTIVE_TEACHERS",
    sourceType: SOURCE_TYPES.weeklyTeacher,
    testSourceType: SOURCE_TYPES.weeklyTeacherTest,
    cycleKind: "WEEKLY",
    defaultLimit: 100
  }
};

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

const DEFAULT_TIMEZONE = "Africa/Douala";
const MAX_LIMIT = 500;

function nowIso_() {
  return new Date().toISOString();
}

function clean_(value) {
  return String(value ?? "").trim();
}

function cleanLower_(value) {
  return clean_(value).toLowerCase();
}

function normaliseLimit_(value, fallback = 100, max = MAX_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function hashKey_(parts) {
  return crypto
    .createHash("sha256")
    .update(parts.map((part) => clean_(part)).join("|"))
    .digest("hex")
    .slice(0, 32);
}

function quoteIdent_(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function placeholdersFor_(recipient, audienceType) {
  const name = clean_(recipient.recipient_name || recipient.name || recipient.full_name || recipient.teacher_name || "there");
  return {
    student_name: name,
    teacher_name: name,
    recipient_name: name
  };
}

function replacePlaceholders_(value, replacements) {
  let output = String(value ?? "");
  for (const [key, replacement] of Object.entries(replacements || {})) {
    output = output.replaceAll(`{{${key}}}`, clean_(replacement));
  }
  return output;
}

function getTimezone_() {
  return clean_(process.env.SCHEDULER_TIMEZONE || process.env.TZ) || DEFAULT_TIMEZONE;
}

function getZonedYmd_(date = new Date(), timeZone = getTimezone_()) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function parseYmdAsUtc_(ymd) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean_(ymd));
  if (!match) throw new Error(`Invalid cycle_date. Expected YYYY-MM-DD, received: ${ymd}`);
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function addUtcDays_(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function formatUtcYmd_(date) {
  return date.toISOString().slice(0, 10);
}

function getIsoWeekParts_(date) {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - dayNumber);
  const isoYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const weekNumber = Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
  return { isoYear, weekNumber };
}

function buildCycle_(messageType, options = {}) {
  const config = CONFIG_BY_MESSAGE_TYPE[messageType];
  if (!config) throw new Error(`Unsupported encouragement message_type: ${messageType}`);

  const cycleDate = clean_(options.cycleDate || options.cycle_date) || getZonedYmd_(new Date(), getTimezone_());
  const date = parseYmdAsUtc_(cycleDate);

  const { isoYear, weekNumber } = getIsoWeekParts_(date);
  const monday = addUtcDays_(date, -((date.getUTCDay() + 6) % 7));

  return {
    cycle_date: cycleDate,
    cycle_key: `${isoYear}-W${String(weekNumber).padStart(2, "0")}`,
    cycle_week_monday: formatUtcYmd_(monday),
    cycle_kind: config.cycleKind
  };
}

async function tableExists_(client, tableName) {
  const result = await client.query(
    `
      select exists (
        select 1
        from information_schema.tables
        where table_schema = 'public'
          and table_name = $1
      ) as exists
    `,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function getTableColumns_(client, tableName) {
  const result = await client.query(
    `
      select column_name, data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
    `,
    [tableName]
  );

  const columns = new Map();
  for (const row of result.rows) columns.set(row.column_name, row.data_type);
  return columns;
}

function pickColumn_(columns, candidates) {
  return candidates.find((candidate) => columns.has(candidate)) || "";
}

function inactiveStatusFilter_(alias, column) {
  return `(
    ${alias}.${quoteIdent_(column)} is null
    or nullif(trim(${alias}.${quoteIdent_(column)}::text), '') is null
    or upper(trim(${alias}.${quoteIdent_(column)}::text)) <> all($1::text[])
  )`;
}

function booleanActiveFilter_(alias, column) {
  return `coalesce(${alias}.${quoteIdent_(column)}, true) is true`;
}

function buildOwnActiveFilters_(alias, columns) {
  const filters = [];
  const statusColumn = pickColumn_(columns, ["status", "student_status", "teacher_status", "enrollment_status"]);
  const activeColumn = pickColumn_(columns, ["is_active", "active"]);

  if (statusColumn) filters.push(inactiveStatusFilter_(alias, statusColumn));
  if (activeColumn) filters.push(booleanActiveFilter_(alias, activeColumn));

  return filters;
}

function buildEnrollmentActiveFilters_(enrollmentColumns) {
  const filters = [];
  const statusColumn = pickColumn_(enrollmentColumns, ["status", "enrollment_status", "student_status"]);
  const activeColumn = pickColumn_(enrollmentColumns, ["is_active", "active"]);

  if (statusColumn) filters.push(inactiveStatusFilter_("e", statusColumn));
  if (activeColumn) filters.push(booleanActiveFilter_("e", activeColumn));

  return filters;
}

function appendExistingQueueExclusion_(filters, params, emailSql, options = {}) {
  const exclude = options.excludeExistingQueue || options.exclude_existing_queue;
  if (!exclude) return;

  const sourceType = clean_(exclude.sourceType || exclude.source_type);
  const messageId = clean_(exclude.messageId || exclude.message_id);
  const cycleKey = clean_(exclude.cycleKey || exclude.cycle_key);

  if (!sourceType || !messageId || !cycleKey) return;

  params.push(sourceType);
  const sourceTypeParam = params.length;
  params.push(messageId);
  const messageIdParam = params.length;
  params.push(cycleKey);
  const cycleKeyParam = params.length;

  filters.push(`not exists (
    select 1
    from email_queue q
    where q.source_type = $${sourceTypeParam}
      and q.source_id = $${messageIdParam}::uuid
      and q.payload_json->'cycle'->>'cycle_key' = $${cycleKeyParam}
      and lower(trim(q.recipient_email)) = lower(trim(${emailSql}))
  )`);
}

async function loadActiveStudentRecipients_(client, options = {}) {
  const studentsColumns = await getTableColumns_(client, "students");
  const enrollmentsExists = await tableExists_(client, "enrollments");
  const enrollmentColumns = enrollmentsExists ? await getTableColumns_(client, "enrollments") : new Map();

  const emailColumn = pickColumn_(studentsColumns, ["email", "student_email", "email_address"]);
  const nameColumn = pickColumn_(studentsColumns, ["full_name", "student_name", "name"]);

  if (!emailColumn) {
    throw new Error("Cannot queue student encouragement emails because students.email/student_email/email_address was not found.");
  }

  const ownFilters = buildOwnActiveFilters_("s", studentsColumns);
  const enrollmentFilters = buildEnrollmentActiveFilters_(enrollmentColumns);
  const filters = [
    `nullif(trim(s.${quoteIdent_(emailColumn)}::text), '') is not null`,
    ...ownFilters
  ];
  const params = [ACTIVE_NEGATIVE_STATUSES];

  appendExistingQueueExclusion_(filters, params, `s.${quoteIdent_(emailColumn)}::text`, options);

  if (enrollmentsExists && enrollmentColumns.has("student_id")) {
    filters.push(`exists (
      select 1
      from enrollments e
      where e.student_id = s.id
      ${enrollmentFilters.length ? `and ${enrollmentFilters.join(" and ")}` : ""}
    )`);
  }

  return selectStudentRecipients_(client, {
    filters,
    nameColumn,
    emailColumn,
    limit: options.limit,
    params
  });
}

async function selectStudentRecipients_(client, { filters, nameColumn, emailColumn, limit, params = [ACTIVE_NEGATIVE_STATUSES] }) {
  params.push(limit);
  const limitParam = params.length;
  const nameExpression = nameColumn
    ? `coalesce(nullif(trim(s.${quoteIdent_(nameColumn)}::text), ''), nullif(trim(s.${quoteIdent_(emailColumn)}::text), ''), 'Student')`
    : `coalesce(nullif(trim(s.${quoteIdent_(emailColumn)}::text), ''), 'Student')`;

  const result = await client.query(
    `
      select distinct on (lower(trim(s.${quoteIdent_(emailColumn)}::text)))
        s.id as recipient_id,
        ${nameExpression} as recipient_name,
        lower(trim(s.${quoteIdent_(emailColumn)}::text)) as recipient_email,
        'STUDENT' as audience_type
      from students s
      where ${filters.join(" and ")}
      order by lower(trim(s.${quoteIdent_(emailColumn)}::text)), recipient_name asc, s.id
      limit $${limitParam}
    `,
    params
  );

  return result.rows;
}

async function loadActiveTeacherRecipients_(client, options = {}) {
  const teachersColumns = await getTableColumns_(client, "teachers");
  const emailColumn = pickColumn_(teachersColumns, ["email", "teacher_email", "email_address"]);
  const nameColumn = pickColumn_(teachersColumns, ["teacher_name", "full_name", "name"]);

  if (!emailColumn) {
    throw new Error("Cannot queue teacher encouragement emails because teachers.email/teacher_email/email_address was not found.");
  }

  const filters = [
    `nullif(trim(t.${quoteIdent_(emailColumn)}::text), '') is not null`,
    ...buildOwnActiveFilters_("t", teachersColumns)
  ];
  const params = [ACTIVE_NEGATIVE_STATUSES];
  appendExistingQueueExclusion_(filters, params, `t.${quoteIdent_(emailColumn)}::text`, options);
  params.push(options.limit);
  const nameExpression = nameColumn
    ? `coalesce(nullif(trim(t.${quoteIdent_(nameColumn)}::text), ''), nullif(trim(t.${quoteIdent_(emailColumn)}::text), ''), 'Teacher')`
    : `coalesce(nullif(trim(t.${quoteIdent_(emailColumn)}::text), ''), 'Teacher')`;

  const result = await client.query(
    `
      select distinct on (lower(trim(t.${quoteIdent_(emailColumn)}::text)))
        t.id as recipient_id,
        ${nameExpression} as recipient_name,
        lower(trim(t.${quoteIdent_(emailColumn)}::text)) as recipient_email,
        'TEACHER' as audience_type
      from teachers t
      where ${filters.join(" and ")}
      order by lower(trim(t.${quoteIdent_(emailColumn)}::text)), recipient_name asc, t.id
      limit $${params.length}
    `,
    params
  );

  return result.rows;
}

async function loadRecipients_(client, config, options = {}) {
  const limit = normaliseLimit_(options.limit, config.defaultLimit, MAX_LIMIT);

  if (config.recipientKind === "ACTIVE_STUDENTS") {
    return loadActiveStudentRecipients_(client, { ...options, limit });
  }

  if (config.recipientKind === "ACTIVE_TEACHERS") {
    return loadActiveTeacherRecipients_(client, { ...options, limit });
  }

  throw new Error(`Unsupported encouragement recipient kind: ${config.recipientKind}`);
}

async function getActiveMessages_(client, messageType) {
  const result = await client.query(
    `
      select *
      from encouragement_messages
      where message_type = $1
        and status = 'active'
      order by sequence_number asc, message_key asc
    `,
    [messageType]
  );

  return result.rows;
}

async function chooseNextRotationMessage_(client, messageType) {
  const activeMessages = await getActiveMessages_(client, messageType);
  if (!activeMessages.length) {
    throw new Error(`No active encouragement_messages rows found for message_type ${messageType}. Run create_encouragement_email_system.sql first.`);
  }

  let stateResult = await client.query(
    `
      select *
      from encouragement_rotation_state
      where message_type = $1
      for update
    `,
    [messageType]
  );

  if (!stateResult.rows.length) {
    stateResult = await client.query(
      `
        insert into encouragement_rotation_state (message_type, current_rotation_number, used_message_ids, created_at, updated_at)
        values ($1, 1, '{}'::uuid[], now(), now())
        returning *
      `,
      [messageType]
    );
  }

  const state = stateResult.rows[0];
  const used = new Set((state.used_message_ids || []).map((id) => clean_(id)));
  let rotationNumber = Number(state.current_rotation_number || 1);
  let usedForUpdate = [...used];
  let selected = activeMessages.find((message) => !used.has(clean_(message.id)));

  if (!selected) {
    rotationNumber += 1;
    usedForUpdate = [];
    selected = activeMessages[0];
  }

  const updatedUsed = [...usedForUpdate, selected.id];

  await client.query(
    `
      update encouragement_rotation_state
      set
        current_rotation_number = $2,
        used_message_ids = $3::uuid[],
        last_message_id = $4::uuid,
        last_sequence_number = $5,
        last_advanced_at = now(),
        updated_at = now()
      where message_type = $1
    `,
    [messageType, rotationNumber, updatedUsed, selected.id, selected.sequence_number]
  );

  return {
    message: selected,
    rotation_number: rotationNumber,
    used_message_ids: updatedUsed,
    active_message_count: activeMessages.length,
    remaining_before_reset: Math.max(activeMessages.length - updatedUsed.length, 0)
  };
}

async function getOrCreateRealRun_(client, { messageType, config, cycle, options }) {
  const existing = await client.query(
    `
      select r.*, m.body_text, m.body_html, m.subject, m.audience_type
      from encouragement_email_runs r
      join encouragement_messages m on m.id = r.message_id
      where r.message_type = $1
        and r.cycle_key = $2
        and r.test_mode = false
      for update of r
    `,
    [messageType, cycle.cycle_key]
  );

  if (existing.rows.length) {
    return {
      run: existing.rows[0],
      message: existing.rows[0],
      rotation: null,
      reused_existing_cycle_run: true
    };
  }

  const rotation = await chooseNextRotationMessage_(client, messageType);
  const message = rotation.message;

  const runResult = await client.query(
    `
      insert into encouragement_email_runs (
        message_type,
        cycle_key,
        cycle_date,
        message_id,
        message_key,
        sequence_number,
        source_type,
        test_mode,
        status,
        payload_json,
        created_at,
        updated_at
      )
      values ($1, $2, $3::date, $4::uuid, $5, $6, $7, false, 'QUEUING', $8::jsonb, now(), now())
      returning *
    `,
    [
      messageType,
      cycle.cycle_key,
      cycle.cycle_date,
      message.id,
      message.message_key,
      message.sequence_number,
      config.sourceType,
      JSON.stringify({
        cycle,
        rotation_number: rotation.rotation_number,
        source: "supabase-encouragement-email-queue"
      })
    ]
  );

  await client.query(
    `
      update encouragement_rotation_state
      set
        last_real_cycle_key = $2,
        updated_at = now()
      where message_type = $1
    `,
    [messageType, cycle.cycle_key]
  );

  return {
    run: runResult.rows[0],
    message,
    rotation,
    reused_existing_cycle_run: false
  };
}

async function getTestRunMessage_(client, messageType, options = {}) {
  if (options.messageId || options.message_id) {
    const result = await client.query(
      `
        select *
        from encouragement_messages
        where id = $1::uuid
          and message_type = $2
          and status = 'active'
      `,
      [options.messageId || options.message_id, messageType]
    );
    if (result.rows[0]) return result.rows[0];
  }

  if (options.messageKey || options.message_key) {
    const result = await client.query(
      `
        select *
        from encouragement_messages
        where message_key = $1
          and message_type = $2
          and status = 'active'
      `,
      [options.messageKey || options.message_key, messageType]
    );
    if (result.rows[0]) return result.rows[0];
  }

  const activeMessages = await getActiveMessages_(client, messageType);
  if (!activeMessages.length) {
    throw new Error(`No active encouragement_messages rows found for message_type ${messageType}. Run create_encouragement_email_system.sql first.`);
  }

  return activeMessages[0];
}

function idempotencyKey_(messageType, sourceType, cycleKey, messageId, recipientEmail, recipientId = "") {
  return `encouragement:${messageType}:${sourceType}:${cycleKey}:${messageId}:${hashKey_([recipientEmail, recipientId])}`;
}

function testIdempotencyKey_(messageType, sourceType, cycleKey, messageId, testRecipientEmail) {
  return `encouragement:${messageType}:${sourceType}:${cycleKey}:${messageId}:test:${hashKey_([testRecipientEmail, nowIso_(), Math.random()])}`;
}

function queuePayload_(messageType, config, cycle, message, recipient, options = {}) {
  return {
    source: "supabase-encouragement-email-queue",
    message_type: messageType,
    source_type: options.sourceType || config.sourceType,
    audience_type: config.audienceType,
    recipient_kind: config.recipientKind,
    cycle,
    message_id: message.id,
    message_key: message.message_key,
    sequence_number: message.sequence_number,
    recipient_id: recipient.recipient_id || null,
    recipient_email: recipient.recipient_email,
    recipient_name: recipient.recipient_name,
    test_recipient_email: clean_(options.testRecipientEmail),
    queued_at: nowIso_()
  };
}

async function insertEncouragementQueueRow_(client, { messageType, config, cycle, message, recipient, sourceType, idempotencyKey, testRecipientEmail = "" }) {
  const rendered = renderEncouragementEmail({
    message,
    recipient,
    messageType,
    sourceType,
    testRecipientEmail
  });
  const recipientDisplayName = config.audienceType === "STUDENT"
    ? studentFacingName(recipient.recipient_name, recipient.recipient_email)
    : recipient.recipient_name || recipient.recipient_email;

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
        final_feedback_ids,
        payload_json,
        provider,
        created_at,
        updated_at
      )
      values ($1, $2::uuid, $3, 'QUEUED', $4, $5, $6, $7, $8, '{}'::uuid[], $9::jsonb, 'BREVO', now(), now())
      on conflict (idempotency_key) do update
      set
        updated_at = now(),
        recipient_email = case when email_queue.status = 'SENT' then email_queue.recipient_email else excluded.recipient_email end,
        recipient_name = case when email_queue.status = 'SENT' then email_queue.recipient_name else excluded.recipient_name end,
        subject = case when email_queue.status = 'SENT' then email_queue.subject else excluded.subject end,
        body_html = case when email_queue.status = 'SENT' then email_queue.body_html else excluded.body_html end,
        body_text = case when email_queue.status = 'SENT' then email_queue.body_text else excluded.body_text end,
        payload_json = case when email_queue.status = 'SENT' then email_queue.payload_json else excluded.payload_json end
      returning
        id,
        source_type,
        source_id,
        idempotency_key,
        status,
        recipient_email,
        recipient_name,
        subject,
        attempt_count,
        created_at,
        updated_at,
        sent_at
    `,
    [
      sourceType,
      message.id,
      idempotencyKey,
      recipient.recipient_email,
      recipientDisplayName,
      rendered.subject,
      rendered.body_html,
      rendered.body_text,
      JSON.stringify(queuePayload_(messageType, config, cycle, message, recipient, { sourceType, testRecipientEmail }))
    ]
  );

  return result.rows[0];
}

async function queueTestEncouragementEmail_(client, { messageType, config, cycle, options }) {
  const testRecipientEmail = cleanLower_(options.testRecipientEmail || options.test_recipient_email);
  const testRecipientName = clean_(options.testRecipientName || options.test_recipient_name || "JEA Test Recipient");

  if (!testRecipientEmail) {
    throw new Error("test_recipient_email is required for test encouragement queueing.");
  }

  const message = await getTestRunMessage_(client, messageType, options);
  const sourceType = config.testSourceType;
  const recipient = {
    recipient_id: null,
    recipient_email: testRecipientEmail,
    recipient_name: testRecipientName,
    audience_type: config.audienceType
  };

  const queueRow = await insertEncouragementQueueRow_(client, {
    messageType,
    config,
    cycle,
    message,
    recipient,
    sourceType,
    idempotencyKey: testIdempotencyKey_(messageType, sourceType, cycle.cycle_key, message.id, testRecipientEmail),
    testRecipientEmail
  });

  const runResult = await client.query(
    `
      insert into encouragement_email_runs (
        message_type,
        cycle_key,
        cycle_date,
        message_id,
        message_key,
        sequence_number,
        source_type,
        test_mode,
        test_recipient_email,
        selected_recipient_count,
        queued_count,
        status,
        payload_json,
        created_at,
        updated_at
      )
      values ($1, $2, $3::date, $4::uuid, $5, $6, $7, true, $8, 1, 1, 'QUEUED', $9::jsonb, now(), now())
      returning *
    `,
    [
      messageType,
      cycle.cycle_key,
      cycle.cycle_date,
      message.id,
      message.message_key,
      message.sequence_number,
      sourceType,
      testRecipientEmail,
      JSON.stringify({
        mode: "TEST_RECIPIENT_OVERRIDE_NO_ROTATION_ADVANCE",
        cycle,
        test_recipient_email: testRecipientEmail
      })
    ]
  );

  return {
    ok: true,
    status: "TEST_ENCOURAGEMENT_EMAIL_QUEUED",
    mode: "TEST_RECIPIENT_OVERRIDE_NO_ROTATION_ADVANCE",
    message_type: messageType,
    source_type: sourceType,
    cycle,
    message: summariseMessage_(message),
    queued_count: 1,
    selected_recipient_count: 1,
    run: runResult.rows[0],
    queued: [queueRow],
    checked_at: nowIso_()
  };
}

async function queueRealEncouragementEmails_(client, { messageType, config, cycle, options }) {
  const { run, message, rotation, reused_existing_cycle_run } = await getOrCreateRealRun_(client, {
    messageType,
    config,
    cycle,
    options
  });

  const recipients = await loadRecipients_(client, config, {
    ...options,
    limit: normaliseLimit_(options.limit, config.defaultLimit, MAX_LIMIT),
    excludeExistingQueue: {
      sourceType: config.sourceType,
      messageId: message.id,
      cycleKey: cycle.cycle_key
    }
  });

  const queued = [];

  for (const recipient of recipients) {
    if (!clean_(recipient.recipient_email)) continue;

    const queueRow = await insertEncouragementQueueRow_(client, {
      messageType,
      config,
      cycle,
      message,
      recipient,
      sourceType: config.sourceType,
      idempotencyKey: idempotencyKey_(messageType, config.sourceType, cycle.cycle_key, message.id, recipient.recipient_email, recipient.recipient_id)
    });

    queued.push(queueRow);
  }

  const status = queued.length ? "QUEUED" : "NO_RECIPIENTS";
  const runResult = await client.query(
    `
      update encouragement_email_runs
      set
        selected_recipient_count = greatest(selected_recipient_count, $2),
        queued_count = queued_count + $3,
        status = $4,
        updated_at = now()
      where id = $1::uuid
      returning *
    `,
    [run.id, recipients.length, queued.length, status]
  );

  return {
    ok: true,
    status: queued.length ? "ENCOURAGEMENT_EMAILS_QUEUED" : "NO_ENCOURAGEMENT_RECIPIENTS_SELECTED",
    mode: reused_existing_cycle_run ? "EXISTING_CYCLE_RUN_REUSED_NO_ROTATION_ADVANCE" : "NEW_CYCLE_RUN_ROTATION_ADVANCED",
    message_type: messageType,
    source_type: config.sourceType,
    cycle,
    rotation,
    reused_existing_cycle_run,
    message: summariseMessage_(message),
    selected_recipient_count: recipients.length,
    queued_count: queued.length,
    run: runResult.rows[0],
    queued,
    checked_at: nowIso_()
  };
}

async function queueEncouragementEmailsByType_(messageType, options = {}) {
  const config = CONFIG_BY_MESSAGE_TYPE[messageType];
  if (!config) throw new Error(`Unsupported encouragement message_type: ${messageType}`);

  const cycle = buildCycle_(messageType, options);
  const testRecipientEmail = clean_(options.testRecipientEmail || options.test_recipient_email);

  return withSupabaseClient(async (client) => {
    await client.query("begin");

    try {
      const result = testRecipientEmail
        ? await queueTestEncouragementEmail_(client, { messageType, config, cycle, options })
        : await queueRealEncouragementEmails_(client, { messageType, config, cycle, options });

      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

function summariseMessage_(message) {
  if (!message) return null;
  return {
    id: message.id,
    message_type: message.message_type,
    message_key: message.message_key,
    sequence_number: message.sequence_number,
    subject: message.subject,
    audience_type: message.audience_type
  };
}

export async function queueWeeklyStudentEncouragementEmails(options = {}) {
  return queueEncouragementEmailsByType_(MESSAGE_TYPES.weeklyStudent, options);
}

export async function queueWeeklyTeacherEncouragementEmails(options = {}) {
  return queueEncouragementEmailsByType_(MESSAGE_TYPES.weeklyTeacher, options);
}

export async function queueWeeklyEncouragementEmails(options = {}) {
  const studentResult = await queueWeeklyStudentEncouragementEmails(options);
  const teacherResult = await queueWeeklyTeacherEncouragementEmails(options);

  return {
    ok: studentResult.ok !== false && teacherResult.ok !== false,
    status: "WEEKLY_STUDENT_AND_TEACHER_ENCOURAGEMENT_QUEUE_RUN_COMPLETE",
    student_result: studentResult,
    teacher_result: teacherResult,
    checked_at: nowIso_()
  };
}

export async function getEncouragementEmailSummary(options = {}) {
  const limit = normaliseLimit_(options.limit, 20, 100);

  return withSupabaseClient(async (client) => {
    const rotationResult = await client.query(
      `
        select
          s.message_type,
          s.current_rotation_number,
          s.last_sequence_number,
          s.last_real_cycle_key,
          s.last_advanced_at,
          count(m.id) filter (where m.status = 'active')::integer as active_message_count,
          cardinality(s.used_message_ids)::integer as used_in_current_rotation,
          count(m.id) filter (where m.status = 'active' and not (m.id = any(s.used_message_ids)))::integer as remaining_before_reset
        from encouragement_rotation_state s
        left join encouragement_messages m on m.message_type = s.message_type
        group by s.message_type, s.current_rotation_number, s.last_sequence_number, s.last_real_cycle_key, s.last_advanced_at, s.used_message_ids
        order by s.message_type
      `
    );

    const runsResult = await client.query(
      `
        select
          id,
          message_type,
          cycle_key,
          cycle_date,
          source_type,
          test_mode,
          test_recipient_email,
          message_key,
          sequence_number,
          status,
          selected_recipient_count,
          queued_count,
          created_at,
          updated_at
        from encouragement_email_runs
        order by created_at desc
        limit $1
      `,
      [limit]
    );

    return {
      ok: true,
      status: "ENCOURAGEMENT_EMAIL_SUMMARY",
      message_types: MESSAGE_TYPES,
      source_types: SOURCE_TYPES,
      rotation: rotationResult.rows,
      recent_runs: runsResult.rows,
      checked_at: nowIso_()
    };
  });
}

export function getEncouragementEmailSourceTypes() {
  return SOURCE_TYPES;
}

export function getEncouragementMessageTypes() {
  return MESSAGE_TYPES;
}
