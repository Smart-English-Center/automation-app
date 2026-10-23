import {
  createMissingCorrectionJobsForSubmissions,
  getImportPipelineSummary,
  importFormSubmissionEvent,
  reconcileSourceForms
} from "../supabase/dataImportRepository.js";

function nowIso_() {
  return new Date().toISOString();
}

function getConfiguredSecret_(names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

function getProvidedSecret_(req) {
  return String(
    req.get("x-form-webhook-secret") ||
    req.get("x-worker-admin-secret") ||
    req.query.secret ||
    req.body?.secret ||
    ""
  ).trim();
}

function requireSecret_(req, res, names, label) {
  const configured = getConfiguredSecret_(names);
  if (!configured) return true;
  if (getProvidedSecret_(req) === configured) return true;
  res.status(401).json({
    ok: false,
    status: "UNAUTHORIZED",
    message: `Provide ${label} in x-form-webhook-secret, x-worker-admin-secret, ?secret=..., or request body secret.`,
    checked_at: nowIso_()
  });
  return false;
}

function getLimit_(req, fallback = 50, max = 1000) {
  const parsed = Number(req.query.limit ?? req.body?.limit ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function handleRouteError_(res, route, error) {
  res.status(500).json({
    ok: false,
    route,
    error: String(error && error.message ? error.message : error),
    error_details: {
      message: error?.message || String(error),
      name: error?.name || "Error",
      code: error?.code || "",
      detail: error?.detail || "",
      hint: error?.hint || "",
      table: error?.table || "",
      column: error?.column || "",
      constraint: error?.constraint || ""
    },
    checked_at: nowIso_()
  });
}

function importOptionsFromRequest_(req) {
  return {
    dryRun: req.query.dry_run || req.body?.dry_run,
    limit: getLimit_(req, 50, 500),
    maxRowsPerTab: req.query.max_rows_per_tab || req.body?.max_rows_per_tab,
    maxTabs: req.query.max_tabs || req.body?.max_tabs,
    tabsPerRun: req.query.tabs_per_run || req.body?.tabs_per_run || req.query.reconcile_tabs_per_run || req.body?.reconcile_tabs_per_run,
    maxImports: req.query.max_imports || req.body?.max_imports,
    spreadsheetId: req.query.spreadsheet_id || req.body?.spreadsheet_id || req.body?.source_sheet_id
  };
}

export function registerDataImportRoutes(app) {
  app.get("/worker/import/summary", async (req, res) => {
    try {
      res.json(await getImportPipelineSummary({ limit: getLimit_(req, 50, 500) }));
    } catch (error) {
      handleRouteError_(res, "/worker/import/summary", error);
    }
  });

  app.post("/worker/forms/import-submission", async (req, res) => {
    if (!requireSecret_(req, res, ["FORM_WEBHOOK_SECRET", "WORKER_ADMIN_TEST_SECRET", "WORKER_ADMIN_SECRET", "ADMIN_SECRET"], "the form webhook/admin secret")) return;

    try {
      const result = await importFormSubmissionEvent(req.body || {});
      res.status(201).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/forms/import-submission", error);
    }
  });

  app.post("/worker/forms/import-submission-test", async (req, res) => {
    if (!requireSecret_(req, res, ["WORKER_ADMIN_TEST_SECRET", "WORKER_ADMIN_SECRET", "ADMIN_SECRET"], "the admin secret")) return;

    try {
      const result = await importFormSubmissionEvent({ ...(req.body || {}), test_import: true });
      res.status(201).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/forms/import-submission-test", error);
    }
  });

  app.post("/worker/forms/reconcile-source-forms", async (req, res) => {
    if (!requireSecret_(req, res, ["WORKER_ADMIN_TEST_SECRET", "WORKER_ADMIN_SECRET", "ADMIN_SECRET"], "the admin secret")) return;

    try {
      const result = await reconcileSourceForms(importOptionsFromRequest_(req));
      res.status(result.ok ? 200 : 500).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/forms/reconcile-source-forms", error);
    }
  });

  app.post("/worker/forms/create-missing-correction-jobs", async (req, res) => {
    if (!requireSecret_(req, res, ["WORKER_ADMIN_TEST_SECRET", "WORKER_ADMIN_SECRET", "ADMIN_SECRET"], "the admin secret")) return;

    try {
      const result = await createMissingCorrectionJobsForSubmissions({ limit: getLimit_(req, 25, 500) });
      res.status(result.ok ? 200 : 500).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/forms/create-missing-correction-jobs", error);
    }
  });
}
