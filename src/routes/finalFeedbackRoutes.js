import { assembleFinalFeedback, previewFinalFeedbackAssembly } from "../supabase/finalFeedbackRepository.js";
import { generateNextPdfJob } from "../supabase/pdfJobRepository.js";

const PROCESS_NEXT_CONFIRMATION = "PROCESS_NEXT_STUDENT_FEEDBACK";

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
    process.env.WORKER_ADMIN_SECRET ||
    process.env.ADMIN_SECRET ||
    process.env.WORKER_ADMIN_TEST_SECRET ||
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

function requireStrictAdminSecret_(req, res) {
  const configured = getConfiguredAdminSecret_();

  if (!configured) {
    res.status(500).json({
      ok: false,
      status: "ADMIN_SECRET_NOT_CONFIGURED",
      message: "Configure WORKER_ADMIN_TEST_SECRET, WORKER_ADMIN_SECRET, or ADMIN_SECRET before using a production worker route.",
      checked_at: nowIso_()
    });
    return false;
  }

  const provided = getProvidedAdminSecret_(req);

  if (provided && provided === configured) {
    return true;
  }

  res.status(401).json({
    ok: false,
    status: "UNAUTHORIZED",
    message: "A valid worker admin secret is required.",
    checked_at: nowIso_()
  });
  return false;
}

function requireProcessNextConfirmation_(req, res) {
  const confirmation = String(req.query.confirm || req.body?.confirm || "").trim();

  if (confirmation === PROCESS_NEXT_CONFIRMATION) {
    return true;
  }

  res.status(400).json({
    ok: false,
    status: "CONFIRMATION_REQUIRED",
    message: `This operation submits the next available student feedback PDF to the normal delivery pipeline. Pass confirm=${PROCESS_NEXT_CONFIRMATION}.`,
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

export function registerFinalFeedbackRoutes(app, dependencies = {}) {
  const assemble = dependencies.assembleFinalFeedback || assembleFinalFeedback;
  const generatePdf = dependencies.generateNextPdfJob || generateNextPdfJob;

  app.get("/worker/final-feedback/preview", async (req, res) => {
    try {
      const result = await previewFinalFeedbackAssembly({
        limit: getLimit_(req)
      });

      res.json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/final-feedback/preview", error);
    }
  });

  app.post("/worker/final-feedback/assemble", async (req, res) => {
    if (!requireStrictAdminSecret_(req, res)) {
      return;
    }

    try {
      const result = await assemble({
        limit: getLimit_(req),
        assembledBy: req.get("x-worker-id") || req.body?.worker_id || "manual-final-feedback-route"
      });

      res.status(result.status === "NO_REVIEWED_DRAFTS" ? 200 : 201).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/final-feedback/assemble", error);
    }
  });

  const processNextStudentFeedback = async (req, res) => {
    if (!requireStrictAdminSecret_(req, res)) return;
    if (!requireProcessNextConfirmation_(req, res)) return;

    try {
      const assembled = await assemble({
        limit: getLimit_(req, 100),
        assembledBy: req.get("x-worker-id") || req.body?.worker_id || "browser-process-next-student-feedback"
      });
      const pdf = await generatePdf({
        includeSameDayReady: true,
        maxAssignments: req.query.max_assignments || req.body?.max_assignments
      });

      if (pdf.status === "NO_READY_PDF_PAYLOAD") {
        res.status(200).json({
          ok: true,
          status: "NO_PENDING_STUDENT_FEEDBACK",
          message: "No student currently has reviewed final feedback ready for PDF generation.",
          assembled_count: assembled.assembled_count || 0,
          processed: null,
          checked_at: nowIso_()
        });
        return;
      }

      res.status(201).json({
        ok: true,
        status: "NEXT_STUDENT_FEEDBACK_PDF_SUBMITTED",
        message: "One student's available feedback was submitted to PDFMonkey. The normal polling, Drive upload, email queue, and Brevo workers will complete delivery.",
        assembled_count: assembled.assembled_count || 0,
        processed: pdf,
        checked_at: nowIso_()
      });
    } catch (error) {
      handleRouteError_(res, "/worker/final-feedback/process-next", error);
    }
  };

  app.get("/worker/final-feedback/process-next", processNextStudentFeedback);
  app.post("/worker/final-feedback/process-next", processNextStudentFeedback);
}
