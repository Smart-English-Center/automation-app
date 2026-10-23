/******************************************************************
 * Twice-monthly student progress reports.
 *
 * Reports are sent at the beginning and middle of each month:
 * - 1st day: previous month 16 -> previous month end
 * - 15th day: current month 1 -> current month 14
 ******************************************************************/

import {
  clean,
  escapeHtml,
  messageCardHtml,
  nameCardHtml,
  paragraph,
  statGridHtml,
  textJoin,
  whatsappButtonHtml,
  wrapEmailHtml
} from "../emailDesign.js";
import { studentFacingName } from "../studentFacingName.js";
import { studentLanguageForLevel, whatsappUrlForTeacher } from "../submissionPolicy.js";
import { createAndQueueMaintainerAlert } from "./maintainerAlertRepository.js";
import { withSupabaseClient } from "./client.js";

export const PROGRESS_REPORT_SOURCE_TYPE = "TWICE_MONTHLY_PROGRESS_REPORT";

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

function numberLimit_(value, fallback = 200, max = 1000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.trunc(parsed), max);
}

function boolEnv_(name, fallback = false) {
  return boolValue_(process.env[name], fallback);
}

function boolValue_(value, fallback = false) {
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(raw)) return true;
  if (["0", "false", "no", "n", "off"].includes(raw)) return false;
  return fallback;
}

function firstConfiguredBoolean_(values = [], fallback = false) {
  for (const value of values) {
    if (value === undefined || value === null || clean(value) === "") continue;
    return boolValue_(value, fallback);
  }
  return fallback;
}

function isoDate_(date) {
  return date.toISOString().slice(0, 10);
}

function parseCycleDate_(value) {
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export function calculateProgressReportPeriod(options = {}) {
  const explicitStart = clean(options.periodStart || options.period_start || process.env.PROGRESS_REPORT_PERIOD_START);
  const explicitEnd = clean(options.periodEnd || options.period_end || process.env.PROGRESS_REPORT_PERIOD_END);

  if (explicitStart && explicitEnd) {
    return {
      period_start: explicitStart,
      period_end: explicitEnd,
      period_start_inclusive: `${explicitStart}T00:00:00.000Z`,
      period_end_exclusive: `${explicitEnd}T00:00:00.000Z`,
      mode: "EXPLICIT"
    };
  }

  const cycleDate = parseCycleDate_(options.cycleDate || options.cycle_date || process.env.PROGRESS_REPORT_CYCLE_DATE);
  const year = cycleDate.getUTCFullYear();
  const month = cycleDate.getUTCMonth();
  const day = cycleDate.getUTCDate();

  let start;
  let endExclusive;
  let mode;

  if (day >= 15) {
    start = new Date(Date.UTC(year, month, 1));
    endExclusive = new Date(Date.UTC(year, month, 15));
    mode = "FIRST_HALF_OF_CURRENT_MONTH";
  } else {
    start = new Date(Date.UTC(year, month - 1, 16));
    endExclusive = new Date(Date.UTC(year, month, 1));
    mode = "SECOND_HALF_OF_PREVIOUS_MONTH";
  }

  return {
    period_start: isoDate_(start),
    period_end: isoDate_(new Date(endExclusive.getTime() - 24 * 60 * 60 * 1000)),
    period_start_inclusive: start.toISOString(),
    period_end_exclusive: endExclusive.toISOString(),
    mode
  };
}

function activeCategory_(averageDaysPerWeek) {
  return Number(averageDaysPerWeek || 0) >= 4 ? "COMMENDATION" : "ENCOURAGEMENT";
}

function formatNumber_(value, digits = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "—";
  return parsed.toFixed(digits).replace(/\.0$/, "");
}

function dateLabel_(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return clean(value);
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "2-digit",
    month: "short"
  }).format(date);
}


function teacherWhatsappForStudent_(student = {}) {
  return whatsappUrlForTeacher({
    teacher_whatsapp_url: student.teacher_whatsapp_url,
    whatsapp_url: student.teacher_whatsapp_url,
    teacher_whatsapp: student.teacher_whatsapp_number,
    whatsapp_number: student.teacher_whatsapp_number,
    phone: student.teacher_phone
  }, process.env.DEFAULT_ACADEMY_WHATSAPP || process.env.JEA_SUPPORT_WHATSAPP_NUMBER || "");
}

function teacherButton_(url, language = "en") {
  return whatsappButtonHtml(url, language === "fr" ? "Contacter votre professeur sur WhatsApp" : "Contact your teacher on WhatsApp");
}

function workedDaysText_(workedDays = [], language = "fr") {
  if (!workedDays.length) {
    return language === "fr" ? "Aucun jour d’activité enregistré." : "No active day recorded.";
  }

  return workedDays.map((day) => {
    const items = Array.isArray(day.items) ? day.items : [];
    const lines = items.map((item) => {
      if (language === "fr") {
        if (item.type === "quiz") return `  - Quiz ${item.key || ""}${item.score_display ? ` — ${item.score_display}` : ""}`;
        return `  - Devoir ${item.key || ""} — ${item.writing_status || "writing reçu"}, ${item.speaking_status || "speaking reçu"}`;
      }
      if (item.type === "quiz") return `  - Quiz ${item.key || ""}${item.score_display ? ` — ${item.score_display}` : ""}`;
      return `  - Assignment ${item.key || ""} — ${item.writing_status || "writing received"}, ${item.speaking_status || "speaking received"}`;
    });
    return `- ${dateLabel_(day.date)}\n${lines.join("\n")}`;
  }).join("\n");
}

function activityPillHtml_(label, theme = "progressGood") {
  return `<span style="display:inline-block;font-size:12px;font-weight:bold;border-radius:999px;padding:5px 8px;background:#eef2ff;color:#4338ca;margin:4px 4px 0 0;">${escapeHtml(label)}</span>`;
}

function workedDaysHtml_(workedDays = [], language = "fr", theme = "progressGood") {
  if (!workedDays.length) {
    return `<div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:14px;padding:14px;color:#374151;">${language === "fr" ? "Aucun jour d’activité enregistré." : "No active day recorded."}</div>`;
  }

  return `
    <ul style="list-style:none;padding:0;margin:12px 0 0;">
      ${workedDays.map((day) => {
        const items = Array.isArray(day.items) ? day.items : [];
        return `
          <li style="padding:12px 13px;margin-bottom:9px;border-radius:14px;background:#f8fafc;border:1px solid #e6eaf0;font-size:14px;color:#344054;">
            <div style="font-weight:bold;color:#101828;margin-bottom:4px;">${escapeHtml(dateLabel_(day.date))}</div>
            <div>
              ${items.map((item) => {
                if (item.type === "quiz") {
                  return activityPillHtml_(`Quiz ${item.key || ""}${item.score_display ? ` — ${item.score_display}` : ""}`, theme);
                }
                const label = language === "fr"
                  ? `Devoir ${item.key || ""} — ${item.writing_status || "writing reçu"}, ${item.speaking_status || "speaking reçu"}`
                  : `Assignment ${item.key || ""} — ${item.writing_status || "writing received"}, ${item.speaking_status || "speaking received"}`;
                return activityPillHtml_(label, theme);
              }).join("")}
            </div>
          </li>
        `;
      }).join("")}
    </ul>
  `;
}

function renderProgressEmail_({ student, report, period }) {
  const language = studentLanguageForLevel(student.level);
  const firstName = studentFacingName(student.student_name, language === "fr" ? "cher apprenant" : "there");
  const activeDays = Number(report.active_days_count || 0);
  const averageDays = Number(report.average_active_days_per_week || 0);
  const category = clean(report.category) || activeCategory_(averageDays);
  const commend = category === "COMMENDATION";
  const quizAverage = report.quiz_average === null || report.quiz_average === undefined ? "—" : `${formatNumber_(report.quiz_average, 1)}%`;
  const workedDays = Array.isArray(report.worked_days_json) ? report.worked_days_json : [];
  const theme = commend ? "progressGood" : "progressLow";
  const whatsappUrl = teacherWhatsappForStudent_(student);

  if (language === "fr") {
    const subject = commend
      ? `Bravo ${firstName}, vos efforts sont visibles`
      : `${firstName}, vous pouvez renforcer votre rythme`;
    const hero = commend
      ? "Vous avez travaillé avec une bonne régularité pendant cette période."
      : "Cette période montre qu’un peu plus de régularité vous aiderait beaucoup.";
    const mainMessage = commend
      ? "Travailler quatre jours ou plus par semaine montre un vrai engagement. Continuez ainsi."
      : "Essayez de viser au moins quatre jours d’activité par semaine. Vous n’avez pas besoin de tout faire le même jour. Des petites séances régulières sont plus utiles que de longues pauses.";

    const bodyText = textJoin([
      `Bonjour ${firstName},`,
      `Voici votre rapport de progression pour la période du ${period.period_start} au ${period.period_end}.`,
      `Jours actifs : ${activeDays}`,
      `Moyenne d’activité : ${formatNumber_(averageDays, 1)} jour(s) par semaine`,
      `Quiz complétés : ${report.quiz_count}`,
      `Devoirs writing/speaking envoyés : ${report.assignment_count}`,
      `Moyenne des quiz : ${quizAverage}`,
      `Détail des activités reçues :\n${workedDaysText_(workedDays, "fr")}`,
      mainMessage,
      whatsappUrl ? `Contacter votre professeur : ${whatsappUrl}` : "",
      "John’s English Academy"
    ]);

    const bodyHtml = wrapEmailHtml({
      subject,
      preheader: `Rapport du ${period.period_start} au ${period.period_end}`,
      badge: "Rapport de progression",
      theme,
      background: "#eef4ff",
      children: `
        ${nameCardHtml({ eyebrow: "Rapport de progression", name: firstName, subtitle: hero, theme })}
        ${statGridHtml([
          { label: "Jours actifs", value: String(activeDays) },
          { label: "Moyenne/semaine", value: `${formatNumber_(averageDays, 1)} jours` },
          { label: "Appréciation", value: commend ? "Bravo" : "À renforcer" }
        ])}
        ${messageCardHtml({ title: commend ? "Votre régularité mérite d’être reconnue." : "Vous pouvez reprendre un meilleur rythme.", body: mainMessage, theme })}
        ${statGridHtml([
          { label: "Quiz", value: String(report.quiz_count || 0) },
          { label: "Devoirs", value: String(report.assignment_count || 0) },
          { label: "Moyenne quiz", value: quizAverage }
        ])}
        <p style="margin:18px 0 8px;font-size:15px;color:#344054;"><strong>Détail des activités reçues :</strong></p>
        ${workedDaysHtml_(workedDays, "fr", theme)}
        ${teacherButton_(whatsappUrl, "fr")}
      `
    });

    return { subject, bodyText, bodyHtml };
  }

  const subject = commend
    ? `Excellent consistency, ${firstName}`
    : `${firstName}, you can strengthen your rhythm`;
  const hero = commend
    ? "Your effort during this period deserves to be recognised."
    : "This period suggests that a more regular routine would help you a lot.";
  const mainMessage = commend
    ? "Working four or more days per week shows commitment. Keep this rhythm."
    : "Try to reach at least four active days per week. Short, regular study sessions are more effective than long gaps.";

  const bodyText = textJoin([
    `Hello ${firstName},`,
    `Here is your progress report for ${period.period_start} to ${period.period_end}.`,
    `Active days: ${activeDays}`,
    `Average activity: ${formatNumber_(averageDays, 1)} day(s) per week`,
    `Completed quizzes: ${report.quiz_count}`,
    `Writing/speaking assignments submitted: ${report.assignment_count}`,
    `Quiz average: ${quizAverage}`,
    `Activities received:\n${workedDaysText_(workedDays, "en")}`,
    mainMessage,
    whatsappUrl ? `Contact your teacher: ${whatsappUrl}` : "",
    "John’s English Academy"
  ]);

  const bodyHtml = wrapEmailHtml({
    subject,
    preheader: `Progress report from ${period.period_start} to ${period.period_end}`,
    badge: "Progress report",
    theme,
    background: "#eef4ff",
    children: `
      ${nameCardHtml({ eyebrow: "Progress report", name: firstName, subtitle: hero, theme })}
      ${statGridHtml([
        { label: "Active days", value: String(activeDays) },
        { label: "Average/week", value: `${formatNumber_(averageDays, 1)} days` },
        { label: "Category", value: commend ? "Commended" : "Encouragement" }
      ])}
      ${messageCardHtml({ title: commend ? "Your regular work is making a difference." : "A small improvement can change your results.", body: mainMessage, theme })}
      ${statGridHtml([
        { label: "Quizzes", value: String(report.quiz_count || 0) },
        { label: "Assignments", value: String(report.assignment_count || 0) },
        { label: "Quiz average", value: quizAverage }
      ])}
      <p style="margin:18px 0 8px;font-size:15px;color:#344054;"><strong>Activities received during the period:</strong></p>
      ${workedDaysHtml_(workedDays, "en", theme)}
      ${teacherButton_(whatsappUrl, "en")}
    `
  });

  return { subject, bodyText, bodyHtml };
}

async function getStudentActivity_(client, studentId, period, timezone) {
  const result = await client.query(
    `
      with ranked_quizzes as (
        select
          qs.*,
          row_number() over (
            partition by qs.student_id, qs.quiz_key
            order by qs.submitted_at desc nulls last, qs.created_at desc nulls last, qs.id desc
          ) as rn
        from quiz_scores qs
        where qs.student_id = $1::uuid
          and qs.submitted_at >= $2::timestamptz
          and qs.submitted_at < $3::timestamptz
          and coalesce(qs.quiz_key, '') <> ''
      ),
      latest_quizzes as (
        select * from ranked_quizzes where rn = 1
      ),
      ranked_assignments as (
        select
          si.*,
          row_number() over (
            partition by si.student_id, coalesce(nullif(si.assignment_key, ''), si.id::text)
            order by si.submitted_at desc nulls last, si.created_at desc nulls last, si.id desc
          ) as rn,
          exists (
            select 1
            from ai_drafts d
            where d.submission_id = si.id
              and d.job_type in ('SPEAKING_EVALUATION','SPEAKING_CORRECTION')
              and (
                upper(coalesce(d.status, '')) = 'NOT_ASSESSED'
                or upper(coalesce(d.review_status, '')) in ('BAD_SUBMISSION','NOT_ASSESSED')
              )
          ) as speaking_not_assessed
        from submission_inbox si
        where si.student_id = $1::uuid
          and si.submitted_at >= $2::timestamptz
          and si.submitted_at < $3::timestamptz
          and coalesce(si.skill_type, '') = 'ASSIGNMENT'
          and coalesce(si.assignment_key, '') <> ''
      ),
      latest_assignments as (
        select * from ranked_assignments where rn = 1
      ),
      activity as (
        select
          (qs.submitted_at at time zone $4)::date as activity_date,
          qs.submitted_at as submitted_at,
          'quiz'::text as item_type,
          qs.id::text as activity_id,
          qs.quiz_key::text as activity_key,
          qs.score_display::text as score_display,
          qs.percentage::numeric as percentage,
          null::text as writing_status,
          null::text as speaking_status
        from latest_quizzes qs

        union all

        select
          (si.submitted_at at time zone $4)::date as activity_date,
          si.submitted_at as submitted_at,
          'assignment'::text as item_type,
          si.id::text as activity_id,
          si.assignment_key::text as activity_key,
          null::text as score_display,
          null::numeric as percentage,
          case
            when trim(coalesce(si.writing_answer, si.answer_text, '')) <> '' then 'writing received'
            else 'writing missing'
          end as writing_status,
          case
            when si.speaking_not_assessed then 'speaking link needs correction'
            when trim(coalesce(si.audio_link, si.speakpipe_link, '')) <> '' then 'speaking received'
            else 'speaking missing'
          end as speaking_status
        from latest_assignments si
      ),
      days as (
        select
          activity_date,
          jsonb_agg(
            jsonb_build_object(
              'type', item_type,
              'id', activity_id,
              'key', activity_key,
              'score_display', score_display,
              'percentage', percentage,
              'writing_status', writing_status,
              'speaking_status', speaking_status,
              'submitted_at', submitted_at
            ) order by submitted_at, item_type, activity_key
          ) as items,
          count(*)::integer as item_count
        from activity
        where activity_date is not null
        group by activity_date
      ),
      summary as (
        select
          count(distinct activity_date)::integer as active_days_count,
          count(*) filter (where item_type = 'quiz')::integer as quiz_count,
          count(*) filter (where item_type = 'assignment')::integer as assignment_count,
          avg(percentage) filter (where item_type = 'quiz' and percentage is not null) as quiz_average
        from activity
      )
      select
        coalesce((select active_days_count from summary), 0)::integer as active_days_count,
        coalesce((select quiz_count from summary), 0)::integer as quiz_count,
        coalesce((select assignment_count from summary), 0)::integer as assignment_count,
        (select quiz_average from summary) as quiz_average,
        coalesce(
          (
            select jsonb_agg(
              jsonb_build_object(
                'date', activity_date::text,
                'items', items,
                'item_count', item_count
              ) order by activity_date
            )
            from days
          ),
          '[]'::jsonb
        ) as worked_days_json
    `,
    [studentId, period.period_start_inclusive, period.period_end_exclusive, timezone]
  );

  return result.rows[0] || {
    active_days_count: 0,
    quiz_count: 0,
    assignment_count: 0,
    quiz_average: null,
    worked_days_json: []
  };
}

async function upsertProgressReport_(client, { student, period, activity, reportDays, testMode }) {
  const isTestMode = boolValue_(testMode, false);
  const activeDays = Number(activity.active_days_count || 0);
  const averageDays = reportDays > 0 ? Math.round((activeDays / reportDays) * 7 * 10) / 10 : 0;
  const category = activeCategory_(averageDays);

  const result = await client.query(
    `
      insert into student_progress_reports (
        student_id,
        teacher_id,
        level,
        period_start,
        period_end,
        active_days_count,
        average_active_days_per_week,
        worked_days_json,
        quiz_count,
        assignment_count,
        writing_submission_count,
        speaking_submission_count,
        quiz_average,
        writing_average,
        speaking_average,
        overall_average,
        category,
        language,
        email_status,
        test_mode,
        created_at,
        updated_at
      )
      values (
        $1::uuid,
        nullif($2, '')::uuid,
        $3,
        $4::date,
        $5::date,
        $6,
        $7,
        $8::jsonb,
        $9,
        $10,
        $10,
        $10,
        $11::numeric,
        null,
        null,
        $11::numeric,
        $12,
        $13,
        'QUEUED_PENDING',
        $14,
        now(),
        now()
      )
      on conflict (student_id, period_start, period_end) do update
      set
        teacher_id = excluded.teacher_id,
        level = excluded.level,
        active_days_count = excluded.active_days_count,
        average_active_days_per_week = excluded.average_active_days_per_week,
        worked_days_json = excluded.worked_days_json,
        quiz_count = excluded.quiz_count,
        assignment_count = excluded.assignment_count,
        writing_submission_count = excluded.writing_submission_count,
        speaking_submission_count = excluded.speaking_submission_count,
        quiz_average = excluded.quiz_average,
        overall_average = excluded.overall_average,
        category = excluded.category,
        language = excluded.language,
        test_mode = excluded.test_mode,
        updated_at = now()
      returning *
    `,
    [
      student.student_id,
      clean(student.teacher_id),
      clean(student.level),
      period.period_start,
      period.period_end,
      activeDays,
      averageDays,
      JSON.stringify(activity.worked_days_json || []),
      Number(activity.quiz_count || 0),
      Number(activity.assignment_count || 0),
      activity.quiz_average,
      category,
      studentLanguageForLevel(student.level),
      isTestMode
    ]
  );

  return result.rows[0];
}

async function queueProgressReportEmail_(client, { report, student, period, testMode, testRecipient }) {
  const isTestMode = boolValue_(testMode, false);
  const rendered = renderProgressEmail_({ student, report, period });
  const originalRecipient = clean(student.student_email);
  const recipientEmail = isTestMode ? testRecipient : originalRecipient;
  const recipientName = studentFacingName(student.student_name, originalRecipient);
  const subject = rendered.subject;
  const sourceType = isTestMode ? `${PROGRESS_REPORT_SOURCE_TYPE}_TEST` : PROGRESS_REPORT_SOURCE_TYPE;
  const idempotencyKey = isTestMode
    ? `progress-report-test:${report.progress_report_id}:${testRecipient}`
    : `progress-report:${report.progress_report_id}`;

  if (!recipientEmail) {
    throw new Error("Cannot queue progress report because recipient email is missing.");
  }

  const result = await client.query(
    `
      insert into email_queue (
        source_type,
        source_id,
        idempotency_key,
        status,
        recipient_role,
        recipient_email,
        recipient_name,
        teacher_id,
        student_id,
        subject,
        body_html,
        body_text,
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
        'STUDENT',
        $4,
        $5,
        nullif($6, '')::uuid,
        $7::uuid,
        $8,
        $9,
        $10,
        $11::jsonb,
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
        payload_json = case when email_queue.status = 'SENT' then email_queue.payload_json else excluded.payload_json end
      returning *
    `,
    [
      sourceType,
      report.progress_report_id,
      idempotencyKey,
      recipientEmail,
      recipientName,
      clean(student.teacher_id),
      student.student_id,
      subject,
      rendered.bodyHtml,
      rendered.bodyText,
      JSON.stringify({
        source: "student-progress-report",
        progress_report_id: report.progress_report_id,
        period_start: period.period_start,
        period_end: period.period_end,
        test_mode: isTestMode,
        original_recipient_email: originalRecipient,
        teacher_whatsapp_url: teacherWhatsappForStudent_(student)
      })
    ]
  );

  const queueRow = result.rows[0];
  await client.query(
    `
      update student_progress_reports
      set
        email_id = $1::uuid,
        email_status = case when $2 = 'SENT' then 'SENT' else 'QUEUED' end,
        updated_at = now()
      where progress_report_id = $3::uuid
    `,
    [queueRow.id, queueRow.status, report.progress_report_id]
  );

  return queueRow;
}

export async function queueStudentProgressReports(options = {}) {
  const limit = numberLimit_(options.limit || process.env.PROGRESS_REPORT_LIMIT, 200, 1000);
  const timezone = clean(options.timezone || process.env.APP_TIMEZONE || process.env.TZ) || "Africa/Douala";
  const period = calculateProgressReportPeriod(options);
  const periodDays = Math.max(1, Math.round((new Date(period.period_end_exclusive).getTime() - new Date(period.period_start_inclusive).getTime()) / (24 * 60 * 60 * 1000)));
  const testMode = firstConfiguredBoolean_([
    options.testMode,
    options.test_mode,
    process.env.PROGRESS_REPORT_TEST_MODE,
    process.env.STUDENT_EMAIL_TEST_MODE
  ], false);
  const testRecipient = clean(options.testRecipient || options.test_recipient || process.env.PROGRESS_REPORT_TEST_RECIPIENT || process.env.STUDENT_EMAIL_TEST_RECIPIENT || process.env.HEAD_TEACHER_EMAIL || process.env.JEA_HEAD_TEACHER_EMAIL);

  if (testMode && !testRecipient) {
    throw new Error("Progress report test mode is enabled but no test recipient/head teacher email is configured.");
  }

  return withSupabaseClient(async (client) => {
    await client.query("begin");

    try {
      const studentResult = await client.query(
        `
          select distinct on (s.id)
            s.id as student_id,
            s.full_name as student_name,
            lower(s.email) as student_email,
            s.whatsapp_number as student_whatsapp,
            e.id as enrollment_id,
            e.teacher_id,
            e.level,
            t.full_name as teacher_name,
            lower(t.email) as teacher_email,
            t.phone as teacher_phone,
            t.whatsapp_number as teacher_whatsapp_number
          from students s
          join enrollments e on e.student_id = s.id
          left join teachers t on t.id = e.teacher_id
          where lower(coalesce(s.email, '')) <> ''
            and coalesce(s.active, true) is true
            and upper(coalesce(s.status, 'ACTIVE')) <> all($1::text[])
            and coalesce(e.active, true) is true
            and upper(coalesce(e.status, 'ACTIVE')) <> all($1::text[])
          order by s.id, e.start_date desc nulls last, e.created_at desc nulls last
          limit $2
        `,
        [ACTIVE_NEGATIVE_STATUSES, limit]
      );

      const queued = [];
      for (const student of studentResult.rows) {
        const activity = await getStudentActivity_(client, student.student_id, period, timezone);
        const report = await upsertProgressReport_(client, {
          student,
          period,
          activity,
          reportDays: periodDays,
          testMode
        });
        const queueRow = await queueProgressReportEmail_(client, {
          report,
          student,
          period,
          testMode,
          testRecipient
        });
        queued.push({ report, email: queueRow });
      }

      await client.query("commit");

      return {
        ok: true,
        status: "STUDENT_PROGRESS_REPORTS_QUEUED",
        period,
        timezone,
        test_mode: testMode,
        selected_student_count: studentResult.rows.length,
        queued_count: queued.length,
        queued,
        checked_at: new Date().toISOString()
      };
    } catch (error) {
      await client.query("rollback");
      await createAndQueueMaintainerAlert({
        severity: "ERROR",
        alert_type: "PROGRESS_REPORT_QUEUE_FAILED",
        title: "Student progress report queue failed",
        message: error instanceof Error ? error.message : String(error),
        details_json: { period, timezone, testMode }
      }).catch(() => null);
      throw error;
    }
  });
}
