import crypto from "node:crypto";
import { withSupabaseClient } from "./client.js";

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

function hashToken_(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function createToken_() {
  return crypto.randomBytes(32).toString("base64url");
}

function addDays_(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + Number(days || 0));
  return copy;
}

function parseDateOnly_(value) {
  const raw = clean_(value);
  if (!raw) return null;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const canonical = `${match[1]}-${match[2]}-${match[3]}`;
  const date = new Date(`${canonical}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== canonical) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function daysInMonth_(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normaliseCycleMonth_(value) {
  const parsed = parseDateOnly_(value) || parseDateOnly_(nowIso_());
  return `${String(parsed.year).padStart(4, "0")}-${String(parsed.month).padStart(2, "0")}-01`;
}

function paymentDueDateForCycleMonth_(startDate, cycleMonth) {
  const start = parseDateOnly_(startDate) || parseDateOnly_(cycleMonth) || parseDateOnly_(nowIso_());
  const cycle = parseDateOnly_(cycleMonth) || parseDateOnly_(nowIso_());
  const day = Math.min(start.day || 1, daysInMonth_(cycle.year, cycle.month));
  return `${String(cycle.year).padStart(4, "0")}-${String(cycle.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function tableExists_(client, tableName) {
  const result = await client.query("select to_regclass($1) as table_name", [`public.${tableName}`]);
  return Boolean(result.rows[0]?.table_name);
}

export async function ensureAdminPaymentControlTables() {
  return withSupabaseClient(async (client) => {
    await ensureAdminPaymentControlTables_(client);
    return { ok: true, checked_at: nowIso_() };
  });
}

async function ensureAdminPaymentControlTables_(client) {
  const runsExists = await tableExists_(client, "admin_monthly_payment_control_runs");
  const studentsExists = await tableExists_(client, "admin_monthly_payment_control_students");
  const actionsExists = await tableExists_(client, "admin_monthly_payment_control_actions");

  if (!runsExists || !studentsExists || !actionsExists) {
    throw new Error(
      "Admin payment control tables are missing. Run the SQL provided for admin monthly payment control before using this feature."
    );
  }
}

async function loadActiveStudentRows_(client, cycleMonth) {
  const result = await client.query(
    `
      select
        e.id as enrollment_id,
        e.student_id,
        e.teacher_id,
        coalesce(nullif(trim(s.first_name), ''), split_part(nullif(trim(s.full_name), ''), ' ', 1), '') as student_first_name,
        nullif(trim(s.full_name), '') as student_full_name,
        lower(trim(s.email)) as student_email,
        coalesce(nullif(trim(s.whatsapp_number), ''), nullif(trim(s.phone), '')) as student_phone,
        nullif(trim(e.level), '') as level,
        e.start_date,
        e.registration_start_at,
        lower(trim(t.email)) as teacher_email,
        nullif(trim(t.full_name), '') as teacher_name
      from students s
      join lateral (
        select candidate.*
        from enrollments candidate
        where candidate.student_id = s.id
          and candidate.active is true
          and upper(trim(candidate.status)) = 'ACTIVE'
        order by candidate.start_date desc nulls last, candidate.id
        limit 1
      ) e on true
      left join teachers t on t.id = e.teacher_id
      where s.active is true
      order by lower(trim(coalesce(s.full_name, s.email))), s.id
    `
  );

  return result.rows.map((row) => ({
    ...row,
    payment_due_date: paymentDueDateForCycleMonth_(row.start_date || row.registration_start_at, cycleMonth)
  }));
}

async function insertRunSnapshot_(client, run, rows) {
  if (!rows.length) return [];

  const inserted = [];
  for (const row of rows) {
    const result = await client.query(
      `
        insert into admin_monthly_payment_control_students (
          run_id,
          student_id,
          enrollment_id,
          teacher_id,
          student_first_name,
          student_full_name,
          student_email,
          student_phone,
          level,
          enrollment_start_date,
          payment_due_date,
          teacher_email,
          teacher_name,
          row_status,
          created_at,
          updated_at
        ) values (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ACTIVE',now(),now()
        )
        returning *
      `,
      [
        run.id,
        row.student_id,
        row.enrollment_id,
        row.teacher_id,
        clean_(row.student_first_name),
        clean_(row.student_full_name),
        lower_(row.student_email),
        clean_(row.student_phone),
        upper_(row.level),
        row.start_date || null,
        row.payment_due_date || null,
        lower_(row.teacher_email),
        clean_(row.teacher_name)
      ]
    );
    inserted.push(result.rows[0]);
  }

  return inserted;
}

export async function createMonthlyPaymentControlRuns({
  adminEmails = [],
  cycleMonth = "",
  validityDays = 30,
  force = false
} = {}, dependencies = {}) {
  const recipients = [...new Set((adminEmails || []).map(lower_).filter(Boolean))];
  const normalizedCycleMonth = normaliseCycleMonth_(cycleMonth);
  const createdAt = new Date();
  const expiresAt = addDays_(createdAt, validityDays).toISOString();

  if (!recipients.length) {
    return {
      ok: false,
      status: "NO_ADMIN_RECIPIENTS",
      message: "No admin payment-control recipient email is configured.",
      runs: [],
      checked_at: nowIso_()
    };
  }

  const withClient = dependencies.withSupabaseClient || withSupabaseClient;

  return withClient(async (client) => {
    await ensureAdminPaymentControlTables_(client);
    await client.query("begin");

    try {
      const activeRows = await loadActiveStudentRows_(client, normalizedCycleMonth);
      const runs = [];
      const skipped = [];

      for (const adminEmail of recipients) {
        if (force) {
          await client.query(
            `
              update admin_monthly_payment_control_runs
              set status = 'SUPERSEDED', updated_at = now()
              where cycle_month = $1::date
                and lower(admin_email) = $2
                and status in ('CREATED', 'SENT')
            `,
            [normalizedCycleMonth, adminEmail]
          );
        } else {
          const existing = await client.query(
            `
              select id, cycle_month, admin_email, status, sent_at, expires_at
              from admin_monthly_payment_control_runs
              where cycle_month = $1::date
                and lower(admin_email) = $2
                and status in ('CREATED', 'SENT')
                and expires_at > now()
              order by created_at desc
              limit 1
            `,
            [normalizedCycleMonth, adminEmail]
          );

          if (existing.rows[0]) {
            skipped.push(existing.rows[0]);
            continue;
          }
        }

        const tokenRaw = createToken_();
        const tokenHash = hashToken_(tokenRaw);
        const runResult = await client.query(
          `
            insert into admin_monthly_payment_control_runs (
              cycle_month,
              admin_email,
              token_hash,
              status,
              sent_at,
              expires_at,
              active_student_count,
              created_at,
              updated_at
            ) values ($1::date,$2,$3,'CREATED',null,$4,$5,now(),now())
            returning *
          `,
          [normalizedCycleMonth, adminEmail, tokenHash, expiresAt, activeRows.length]
        );

        const run = runResult.rows[0];
        const students = await insertRunSnapshot_(client, run, activeRows);
        runs.push({ ...run, token_raw: tokenRaw, students });
      }

      await client.query("commit");
      return {
        ok: true,
        status: "ADMIN_PAYMENT_CONTROL_RUNS_CREATED",
        cycle_month: normalizedCycleMonth,
        created_run_count: runs.length,
        skipped_run_count: skipped.length,
        active_student_count: activeRows.length,
        runs,
        skipped_runs: skipped,
        checked_at: nowIso_()
      };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}

export async function markMonthlyPaymentControlRunEmailStatus({
  runId,
  status,
  brevoMessageId = "",
  errorMessage = ""
} = {}) {
  const normalizedStatus = upper_(status) === "SENT" ? "SENT" : "FAILED";

  return withSupabaseClient(async (client) => {
    await ensureAdminPaymentControlTables_(client);
    const result = await client.query(
      `
        update admin_monthly_payment_control_runs
        set
          status = $2,
          brevo_message_id = $3,
          error_message = $4,
          sent_at = case when $2 = 'SENT' then coalesce(sent_at, now()) else sent_at end,
          updated_at = now()
        where id = $1
        returning *
      `,
      [runId, normalizedStatus, clean_(brevoMessageId), clean_(errorMessage)]
    );

    return result.rows[0] || null;
  });
}

export async function getMonthlyPaymentControlRunByToken(token) {
  const tokenHash = hashToken_(token);

  return withSupabaseClient(async (client) => {
    await ensureAdminPaymentControlTables_(client);
    const runResult = await client.query(
      `
        select *
        from admin_monthly_payment_control_runs
        where token_hash = $1
        limit 1
      `,
      [tokenHash]
    );

    const run = runResult.rows[0] || null;
    if (!run) return null;

    const studentsResult = await client.query(
      `
        select *
        from admin_monthly_payment_control_students
        where run_id = $1
          and upper(coalesce(row_status, 'ACTIVE')) = 'ACTIVE'
        order by lower(coalesce(student_full_name, student_email)), created_at, id
      `,
      [run.id]
    );

    return {
      ...run,
      token_raw: token,
      expired: run.expires_at ? new Date(run.expires_at).getTime() <= Date.now() : true,
      students: studentsResult.rows
    };
  });
}

export async function deactivateStudentFromMonthlyPaymentControl(
  { token, paymentControlStudentId } = {},
  dependencies = {}
) {
  const tokenHash = hashToken_(token);
  const withClient = dependencies.withSupabaseClient || withSupabaseClient;

  return withClient(async (client) => {
    await ensureAdminPaymentControlTables_(client);
    await client.query("begin");

    try {
      const runResult = await client.query(
        `
          select *
          from admin_monthly_payment_control_runs
          where token_hash = $1
          limit 1
          for update
        `,
        [tokenHash]
      );

      const run = runResult.rows[0] || null;
      if (!run) {
        await client.query("rollback");
        return { ok: false, status: "INVALID_LINK", message: "Payment-control link is invalid.", checked_at: nowIso_() };
      }

      if (!run.expires_at || new Date(run.expires_at).getTime() <= Date.now()) {
        await client.query("rollback");
        return { ok: false, status: "LINK_EXPIRED", message: "Payment-control link has expired.", run, checked_at: nowIso_() };
      }

      if (!["CREATED", "SENT"].includes(upper_(run.status))) {
        await client.query("rollback");
        return { ok: false, status: "RUN_NOT_ACTIVE", message: `This run is not active. Current status: ${run.status}.`, run, checked_at: nowIso_() };
      }

      const rowResult = await client.query(
        `
          select *
          from admin_monthly_payment_control_students
          where id = $1
            and run_id = $2
          limit 1
          for update
        `,
        [clean_(paymentControlStudentId), run.id]
      );

      const row = rowResult.rows[0] || null;
      if (!row) {
        await client.query("rollback");
        return { ok: false, status: "STUDENT_ROW_NOT_FOUND", message: "The selected student row was not found for this payment-control run.", run, checked_at: nowIso_() };
      }

      if (upper_(row.row_status) === "DEACTIVATED") {
        await client.query("rollback");
        return { ok: true, status: "ALREADY_DEACTIVATED", message: "This student was already deactivated from this payment-control page.", run, student: row, checked_at: nowIso_() };
      }

      const enrollmentResult = await client.query(
        `
          update enrollments
          set
            active = false,
            status = 'INACTIVE',
            closed_reason = 'ADMIN_PAYMENT_DEACTIVATION',
            notes = concat_ws(E'\n', nullif(notes, ''), 'Closed from monthly admin payment-control page.'),
            updated_at = now()
          where id = $1
            and student_id = $2
            and active is true
            and upper(trim(status)) = 'ACTIVE'
          returning *
        `,
        [row.enrollment_id, row.student_id]
      );

      await client.query(
        `
          update students
          set
            active = false,
            status = 'INACTIVE',
            notes = concat_ws(E'\n', nullif(notes, ''), 'Set inactive from monthly admin payment-control page.'),
            updated_at = now()
          where id = $1
        `,
        [row.student_id]
      );

      const updatedRowResult = await client.query(
        `
          update admin_monthly_payment_control_students
          set
            row_status = 'DEACTIVATED',
            deactivated_at = now(),
            updated_at = now()
          where id = $1
          returning *
        `,
        [row.id]
      );

      const actionResult = await client.query(
        `
          insert into admin_monthly_payment_control_actions (
            run_id,
            payment_control_student_id,
            student_id,
            enrollment_id,
            action_type,
            status,
            metadata_json,
            created_at
          ) values ($1,$2,$3,$4,'DEACTIVATE_STUDENT','SUCCESS',$5::jsonb,now())
          returning *
        `,
        [
          run.id,
          row.id,
          row.student_id,
          row.enrollment_id,
          JSON.stringify({ closed_enrollment_count: enrollmentResult.rows.length })
        ]
      );

      await client.query("commit");

      return {
        ok: true,
        status: "STUDENT_DEACTIVATED",
        run,
        student: updatedRowResult.rows[0],
        closed_enrollment_count: enrollmentResult.rows.length,
        action: actionResult.rows[0],
        checked_at: nowIso_()
      };
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}
