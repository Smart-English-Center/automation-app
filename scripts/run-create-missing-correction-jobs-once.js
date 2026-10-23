const baseUrl = String(process.env.WORKER_BASE_URL || process.env.PUBLIC_WORKER_BASE_URL || process.env.SLIPLANE_APP_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, "");
const adminSecret = String(process.env.WORKER_ADMIN_TEST_SECRET || process.env.WORKER_ADMIN_SECRET || process.env.ADMIN_SECRET || "").trim();
const limit = Number(process.env.CREATE_MISSING_JOBS_LIMIT || 25);

if (!adminSecret) {
  console.error(JSON.stringify({ ok: false, script: "run-create-missing-correction-jobs-once", error: "Missing admin secret." }, null, 2));
  process.exit(1);
}

try {
  const response = await fetch(`${baseUrl}/worker/forms/create-missing-correction-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-admin-secret": adminSecret },
    body: JSON.stringify({ secret: adminSecret, limit })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  console.log(JSON.stringify({ ok: response.ok, script: "run-create-missing-correction-jobs-once", status: response.status, response: data }, null, 2));
  if (!response.ok) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({ ok: false, script: "run-create-missing-correction-jobs-once", error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
