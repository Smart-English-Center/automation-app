import {
  getCorrectionSummary,
  processSpeakingCorrectionOne,
  processTranscriptionOne,
  processWritingCorrectionOne
} from "../supabase/correctionRepository.js";

function nowIso_() {
  return new Date().toISOString();
}

function getConfiguredAdminSecret_() {
  return String(
    process.env.WORKER_ADMIN_TEST_SECRET ||
    process.env.WORKER_ADMIN_SECRET ||
    process.env.ADMIN_SECRET ||
    ""
  ).trim();
}

function getProvidedAdminSecret_(req) {
  return String(
    req.get("x-worker-admin-secret") ||
    req.get("x-admin-secret") ||
    req.query.secret ||
    req.body?.secret ||
    ""
  ).trim();
}

function requireAdmin_(req, res) {
  const expected = getConfiguredAdminSecret_();

  if (!expected) {
    res.status(500).json({
      ok: false,
      status: "ADMIN_SECRET_NOT_CONFIGURED",
      message: "Set WORKER_ADMIN_TEST_SECRET, WORKER_ADMIN_SECRET, or ADMIN_SECRET before running correction routes.",
      checked_at: nowIso_()
    });
    return false;
  }

  if (getProvidedAdminSecret_(req) !== expected) {
    res.status(401).json({
      ok: false,
      status: "UNAUTHORIZED",
      message: "Provide the admin secret in x-worker-admin-secret, x-admin-secret, ?secret=..., or request body secret.",
      checked_at: nowIso_()
    });
    return false;
  }

  return true;
}

function handleRouteError_(res, route, error) {
  res.status(500).json({
    ok: false,
    route,
    error: String(error && error.message ? error.message : error),
    checked_at: nowIso_()
  });
}

function optionsFromRequest_(req) {
  return {
    limit: req.query.limit || req.body?.limit,
    draftId: req.query.draft_id || req.body?.draft_id,
    studentEmail: req.query.student_email || req.body?.student_email,
    includeWriting: req.query.include_writing ?? req.body?.include_writing,
    includeSpeaking: req.query.include_speaking ?? req.body?.include_speaking,
    failFast: req.query.fail_fast || req.body?.fail_fast,
    workerId: req.get("x-worker-id") || req.body?.worker_id || "manual-correction-route"
  };
}

function statusCodeFor_(result) {
  if (!result || result.ok === false) return 500;
  if (String(result.status || "").startsWith("NO_")) return 200;
  return 201;
}

export function registerCorrectionRoutes(app) {
  app.get("/worker/corrections/summary", async (req, res) => {
    try {
      res.json(await getCorrectionSummary());
    } catch (error) {
      handleRouteError_(res, "/worker/corrections/summary", error);
    }
  });

  app.post("/worker/corrections/process-writing-one", async (req, res) => {
    if (!requireAdmin_(req, res)) return;

    try {
      const result = await processWritingCorrectionOne(optionsFromRequest_(req));
      res.status(statusCodeFor_(result)).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/corrections/process-writing-one", error);
    }
  });

  app.post("/worker/corrections/process-transcription-one", async (req, res) => {
    if (!requireAdmin_(req, res)) return;

    try {
      const result = await processTranscriptionOne(optionsFromRequest_(req));
      res.status(statusCodeFor_(result)).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/corrections/process-transcription-one", error);
    }
  });

  app.post("/worker/corrections/process-speaking-one", async (req, res) => {
    if (!requireAdmin_(req, res)) return;

    try {
      const result = await processSpeakingCorrectionOne(optionsFromRequest_(req));
      res.status(statusCodeFor_(result)).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/corrections/process-speaking-one", error);
    }
  });

  app.post("/worker/corrections/process-batch", async (req, res) => {
    if (!requireAdmin_(req, res)) return;

    res.status(410).json({
      ok: false,
      status: "CORRECTION_BATCH_DISABLED",
      message: "Batch correction is disabled by design. Use /worker/corrections/process-writing-one, /worker/corrections/process-transcription-one, and /worker/corrections/process-speaking-one so every correction is processed and returned immediately.",
      checked_at: nowIso_()
    });
  });
}
