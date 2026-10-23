const baseUrl = String(
  process.env.WORKER_BASE_URL ||
  process.env.PUBLIC_WORKER_BASE_URL ||
  process.env.SLIPLANE_APP_URL ||
  `http://127.0.0.1:${process.env.PORT || 3000}`
).replace(/\/+$/, "");

const adminSecret = String(
  process.env.WORKER_ADMIN_TEST_SECRET ||
  process.env.WORKER_ADMIN_SECRET ||
  process.env.ADMIN_SECRET ||
  ""
).trim();

const limit = Math.max(
  1,
  Number(process.env.CORRECTION_JOB_LIMIT || process.env.SPEAKING_CORRECTION_JOB_LIMIT || 1)
);

/*
  Scheduler entry point for Supabase-native correction jobs.

  This script intentionally does not call legacy batch routes.
  Each loop calls the one-by-one correction route for the requested job type:
  - WRITING_CORRECTION  -> /worker/corrections/process-writing-one
  - TRANSCRIBE_AUDIO     -> /worker/corrections/process-transcription-one
  - SPEAKING_EVALUATION  -> /worker/corrections/process-speaking-one
  - SPEAKING_CORRECTION  -> /worker/corrections/process-speaking-one

  CORRECTION_JOB_LIMIT controls how many one-by-one attempts are made per job
  type during one scheduler run. This keeps the pipeline immediate/idempotent
  without reviving the old /worker/run-batch or /worker/speaking-batch-once flow.
*/
const jobTypes = String(
  process.env.CORRECTION_JOB_TYPES ||
  "WRITING_CORRECTION,TRANSCRIBE_AUDIO,SPEAKING_EVALUATION"
).trim();

const routeByJobType = new Map([
  ["WRITING_CORRECTION", "/worker/corrections/process-writing-one"],
  ["TRANSCRIBE_AUDIO", "/worker/corrections/process-transcription-one"],
  ["SPEAKING_EVALUATION", "/worker/corrections/process-speaking-one"],
  ["SPEAKING_CORRECTION", "/worker/corrections/process-speaking-one"]
]);

const noWorkStatuses = new Set([
  "NO_WRITING_CORRECTION_READY",
  "NO_SPEAKING_TRANSCRIPTION_READY",
  "NO_SPEAKING_CORRECTION_READY"
]);

if (!adminSecret) {
  console.error(JSON.stringify({
    ok: false,
    script: "process-correction-jobs",
    error: "Missing WORKER_ADMIN_TEST_SECRET / WORKER_ADMIN_SECRET / ADMIN_SECRET."
  }, null, 2));

  process.exit(1);
}

const normalisedJobTypes = jobTypes
  .split(",")
  .map((item) => String(item || "").trim().toUpperCase())
  .filter(Boolean);

const unsupportedJobTypes = normalisedJobTypes.filter((jobType) => !routeByJobType.has(jobType));

if (unsupportedJobTypes.length) {
  console.error(JSON.stringify({
    ok: false,
    script: "process-correction-jobs",
    error: "Unsupported CORRECTION_JOB_TYPES value.",
    unsupported_job_types: unsupportedJobTypes,
    supported_job_types: Array.from(routeByJobType.keys()),
    at: new Date().toISOString()
  }, null, 2));

  process.exit(1);
}

if (!normalisedJobTypes.length) {
  console.log(JSON.stringify({
    ok: true,
    script: "process-correction-jobs",
    status: "NO_JOB_TYPES_CONFIGURED",
    at: new Date().toISOString()
  }, null, 2));

  process.exit(0);
}

const allResults = [];
let hasFailure = false;

for (const jobType of normalisedJobTypes) {
  const route = routeByJobType.get(jobType);
  const url = `${baseUrl}${route}?worker_id=${encodeURIComponent("scheduler-process-correction-jobs")}`;
  const jobResults = [];

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const result = await callOneCorrectionRoute_({ jobType, url, attempt });
    jobResults.push(result);

    if (!result.ok) {
      hasFailure = true;
      break;
    }

    if (noWorkStatuses.has(String(result.response?.status || ""))) {
      break;
    }
  }

  allResults.push({
    job_type: jobType,
    route,
    attempts_requested: limit,
    attempts_completed: jobResults.length,
    results: jobResults
  });
}

console.log(JSON.stringify({
  ok: !hasFailure,
  script: "process-correction-jobs",
  mode: "supabase_one_by_one_correction_routes",
  base_url: baseUrl,
  limit_per_job_type: limit,
  job_types: normalisedJobTypes,
  results: allResults,
  at: new Date().toISOString()
}, null, 2));

if (hasFailure) {
  process.exit(1);
}

async function callOneCorrectionRoute_({ jobType, url, attempt }) {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-secret": adminSecret
      },
      body: JSON.stringify({
        worker_id: "scheduler-process-correction-jobs"
      })
    });

    const text = await response.text();
    const body = parseResponseBody_(text);

    return {
      ok: response.ok,
      job_type: jobType,
      attempt,
      status: response.status,
      route_mode: "one_by_one",
      url,
      response: body,
      at: new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      job_type: jobType,
      attempt,
      route_mode: "one_by_one",
      url,
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString()
    };
  }
}

function parseResponseBody_(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
