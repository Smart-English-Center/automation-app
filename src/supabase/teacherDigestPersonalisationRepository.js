import {
  addCalendarDays,
  calculateWeeklyMetric,
  completedWeekForSunday,
  groupFeedbackDeliveries,
  hasThreeCompleteInactiveDays,
  isLastSundayOfMonth,
  isQuizOnlyFollowUp,
  normaliseQuizPercentage
} from "../teacherDigest/personalisation.js";
import {
  runTeacherDigestStage,
  teacherDigestWindowDiagnosticContext
} from "../teacherDigest/diagnosticStage.js";

function clean_(value) {
  return String(value ?? "").trim();
}

function rowsByStudent_(rows = []) {
  const output = new Map();
  for (const row of rows) {
    const studentId = clean_(row.student_id);
    if (!studentId) continue;
    if (!output.has(studentId)) output.set(studentId, []);
    output.get(studentId).push(row);
  }
  return output;
}

function oneByStudent_(rows = []) {
  return new Map(rows.map((row) => [clean_(row.student_id), row]));
}

function rowWithinWindow_(row, window) {
  const value = new Date(row?.submitted_at || row?.delivery_sent_at || "").getTime();
  const start = new Date(window.activity_window_start).getTime();
  const end = new Date(window.activity_window_end_exclusive).getTime();
  return Number.isFinite(value) && Number.isFinite(start) && Number.isFinite(end) && value >= start && value < end;
}

async function loadLastActivity_(client, studentIds, activityWindowEndExclusive) {
  if (!studentIds.length) return new Map();
  const historicalCutoff = clean_(activityWindowEndExclusive);
  if (!historicalCutoff) {
    throw new Error("Teacher digest last-activity lookup requires activity_window_end_exclusive.");
  }
  const result = await client.query(
    `
      with activity as (
        select student_id, submitted_at, true as is_assignment,
          (
            nullif(btrim(coalesce(writing_answer, '')), '') is not null
            or nullif(btrim(coalesce(answer_text, '')), '') is not null
          ) as has_writing,
          (
            nullif(btrim(coalesce(audio_link, '')), '') is not null
            or nullif(btrim(coalesce(speakpipe_link, '')), '') is not null
          ) as has_speaking
        from submission_inbox
        where student_id = any($1::uuid[])
          and submitted_at < $2::timestamptz
          and upper(coalesce(status, '')) not in ('SUPERSEDED', 'INVALID', 'DELETED')
          and (
            nullif(btrim(coalesce(writing_answer, '')), '') is not null
            or nullif(btrim(coalesce(answer_text, '')), '') is not null
            or nullif(btrim(coalesce(audio_link, '')), '') is not null
            or nullif(btrim(coalesce(speakpipe_link, '')), '') is not null
          )
        union all
        select student_id, submitted_at, false as is_assignment,
          false as has_writing,
          false as has_speaking
        from quiz_scores
        where student_id = any($1::uuid[])
          and submitted_at < $2::timestamptz
          and upper(coalesce(status, '')) not in ('SUPERSEDED', 'INVALID', 'DELETED')
      )
      select
        student_id,
        max(submitted_at) as last_submission_at,
        max(submitted_at) filter (where is_assignment) as last_assignment_at,
        max(submitted_at) filter (where has_writing) as last_writing_at,
        max(submitted_at) filter (where has_speaking) as last_speaking_at
      from activity
      group by student_id
    `,
    [studentIds, historicalCutoff]
  );
  return oneByStudent_(result.rows);
}

async function loadRecentSubmissions_(client, studentIds, cycleDate) {
  if (!studentIds.length) return [];
  const result = await client.query(
    `
      select id, student_id, assignment_key, writing_answer, answer_text,
             audio_link, speakpipe_link, submitted_at, status,
             level, module, unit, day
      from submission_inbox
      where student_id = any($1::uuid[])
        and submitted_at >= ($2::date::timestamp at time zone 'Africa/Douala')
        and submitted_at < ($3::date::timestamp at time zone 'Africa/Douala')
        and upper(coalesce(status, '')) not in ('SUPERSEDED', 'INVALID', 'DELETED')
      order by student_id, submitted_at, id
    `,
    [studentIds, addCalendarDays(cycleDate, -35), cycleDate]
  );
  return result.rows;
}

async function loadRecentQuizzes_(client, studentIds, cycleDate) {
  if (!studentIds.length) return [];
  const result = await client.query(
    `
      select id, student_id, quiz_key, score, max_score, percentage, submitted_at, status
      from quiz_scores
      where student_id = any($1::uuid[])
        and submitted_at >= ($2::date::timestamp at time zone 'Africa/Douala')
        and submitted_at < ($3::date::timestamp at time zone 'Africa/Douala')
        and upper(coalesce(status, '')) not in ('SUPERSEDED', 'INVALID', 'DELETED')
      order by student_id, submitted_at, id
    `,
    [studentIds, addCalendarDays(cycleDate, -35), cycleDate]
  );
  return result.rows;
}

async function loadUnseenFeedback_(client, studentIds, window, options = {}) {
  if (!studentIds.length) return [];
  const result = await client.query(
    `
      with candidates as (
        select
          ff.id,
          ff.student_id,
          ff.email_queue_id,
          ff.assignment_key,
          ff.writing_status,
          ff.writing_score,
          ff.speaking_status,
          ff.speaking_score,
          ff.speaking_problem_code,
          ff.pdf_drive_url as feedback_link,
          ff.email_sent_at,
          ff.updated_at,
          coalesce(eq.sent_at, ff.email_sent_at) as delivery_sent_at,
          coalesce(
            ff.email_queue_id::text,
            'legacy:' || ff.id::text
          ) as delivery_key,
          row_number() over (
            partition by ff.student_id, ff.assignment_key
            order by coalesce(eq.sent_at, ff.email_sent_at, ff.updated_at, ff.created_at) desc, ff.id desc
          ) as display_rank
        from final_feedback ff
        left join email_queue eq on eq.id = ff.email_queue_id
        where ff.student_id = any($1::uuid[])
          and (
            (ff.email_queue_id is not null and upper(coalesce(eq.status, '')) = 'SENT')
            or (
              ff.email_queue_id is null
              and upper(coalesce(ff.delivery_status, '')) in ('EMAIL_SENT', 'SENT')
              and ff.email_sent_at is not null
            )
          )
          and upper(coalesce(ff.pdf_status, '')) = 'PDF_READY'
          and nullif(btrim(coalesce(ff.pdf_drive_url, '')), '') is not null
          and coalesce(eq.sent_at, ff.email_sent_at) >= $2::timestamptz
          and coalesce(eq.sent_at, ff.email_sent_at) < $3::timestamptz
          and ($4::boolean or not exists (
            select 1
            from teacher_digest_deepseek_evidence_items included
            where included.source_kind = 'FINAL_FEEDBACK'
              and included.source_id = ff.id
              and included.is_included = true
              and included.delivery_key = coalesce(
                ff.email_queue_id::text,
                'legacy:' || ff.id::text
              )
          ))
      )
      select *, (display_rank = 1) as is_displayed
      from candidates
      order by student_id, delivery_sent_at, id
    `,
    [
      studentIds,
      window.feedback_window_start,
      window.feedback_window_end_exclusive,
      Boolean(options.ignoreInclusionHistory || options.ignore_inclusion_history)
    ]
  );
  return result.rows;
}

async function loadUnseenQuizzes_(client, studentIds, window, options = {}) {
  if (!studentIds.length) return [];
  const result = await client.query(
    `
      with candidates as (
        select
          quiz.id,
          quiz.student_id,
          quiz.quiz_key,
          quiz.score,
          quiz.max_score,
          quiz.percentage,
          quiz.submitted_at,
          row_number() over (
            partition by quiz.student_id, quiz.quiz_key
            order by quiz.submitted_at desc, quiz.id desc
          ) as display_rank
        from quiz_scores quiz
        where quiz.student_id = any($1::uuid[])
          and quiz.submitted_at >= $2::timestamptz
          and quiz.submitted_at < $3::timestamptz
          and upper(coalesce(quiz.status, '')) not in ('SUPERSEDED', 'INVALID', 'DELETED')
          and ($4::boolean or not exists (
            select 1
            from teacher_digest_deepseek_evidence_items included
            where included.source_kind = 'QUIZ_SCORE'
              and included.source_id = quiz.id
              and included.is_included = true
          ))
      )
      select *, (display_rank = 1) as is_displayed
      from candidates
      order by student_id, submitted_at, id
    `,
    [
      studentIds,
      window.activity_window_start,
      window.activity_window_end_exclusive,
      Boolean(options.ignoreInclusionHistory || options.ignore_inclusion_history)
    ]
  );
  return result.rows;
}

async function loadFeedbackForWeek_(client, studentIds, weekStart, weekEnd) {
  if (!studentIds.length) return [];
  const result = await client.query(
    `
      select distinct on (ff.student_id, ff.assignment_key)
        ff.id,
        ff.student_id,
        ff.submission_id,
        ff.assignment_key,
        ff.writing_status,
        ff.writing_score,
        ff.speaking_status,
        ff.speaking_score,
        ff.speaking_problem_code,
        ff.updated_at,
        ff.created_at
      from final_feedback ff
      join submission_inbox submission on submission.id = ff.submission_id
      where ff.student_id = any($1::uuid[])
        and submission.submitted_at >= ($2::date::timestamp at time zone 'Africa/Douala')
        and submission.submitted_at < (($3::date + 1)::timestamp at time zone 'Africa/Douala')
      order by ff.student_id, ff.assignment_key, coalesce(ff.updated_at, ff.created_at) desc, ff.id desc
    `,
    [studentIds, weekStart, weekEnd]
  );
  return result.rows;
}

async function upsertWeeklyMetric_(client, metric) {
  const result = await client.query(
    `
      insert into student_weekly_learning_metrics (
        student_id, enrollment_id, teacher_id, week_start, week_end, timezone,
        eligible_start_date, eligible_days, is_partial_enrollment_week,
        active_days, activity_dates,
        quiz_activity_count, writing_activity_count, speaking_activity_count,
        quiz_assessed_count, writing_assessed_count, speaking_assessed_count,
        quiz_not_assessed_count, writing_not_assessed_count, speaking_not_assessed_count,
        quiz_pending_count, writing_pending_count, speaking_pending_count,
        quiz_average, writing_average, speaking_average,
        last_activity_at, last_quiz_at, last_writing_at, last_speaking_at,
        source_snapshot, metric_version, calculated_at, created_at, updated_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, $4::date, $5::date, $6,
        $7::date, $8, $9,
        $10, $11::date[],
        $12, $13, $14,
        $15, $16, $17,
        $18, $19, $20,
        $21, $22, $23,
        $24, $25, $26,
        $27::timestamptz, $28::timestamptz, $29::timestamptz, $30::timestamptz,
        $31::jsonb, 1, now(), now(), now()
      )
      on conflict (student_id, week_start) do update
      set
        enrollment_id = excluded.enrollment_id,
        teacher_id = excluded.teacher_id,
        week_end = excluded.week_end,
        timezone = excluded.timezone,
        eligible_start_date = excluded.eligible_start_date,
        eligible_days = excluded.eligible_days,
        is_partial_enrollment_week = excluded.is_partial_enrollment_week,
        active_days = excluded.active_days,
        activity_dates = excluded.activity_dates,
        quiz_activity_count = excluded.quiz_activity_count,
        writing_activity_count = excluded.writing_activity_count,
        speaking_activity_count = excluded.speaking_activity_count,
        quiz_assessed_count = excluded.quiz_assessed_count,
        writing_assessed_count = excluded.writing_assessed_count,
        speaking_assessed_count = excluded.speaking_assessed_count,
        quiz_not_assessed_count = excluded.quiz_not_assessed_count,
        writing_not_assessed_count = excluded.writing_not_assessed_count,
        speaking_not_assessed_count = excluded.speaking_not_assessed_count,
        quiz_pending_count = excluded.quiz_pending_count,
        writing_pending_count = excluded.writing_pending_count,
        speaking_pending_count = excluded.speaking_pending_count,
        quiz_average = excluded.quiz_average,
        writing_average = excluded.writing_average,
        speaking_average = excluded.speaking_average,
        last_activity_at = excluded.last_activity_at,
        last_quiz_at = excluded.last_quiz_at,
        last_writing_at = excluded.last_writing_at,
        last_speaking_at = excluded.last_speaking_at,
        source_snapshot = excluded.source_snapshot,
        metric_version = student_weekly_learning_metrics.metric_version + 1,
        calculated_at = now(),
        updated_at = now()
      returning *
    `,
    [
      metric.student_id, metric.enrollment_id, metric.teacher_id, metric.week_start, metric.week_end, metric.timezone,
      metric.eligible_start_date, metric.eligible_days, metric.is_partial_enrollment_week,
      metric.active_days, metric.activity_dates,
      metric.quiz_activity_count, metric.writing_activity_count, metric.speaking_activity_count,
      metric.quiz_assessed_count, metric.writing_assessed_count, metric.speaking_assessed_count,
      metric.quiz_not_assessed_count, metric.writing_not_assessed_count, metric.speaking_not_assessed_count,
      metric.quiz_pending_count, metric.writing_pending_count, metric.speaking_pending_count,
      metric.quiz_average, metric.writing_average, metric.speaking_average,
      metric.last_activity_at, metric.last_quiz_at, metric.last_writing_at, metric.last_speaking_at,
      JSON.stringify({ calculator: "teacher-digest-v2", activity_dates: metric.activity_dates })
    ]
  );
  return result.rows[0];
}

async function loadFourWeeklyMetrics_(client, studentIds, currentWeekStart) {
  if (!studentIds.length) return new Map();
  const result = await client.query(
    `
      select *
      from student_weekly_learning_metrics
      where student_id = any($1::uuid[])
        and week_start <= $2::date
        and week_start >= ($2::date - 21)
      order by student_id, week_start asc
    `,
    [studentIds, currentWeekStart]
  );
  return rowsByStudent_(result.rows);
}

export async function buildTeacherDigestEvidence(client, { students, teacher, window, options = {} }) {
  const studentIds = students.map((student) => student.student_id).filter(Boolean);
  const windowContext = teacherDigestWindowDiagnosticContext(window);
  // A single pg Client must not execute concurrent queries. Keep these reads
  // sequential so the digest remains compatible with pg 9 and later.
  const lastActivity = await runTeacherDigestStage(
    "LOAD_LAST_ACTIVITY",
    () => loadLastActivity_(client, studentIds, window.activity_window_end_exclusive),
    windowContext
  );
  const recentSubmissions = await runTeacherDigestStage(
    "LOAD_RECENT_ASSIGNMENTS",
    () => loadRecentSubmissions_(client, studentIds, window.cycle_date),
    windowContext
  );
  const recentQuizzes = await runTeacherDigestStage(
    "LOAD_RECENT_QUIZZES",
    () => loadRecentQuizzes_(client, studentIds, window.cycle_date),
    windowContext
  );
  const unseenFeedback = await runTeacherDigestStage(
    "LOAD_UNSEEN_FEEDBACK",
    () => loadUnseenFeedback_(client, studentIds, window, options),
    windowContext
  );
  const unseenQuizzes = await runTeacherDigestStage(
    "LOAD_UNSEEN_QUIZZES",
    () => loadUnseenQuizzes_(client, studentIds, window, options),
    windowContext
  );

  const submissionsByStudent = rowsByStudent_(recentSubmissions);
  const quizzesByStudent = rowsByStudent_(recentQuizzes);
  const unseenFeedbackByStudent = rowsByStudent_(unseenFeedback);
  const unseenQuizzesByStudent = rowsByStudent_(unseenQuizzes);
  const isSunday = clean_(window.cycle_day).toUpperCase() === "SUNDAY";
  const persistWeeklyMetrics = options.persistWeeklyMetrics !== false && options.persist_weekly_metrics !== false;
  const currentMetrics = new Map();
  let fourMetrics = new Map();

  if (isSunday) {
    const completedWeek = completedWeekForSunday(window.cycle_date);
    const feedbackForWeek = rowsByStudent_(await runTeacherDigestStage(
      "LOAD_COMPLETED_WEEK_FEEDBACK",
      () => loadFeedbackForWeek_(client, studentIds, completedWeek.week_start, completedWeek.week_end),
      { ...windowContext, week_start: completedWeek.week_start, week_end: completedWeek.week_end }
    ));

    for (const student of students) {
      const studentId = clean_(student.student_id);
      const metric = calculateWeeklyMetric({
        student: { ...student, teacher_id: teacher.teacher_id },
        weekStart: completedWeek.week_start,
        submissions: submissionsByStudent.get(studentId) || [],
        quizzes: quizzesByStudent.get(studentId) || [],
        feedback: feedbackForWeek.get(studentId) || []
      });
      if (!metric) continue;
      currentMetrics.set(studentId, persistWeeklyMetrics
        ? await runTeacherDigestStage(
          "UPSERT_WEEKLY_METRIC",
          () => upsertWeeklyMetric_(client, metric),
          { cycle_date: window.cycle_date, week_start: completedWeek.week_start, week_end: completedWeek.week_end }
        )
        : metric);
    }

    fourMetrics = await runTeacherDigestStage(
      "LOAD_FOUR_WEEK_METRICS",
      () => loadFourWeeklyMetrics_(client, studentIds, completedWeek.week_start),
      { cycle_date: window.cycle_date, week_start: completedWeek.week_start }
    );
  }

  return students.map((student) => {
    const studentId = clean_(student.student_id);
    const studentSubmissions = submissionsByStudent.get(studentId) || [];
    const studentQuizzes = quizzesByStudent.get(studentId) || [];
    const activity = lastActivity.get(studentId) || {};
    let metrics = fourMetrics.get(studentId) || [];
    const currentMetric = currentMetrics.get(studentId) || null;
    if (currentMetric && !persistWeeklyMetrics) {
      metrics = [
        ...metrics.filter((metric) => clean_(metric.week_start).slice(0, 10) !== clean_(currentMetric.week_start).slice(0, 10)),
        currentMetric
      ].sort((a, b) => clean_(a.week_start).localeCompare(clean_(b.week_start)));
    }
    const previousMetric = currentMetric
      ? metrics.find((metric) => clean_(metric.week_start).slice(0, 10) === addCalendarDays(currentMetric.week_start, -7)) || null
      : null;

    const displayedFeedback = (unseenFeedbackByStudent.get(studentId) || []).filter((row) => row.is_displayed);
    const displayedQuizzes = (unseenQuizzesByStudent.get(studentId) || []).filter((row) => row.is_displayed);
    const latestSubmission = studentSubmissions.at(-1) || {};
    const payloadStudent = {
      ...student,
      current_module: latestSubmission.module ?? student.current_module
    };
    const facts = {
      cycle_date: window.cycle_date,
      cycle_day: window.cycle_day,
      is_last_sunday_of_month: isLastSundayOfMonth(window.cycle_date),
      last_submission_at: activity.last_submission_at || "",
      has_ever_submitted: Boolean(activity.last_submission_at),
      last_assignment_at: activity.last_assignment_at || "",
      last_writing_at: activity.last_writing_at || "",
      last_speaking_at: activity.last_speaking_at || "",
      inactivity_eligible: hasThreeCompleteInactiveDays({
        cycleDate: window.cycle_date,
        lastActivityAt: activity.last_submission_at,
        enrollmentStart: student.start_date || student.registration_start_at
      }),
      quiz_only_eligible: isQuizOnlyFollowUp({
        cycleDate: window.cycle_date,
        submissions: studentSubmissions,
        quizzes: studentQuizzes
      }),
      window_submissions: studentSubmissions.filter((row) => rowWithinWindow_(row, window)),
      window_quizzes: studentQuizzes.filter((row) => rowWithinWindow_(row, window)),
      unseen_feedback: displayedFeedback,
      feedback_deliveries: groupFeedbackDeliveries(displayedFeedback),
      feedback_items_to_include: unseenFeedbackByStudent.get(studentId) || [],
      unseen_quizzes: displayedQuizzes,
      quiz_items_to_include: unseenQuizzesByStudent.get(studentId) || [],
      current_metric: currentMetric,
      previous_metric: previousMetric,
      four_week_metrics: metrics
    };

    return {
      student_id: student.student_id,
      student: payloadStudent,
      facts
    };
  });
}
