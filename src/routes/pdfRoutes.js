import { getPdfPayloadSummary, previewPdfPayload } from "../supabase/pdfPayloadRepository.js";
import { generateNextPdfJob, getPdfJobSummary, pollPdfJobs } from "../supabase/pdfJobRepository.js";

function nowIso_() {
  return new Date().toISOString();
}

function getLimit_(req, fallback = 10) {
  const raw = req.query.limit ?? req.body?.limit ?? fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 50);
}

function getSecret_(req) {
  return String(req.query.secret || req.body?.secret || "").trim();
}

function expectedSecret_() {
  return String(
    process.env.WORKER_ADMIN_SECRET ||
    process.env.ADMIN_SECRET ||
    process.env.WORKER_ADMIN_TEST_SECRET ||
    ""
  ).trim();
}

function requireAdmin_(req, res) {
  const expected = expectedSecret_();

  if (!expected) {
    res.status(500).json({
      ok: false,
      status: "ADMIN_SECRET_NOT_CONFIGURED",
      message: "Set WORKER_ADMIN_TEST_SECRET, WORKER_ADMIN_SECRET, or ADMIN_SECRET before running write routes.",
      checked_at: nowIso_()
    });
    return false;
  }

  if (getSecret_(req) !== expected) {
    res.status(403).json({
      ok: false,
      status: "FORBIDDEN",
      message: "Invalid admin secret.",
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

export function registerPdfRoutes(app) {
  app.get("/worker/pdf/payload-summary", async (req, res) => {
    try {
      res.json(await getPdfPayloadSummary());
    } catch (error) {
      handleRouteError_(res, "/worker/pdf/payload-summary", error);
    }
  });

  app.get("/worker/pdf/payload-preview", async (req, res) => {
    try {
      const result = await previewPdfPayload({
        limit: getLimit_(req),
        studentId: req.query.student_id,
        studentEmail: req.query.student_email,
        includeSameDayReady: req.query.include_today || req.body?.include_today
      });
      res.json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/pdf/payload-preview", error);
    }
  });

  app.get("/worker/pdf/jobs", async (req, res) => {
    try {
      res.json(await getPdfJobSummary());
    } catch (error) {
      handleRouteError_(res, "/worker/pdf/jobs", error);
    }
  });

  app.post("/worker/pdf/generate", async (req, res) => {
    if (!requireAdmin_(req, res)) return;

    try {
      const result = await generateNextPdfJob({
        finalFeedbackId: req.query.final_feedback_id || req.body?.final_feedback_id,
        studentId: req.query.student_id || req.body?.student_id,
        studentEmail: req.query.student_email || req.body?.student_email,
        includeSameDayReady: req.query.include_today || req.body?.include_today,
        maxAssignments: req.query.max_assignments || req.body?.max_assignments
      });
      res.status(result.status === "NO_READY_PDF_PAYLOAD" ? 200 : 201).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/pdf/generate", error);
    }
  });

  app.post("/worker/pdf/poll", async (req, res) => {
    if (!requireAdmin_(req, res)) return;

    try {
      const result = await pollPdfJobs({ limit: getLimit_(req, 3) });
      res.json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/pdf/poll", error);
    }
  });
}
