import {
  getReviewPreparationPreview,
  listReviewBatches,
  pollSubmittedReviewBatch,
  prepareReviewBatch,
  processReviewSubmissionPair,
  submitPreparedReviewBatch
} from "../supabase/reviewRepository.js";

function nowIso_() {
  return new Date().toISOString();
}

function getLimit_(req, fallback = 10) {
  const raw = req.query.limit ?? req.body?.limit ?? fallback;
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(Math.floor(parsed), 100);
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
    req.query.secret ||
    req.body?.secret ||
    ""
  ).trim();
}

function requireAdminSecret_(req, res) {
  const configured = getConfiguredAdminSecret_();

  if (!configured) {
    return true;
  }

  const provided = getProvidedAdminSecret_(req);

  if (provided && provided === configured) {
    return true;
  }

  res.status(401).json({
    ok: false,
    status: "UNAUTHORIZED",
    message:
      "This route changes Supabase review state. Provide x-worker-admin-secret or ?secret=... matching your configured admin secret.",
    checked_at: nowIso_()
  });

  return false;
}

function handleRouteError_(res, route, error) {
  res.status(500).json({
    ok: false,
    route,
    error: String(error && error.message ? error.message : error),
    checked_at: nowIso_()
  });
}

function sendDisabledBatchResponse_(res, result) {
  res.status(410).json(result);
}

export function registerReviewRoutes(app) {
  app.get("/worker/review/preview", async (req, res) => {
    try {
      const result = await getReviewPreparationPreview({
        limit: getLimit_(req)
      });

      res.json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/review/preview", error);
    }
  });

  app.post("/worker/review/process-submission", async (req, res) => {
    if (!requireAdminSecret_(req, res)) {
      return;
    }

    try {
      const result = await processReviewSubmissionPair({
        workerId: req.get("x-worker-id") || req.body?.worker_id || "manual-review-process-submission-route"
      });

      res.status(result.status === "NO_READY_SUBMISSION_PAIR" ? 200 : result.ok ? 201 : 500).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/review/process-submission", error);
    }
  });

  app.post("/worker/review/process-one", async (req, res) => {
    if (!requireAdminSecret_(req, res)) {
      return;
    }

    try {
      const result = await processReviewSubmissionPair({
        workerId: req.get("x-worker-id") || req.body?.worker_id || "manual-review-process-one-route"
      });

      res.status(result.status === "NO_READY_SUBMISSION_PAIR" ? 200 : result.ok ? 201 : 500).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/review/process-one", error);
    }
  });

  app.post("/worker/review/run-one", async (req, res) => {
    if (!requireAdminSecret_(req, res)) {
      return;
    }

    try {
      const result = await processReviewSubmissionPair({
        workerId: req.get("x-worker-id") || req.body?.worker_id || "manual-review-run-one-route"
      });

      res.status(result.status === "NO_READY_SUBMISSION_PAIR" ? 200 : result.ok ? 201 : 500).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/review/run-one", error);
    }
  });

  app.get("/worker/review/batches", async (req, res) => {
    try {
      const result = await listReviewBatches({
        limit: getLimit_(req, 20),
        status: req.query.status
      });

      res.json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/review/batches", error);
    }
  });

  app.post("/worker/review/prepare", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;

    try {
      sendDisabledBatchResponse_(res, await prepareReviewBatch());
    } catch (error) {
      handleRouteError_(res, "/worker/review/prepare", error);
    }
  });

  app.post("/worker/review/submit", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;

    try {
      sendDisabledBatchResponse_(res, await submitPreparedReviewBatch());
    } catch (error) {
      handleRouteError_(res, "/worker/review/submit", error);
    }
  });

  app.post("/worker/review/poll", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;

    try {
      sendDisabledBatchResponse_(res, await pollSubmittedReviewBatch());
    } catch (error) {
      handleRouteError_(res, "/worker/review/poll", error);
    }
  });
}