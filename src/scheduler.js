import cron from "node-cron";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const DEFAULT_TIMEZONE = process.env.SCHEDULER_TIMEZONE || process.env.TZ || "Africa/Douala";
const runningTasks = new Map();

const TASK_DEFINITIONS = [
  {
    name: "JEA Source Form Reconciliation",
    enabledEnv: "ENABLE_SOURCE_FORM_RECONCILIATION_SCHEDULER",
    cronEnv: "CRON_SOURCE_FORM_RECONCILIATION",
    npmScript: "reconcile:once",
    env: () => pickEnv([
      "RECONCILE_DRY_RUN",
      "RECONCILE_MAX_ROWS_PER_TAB",
      "RECONCILE_MAX_TABS",
      "RECONCILE_MAX_IMPORTS"
    ])
  },
  {
    name: "JEA Audio Drive Storage",
    enabledEnv: "ENABLE_AUDIO_DRIVE_STORAGE_SCHEDULER",
    cronEnv: "CRON_AUDIO_DRIVE_STORAGE",
    npmScript: "audio:drive:once",
    env: () => pickEnv([
      "AUDIO_STORAGE_LIMIT",
      "AUDIO_STORAGE_MAX_ATTEMPTS"
    ])
  },
  {
    name: "JEA Create Missing Correction Jobs",
    enabledEnv: "ENABLE_CREATE_MISSING_JOBS_SCHEDULER",
    cronEnv: "CRON_CREATE_MISSING_JOBS",
    npmScript: "jobs:create-missing:once",
    env: () => pickEnv([
      "CREATE_MISSING_JOBS_LIMIT"
    ])
  },
  {
    name: "JEA Writing And Transcription Corrections",
    enabledEnv: "ENABLE_WRITING_TRANSCRIPTION_SCHEDULER",
    cronEnv: "CRON_WRITING_TRANSCRIPTION_JOBS",
    npmScript: "process:jobs",
    env: () => ({
      ...pickEnv(["WRITING_TRANSCRIPTION_JOB_LIMIT"]),
      CORRECTION_JOB_LIMIT: firstEnv("WRITING_TRANSCRIPTION_JOB_LIMIT", "CORRECTION_JOB_LIMIT"),
      CORRECTION_JOB_TYPES: requiredEnv("WRITING_TRANSCRIPTION_JOB_TYPES")
    })
  },
  {
    name: "JEA Speaking Corrections",
    enabledEnv: "ENABLE_SPEAKING_CORRECTION_SCHEDULER",
    cronEnv: "CRON_SPEAKING_CORRECTIONS",
    npmScript: "process:jobs",
    env: () => ({
      ...pickEnv(["SPEAKING_CORRECTION_JOB_LIMIT"]),
      CORRECTION_JOB_LIMIT: firstEnv("SPEAKING_CORRECTION_JOB_LIMIT", "CORRECTION_JOB_LIMIT"),
      CORRECTION_JOB_TYPES: requiredEnv("SPEAKING_CORRECTION_JOB_TYPES")
    })
  },
  {
    name: "JEA Review One Corrected Submission",
    enabledEnv: "ENABLE_REVIEW_SCHEDULER",
    cronEnv: "CRON_REVIEW_ONE",
    npmScript: "review:one",
    env: () => pickEnv([
      "REVIEW_PROVIDER",
      "DEEPSEEK_REVIEW_DRAFTS_PER_RUN",
      "DEEPSEEK_REVIEW_CONCURRENCY"
    ])
  },
  {
    name: "JEA Final Feedback Assembly",
    enabledEnv: "ENABLE_FINAL_FEEDBACK_ASSEMBLY_SCHEDULER",
    cronEnv: "CRON_FINAL_FEEDBACK_ASSEMBLY",
    npmScript: "final-feedback:assemble:once",
    env: () => pickEnv([
      "FINAL_FEEDBACK_ASSEMBLE_LIMIT"
    ])
  },
  {
    name: "JEA PDF Generation",
    enabledEnv: "ENABLE_PDF_GENERATION_SCHEDULER",
    cronEnv: "CRON_PDF_GENERATION",
    npmScript: "pdf:generate:once",
    env: () => pickEnv([
      "PDF_INCLUDE_SAME_DAY_READY",
      "PDF_MAX_ASSIGNMENTS_PER_STUDENT"
    ])
  },
  {
    name: "JEA PDF Generation Sunday",
    enabledEnv: "ENABLE_PDF_GENERATION_SUNDAY_SCHEDULER",
    cronEnv: "CRON_PDF_GENERATION_SUNDAY",
    npmScript: "pdf:generate:once",
    env: () => pickEnv([
      "PDF_INCLUDE_SAME_DAY_READY",
      "PDF_MAX_ASSIGNMENTS_PER_STUDENT"
    ])
  },
  {
    name: "JEA PDF Polling",
    enabledEnv: "ENABLE_PDF_POLL_SCHEDULER",
    cronEnv: "CRON_PDF_POLL",
    npmScript: "pdf:poll:once",
    env: () => pickEnv([
      "PDFMONKEY_POLL_LIMIT"
    ])
  },
  {
    name: "JEA Student Feedback Email Delivery",
    enabledEnv: "ENABLE_STUDENT_FEEDBACK_EMAIL_SEND_SCHEDULER",
    cronEnv: "CRON_STUDENT_FEEDBACK_EMAIL_SEND",
    npmScript: "email:once",
    env: () => ({
      ...pickEnv([
        "EMAIL_DELIVERY_LIMIT",
        "EMAIL_QUEUE_LIMIT",
        "EMAIL_MAX_ATTEMPTS",
        "EMAIL_RETRY_MINUTES",
        "EMAIL_SENDING_STALE_MINUTES"
      ]),
      QUEUE_STUDENT_FEEDBACK_EMAILS_BEFORE_SEND: firstEnv("QUEUE_STUDENT_FEEDBACK_EMAILS_BEFORE_SEND") || "true",
      STUDENT_EMAIL_DELIVERY_SOURCE_TYPES:
        firstEnv("STUDENT_FEEDBACK_EMAIL_SOURCE_TYPES", "STUDENT_EMAIL_DELIVERY_SOURCE_TYPES") ||
        "STUDENT_FEEDBACK_PDF"
    })
  },
  {
    name: "JEA Immediate Import Notification Email Delivery",
    enabledEnv: "ENABLE_INTERVENTION_EMAIL_DELIVERY_SCHEDULER",
    cronEnv: "CRON_INTERVENTION_EMAIL_DELIVERY",
    npmScript: "email:once",
    env: () => ({
      EMAIL_DELIVERY_LIMIT: firstEnv("INTERVENTION_EMAIL_DELIVERY_LIMIT", "EMAIL_DELIVERY_LIMIT"),
      EMAIL_MAX_ATTEMPTS: firstEnv("INTERVENTION_EMAIL_MAX_ATTEMPTS", "EMAIL_MAX_ATTEMPTS"),
      EMAIL_RETRY_MINUTES: firstEnv("INTERVENTION_EMAIL_RETRY_MINUTES", "EMAIL_RETRY_MINUTES"),
      EMAIL_SENDING_STALE_MINUTES: firstEnv("INTERVENTION_EMAIL_SENDING_STALE_MINUTES", "EMAIL_SENDING_STALE_MINUTES"),
      QUEUE_STUDENT_FEEDBACK_EMAILS_BEFORE_SEND: "false",
      STUDENT_EMAIL_DELIVERY_SOURCE_TYPES:
        firstEnv("INTERVENTION_EMAIL_SOURCE_TYPES") ||
        "ASSIGNMENT_RECEIPT_ACK,BAD_SPEAKPIPE_LINK_TEACHER_ALERT,BAD_WRITING_SUBMISSION_STUDENT,BAD_WRITING_SUBMISSION_TEACHER_ALERT,QUIZ_COMPLETION_ACK,MAINTAINER_ALERT,TEACHER_PROGRESS_DIGEST,TEACHER_PROGRESS_DIGEST_TEST"
    })
  },
  {
    name: "JEA Student Progress Report Queue",
    enabledEnv: "ENABLE_STUDENT_PROGRESS_REPORT_SCHEDULER",
    cronEnv: "CRON_STUDENT_PROGRESS_REPORT_QUEUE",
    npmScript: "progress:reports:queue",
    env: () => pickEnv([
      "PROGRESS_REPORT_CYCLE_DATE",
      "PROGRESS_REPORT_PERIOD_START",
      "PROGRESS_REPORT_PERIOD_END",
      "PROGRESS_REPORT_LIMIT",
      "PROGRESS_REPORT_TEST_MODE",
      "PROGRESS_REPORT_TEST_RECIPIENT",
      "STUDENT_EMAIL_TEST_MODE",
      "STUDENT_EMAIL_TEST_RECIPIENT",
      "DEFAULT_ACADEMY_WHATSAPP",
      "ACADEMY_WHATSAPP_URL",
      "JEA_SUPPORT_WHATSAPP_NUMBER"
    ])
  },
  {
    name: "JEA Student Progress Report Email Delivery",
    enabledEnv: "ENABLE_STUDENT_PROGRESS_REPORT_EMAIL_DELIVERY_SCHEDULER",
    cronEnv: "CRON_STUDENT_PROGRESS_REPORT_EMAIL_DELIVERY",
    npmScript: "email:once",
    env: () => ({
      EMAIL_DELIVERY_LIMIT: firstEnv("PROGRESS_REPORT_EMAIL_DELIVERY_LIMIT", "EMAIL_DELIVERY_LIMIT"),
      QUEUE_STUDENT_FEEDBACK_EMAILS_BEFORE_SEND: "false",
      STUDENT_EMAIL_DELIVERY_SOURCE_TYPES:
        firstEnv("PROGRESS_REPORT_EMAIL_SOURCE_TYPES") ||
        "TWICE_MONTHLY_PROGRESS_REPORT"
    })
  },
  {
    name: "JEA Teacher Progress Digest",
    enabledEnv: "ENABLE_TEACHER_PROGRESS_DIGEST_SCHEDULER",
    cronEnv: "CRON_TEACHER_PROGRESS_DIGEST",
    npmScript: "teacher:digest:once",
    env: () => pickEnv([
      "TEACHER_DIGEST_CYCLE_DATE",
      "TEACHER_DIGEST_FORCE",
      "TEACHER_DIGEST_TEACHER_ID",
      "TEACHER_DIGEST_TEACHER_EMAIL",
      "TEACHER_DIGEST_STUDENTS_PER_PDF"
    ])
  },
  {
    name: "JEA Registration Trial Expiry",
    enabledEnv: "ENABLE_REGISTRATION_EXPIRY_SCHEDULER",
    cronEnv: "CRON_REGISTRATION_EXPIRY",
    npmScript: "registration:expire:once",
    env: () => pickEnv([])
  },
  {
    name: "JEA Admin Monthly Payment Control",
    enabledEnv: "ENABLE_ADMIN_PAYMENT_CONTROL_SCHEDULER",
    cronEnv: "CRON_ADMIN_PAYMENT_CONTROL",
    npmScript: "admin:payment-control:once",
    env: () => pickEnv([
      "ADMIN_PAYMENT_CONTROL_CYCLE_MONTH",
      "ADMIN_PAYMENT_CONTROL_FORCE",
      "ADMIN_PAYMENT_CONTROL_VALIDITY_DAYS",
      "ADMIN_PAYMENT_CONTROL_EMAILS",
      "ADMIN_PAYMENT_CONTROL_PUBLIC_BASE_URL",
      "REGISTRATION_PUBLIC_BASE_URL",
      "REGISTRATION_APPROVER_EMAILS"
    ])
  },
  {
    name: "JEA Weekly Encouragement Queue",
    enabledEnv: "ENABLE_WEEKLY_ENCOURAGEMENT_QUEUE_SCHEDULER",
    cronEnv: "CRON_WEEKLY_ENCOURAGEMENT_QUEUE",
    npmScript: "encouragement:once",
    env: () => ({
      ...pickEnv(["ENCOURAGEMENT_EMAIL_QUEUE_LIMIT"]),
      ENCOURAGEMENT_EMAIL_MODE: "weekly-all"
    })
  },
  {
    name: "JEA Weekly Encouragement Email Delivery",
    enabledEnv: "ENABLE_WEEKLY_ENCOURAGEMENT_EMAIL_DELIVERY_SCHEDULER",
    cronEnv: "CRON_WEEKLY_ENCOURAGEMENT_EMAIL_DELIVERY",
    npmScript: "email:once",
    env: () => ({
      EMAIL_DELIVERY_LIMIT: firstEnv("ENCOURAGEMENT_EMAIL_DELIVERY_LIMIT", "EMAIL_DELIVERY_LIMIT"),
      QUEUE_STUDENT_FEEDBACK_EMAILS_BEFORE_SEND: "false",
      STUDENT_EMAIL_DELIVERY_SOURCE_TYPES:
        firstEnv("WEEKLY_ENCOURAGEMENT_EMAIL_SOURCE_TYPES") ||
      "WEEKLY_ACTIVE_STUDENT_ENCOURAGEMENT,WEEKLY_ACTIVE_TEACHER_ENCOURAGEMENT"
    })
  },
  {
    name: "JEA Speaking Topic Pipeline",
    enabledEnv: "ENABLE_SPEAKING_TOPIC_PIPELINE_SCHEDULER",
    cronEnv: "CRON_SPEAKING_TOPIC_PIPELINE",
    npmScript: "speaking:pipeline:once",
    env: () => pickEnv([
      "SPEAKING_TOPIC_PIPELINE_ENABLED",
      "SPEAKING_CYCLE_CUTOFF_TIME",
      "SPEAKING_STUDENT_EMAIL_TIME",
      "SPEAKING_TEACHER_DOCUMENT_TIME",
      "SPEAKING_TOPIC_BATCH_SIZE",
      "SPEAKING_TOPIC_RETRY_MINUTES",
      "SPEAKING_TEACHER_PDF_STUDENTS_PER_PART"
    ])
  },
  {
    name: "JEA Speaking Email Delivery",
    enabledEnv: "ENABLE_SPEAKING_EMAIL_DELIVERY_SCHEDULER",
    cronEnv: "CRON_SPEAKING_EMAIL_DELIVERY",
    npmScript: "speaking:email:once",
    env: () => pickEnv(["SPEAKING_EMAIL_DELIVERY_LIMIT"])
  }
];

export function startInternalScheduler() {
  const enabled = envBool("ENABLE_INTERNAL_SCHEDULER", false);

  if (!enabled) {
    console.log(JSON.stringify({
      ok: true,
      scheduler: "disabled",
      reason: "ENABLE_INTERNAL_SCHEDULER is not true.",
      at: new Date().toISOString()
    }));
    return;
  }

  const packageScripts = loadPackageScripts();
  const scheduledTasks = [];

  for (const task of TASK_DEFINITIONS) {
    scheduledTasks.push(scheduleTask(task, packageScripts));
  }

  console.log(JSON.stringify({
    ok: true,
    scheduler: "started",
    timezone: DEFAULT_TIMEZONE,
    tasks: scheduledTasks.filter(Boolean),
    at: new Date().toISOString()
  }));
}

function scheduleTask(task, packageScripts) {
  const enabled = envBool(task.enabledEnv, false);

  if (!enabled) {
    const taskInfo = {
      name: task.name,
      npm_script: task.npmScript,
      enabled: false,
      enabled_env: task.enabledEnv,
      reason: "Disabled by environment variable."
    };
    console.log(JSON.stringify({ ok: true, scheduled_task: taskInfo }));
    return taskInfo;
  }

  if (!packageScripts.has(task.npmScript)) {
    throw new Error(
      `Scheduler task "${task.name}" references missing npm script "${task.npmScript}". ` +
      `Add it to package.json or disable ${task.enabledEnv}.`
    );
  }

  const cronExpression = requiredEnv(task.cronEnv);

  if (!cron.validate(cronExpression)) {
    throw new Error(`Invalid cron expression for ${task.name} from ${task.cronEnv}: ${cronExpression}`);
  }

  const env = typeof task.env === "function" ? task.env() : {};

  cron.schedule(
    cronExpression,
    async () => {
      await runNpmTaskOnce({
        name: task.name,
        npmScript: task.npmScript,
        env
      });
    },
    { scheduled: true, timezone: DEFAULT_TIMEZONE }
  );

  const taskInfo = {
    name: task.name,
    npm_script: task.npmScript,
    enabled: true,
    enabled_env: task.enabledEnv,
    cron_env: task.cronEnv,
    cron: cronExpression,
    timezone: DEFAULT_TIMEZONE
  };

  console.log(JSON.stringify({ ok: true, scheduled_task: taskInfo }));
  return taskInfo;
}

async function runNpmTaskOnce(config) {
  const name = config.name;
  const npmScript = config.npmScript;
  const env = config.env || {};

  if (runningTasks.get(name)) {
    console.log(JSON.stringify({
      ok: true,
      task: name,
      skipped: true,
      reason: "Previous run is still active. Non-overlap protection.",
      at: new Date().toISOString()
    }));
    return;
  }

  runningTasks.set(name, true);
  const startedAt = new Date();

  console.log(JSON.stringify({
    ok: true,
    task: name,
    status: "started",
    npm_script: npmScript,
    started_at: startedAt.toISOString()
  }));

  try {
    const result = await spawnNpmScript(npmScript, env);
    const finishedAt = new Date();

    console.log(JSON.stringify({
      ok: result.exitCode === 0,
      task: name,
      status: result.exitCode === 0 ? "completed" : "failed",
      npm_script: npmScript,
      exit_code: result.exitCode,
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      finished_at: finishedAt.toISOString()
    }));

    if (result.exitCode !== 0) {
      console.error(JSON.stringify({
        ok: false,
        task: name,
        stdout_tail: tail(result.stdout, 4000),
        stderr_tail: tail(result.stderr, 4000)
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      task: name,
      status: "crashed",
      npm_script: npmScript,
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString()
    }));
  } finally {
    runningTasks.set(name, false);
  }
}

function spawnNpmScript(npmScript, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(
      "npm",
      ["run", npmScript],
      {
        env: { ...process.env, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32"
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      stderr += error instanceof Error ? error.message : String(error);
      resolve({ exitCode: 1, stdout, stderr });
    });

    child.on("close", (code) => {
      resolve({ exitCode: Number(code || 0), stdout, stderr });
    });
  });
}

function loadPackageScripts() {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8"));
    return new Set(Object.keys(packageJson.scripts || {}));
  } catch (error) {
    throw new Error(
      `Unable to read package.json scripts for scheduler validation: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function envBool(name, fallback) {
  const value = String(process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return ["true", "1", "yes", "y", "on"].includes(value);
}

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Required scheduler environment variable is missing: ${name}`);
  }
  return value;
}

function firstEnv(...names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function pickEnv(names) {
  const picked = {};
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) picked[name] = value;
  }
  return picked;
}

function tail(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return text.slice(text.length - maxLength);
}
