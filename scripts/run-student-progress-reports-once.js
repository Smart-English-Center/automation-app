import { queueStudentProgressReports } from "../src/supabase/studentProgressReportRepository.js";

function numberEnv_(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

try {
  const result = await queueStudentProgressReports({
    cycleDate: process.env.PROGRESS_REPORT_CYCLE_DATE || "",
    periodStart: process.env.PROGRESS_REPORT_PERIOD_START || "",
    periodEnd: process.env.PROGRESS_REPORT_PERIOD_END || "",
    limit: numberEnv_("PROGRESS_REPORT_LIMIT", 200),
    testMode: process.env.PROGRESS_REPORT_TEST_MODE || process.env.STUDENT_EMAIL_TEST_MODE || "",
    testRecipient: process.env.PROGRESS_REPORT_TEST_RECIPIENT || process.env.STUDENT_EMAIL_TEST_RECIPIENT || ""
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    script: "run-student-progress-reports-once",
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString()
  }, null, 2));
  process.exit(1);
}
