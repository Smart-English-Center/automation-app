const baseUrl = String(process.env.WORKER_BASE_URL || process.env.PUBLIC_WORKER_BASE_URL || process.env.SLIPLANE_APP_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, "");
const adminSecret = String(process.env.WORKER_ADMIN_TEST_SECRET || process.env.WORKER_ADMIN_SECRET || process.env.ADMIN_SECRET || "").trim();

if (!adminSecret) {
  console.error(JSON.stringify({ ok: false, script: "run-source-form-reconciliation-once", error: "Missing admin secret." }, null, 2));
  process.exit(1);
}

const body = {
  secret: adminSecret,
  dry_run: String(process.env.RECONCILE_DRY_RUN || "false").toLowerCase() === "true",
  max_rows_per_tab: Number(process.env.RECONCILE_MAX_ROWS_PER_TAB || 200),
  tabs_per_run: Number(process.env.RECONCILE_TABS_PER_RUN || process.env.RECONCILE_MAX_TABS || 4),
  max_tabs: Number(process.env.RECONCILE_MAX_TABS || process.env.RECONCILE_TABS_PER_RUN || 4),
  max_imports: Number(process.env.RECONCILE_MAX_IMPORTS || 100),
  spreadsheet_id: process.env.RECONCILE_SPREADSHEET_ID || ""
};

try {
  const response = await fetch(`${baseUrl}/worker/forms/reconcile-source-forms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-worker-admin-secret": adminSecret },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  console.log(JSON.stringify({ ok: response.ok, script: "run-source-form-reconciliation-once", status: response.status, response: data }, null, 2));
  if (!response.ok) process.exit(1);
} catch (error) {
  console.error(JSON.stringify({ ok: false, script: "run-source-form-reconciliation-once", error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
}
