import {
  generateTeacherDigestForOneTeacher,
  generateTeacherDigestsForActiveTeachers,
  getTeacherDigestSummary,
  previewTeacherDigestPayload
} from "../supabase/teacherDigestRepository.js";
import { generateDigestMessages } from "../deepseek/digestClient.js";
import { buildDigestBatch } from "../teacherDigest/deepseekPayload.js";
import { validateDigestBatchResponse } from "../teacherDigest/deepseekValidator.js";

function nowIso_() {
  return new Date().toISOString();
}

function getConfiguredAdminSecret_() {
  return String(process.env.WORKER_ADMIN_SECRET || process.env.ADMIN_SECRET || process.env.WORKER_ADMIN_TEST_SECRET || "").trim();
}

function getProvidedAdminSecret_(req) {
  return String(req.get("x-worker-admin-secret") || req.query.secret || req.body?.secret || "").trim();
}

function requireAdminSecret_(req, res) {
  const configured = getConfiguredAdminSecret_();
  if (!configured) return true;
  if (getProvidedAdminSecret_(req) === configured) return true;
  res.status(401).json({ ok: false, status: "UNAUTHORIZED", checked_at: nowIso_() });
  return false;
}

function requireConfiguredAdminSecret_(req, res) {
  const configured = getConfiguredAdminSecret_();
  if (!configured) {
    res.status(503).json({
      ok: false,
      status: "ADMIN_SECRET_NOT_CONFIGURED",
      message: "Set WORKER_ADMIN_SECRET before using a production teacher-digest route.",
      checked_at: nowIso_()
    });
    return false;
  }
  return requireAdminSecret_(req, res);
}

function getLimit_(req, fallback = 1, max = 100) {
  const raw = req.query.limit ?? req.body?.limit ?? fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function optionsFromRequest_(req, fallbackLimit = 1, maxLimit = 50) {
  return {
    limit: getLimit_(req, fallbackLimit, maxLimit),
    cycleDate: req.query.cycle_date || req.body?.cycle_date,
    force: req.query.force || req.body?.force,
    teacherId: req.query.teacher_id || req.body?.teacher_id,
    teacherEmail: req.query.teacher_email || req.body?.teacher_email,
    studentsPerPdf: req.query.students_per_pdf || req.body?.students_per_pdf,
    testRecipientEmail: req.query.test_recipient_email || req.body?.test_recipient_email,
    testRecipientName: req.query.test_recipient_name || req.body?.test_recipient_name
  };
}

function hasTestRecipient_(req) {
  return Boolean(String(req.query.test_recipient_email || req.body?.test_recipient_email || "").trim());
}

function requireLiveConfirmUnlessTest_(req, res, confirmValue) {
  if (hasTestRecipient_(req)) return true;
  const confirm = String(req.query.confirm || req.body?.confirm || "").trim();
  if (confirm === confirmValue) return true;
  res.status(400).json({
    ok: false,
    status: "CONFIRMATION_REQUIRED",
    message: `Live teacher digest generation requires confirm=${confirmValue}. Test-recipient generation does not require this confirmation.`,
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

export function registerTeacherDigestRoutes(app) {
  app.get("/worker/teacher-digest/summary", async (req, res) => {
    try {
      res.json(await getTeacherDigestSummary(optionsFromRequest_(req)));
    } catch (error) {
      handleRouteError_(res, "/worker/teacher-digest/summary", error);
    }
  });

  const previewHandler = async (req, res) => {
    if (!requireConfiguredAdminSecret_(req, res)) return;

    try {
      res.json(await previewTeacherDigestPayload(optionsFromRequest_(req)));
    } catch (error) {
      handleRouteError_(res, "/worker/teacher-digest/payload-preview", error);
    }
  };
  app.get("/worker/teacher-digest/payload-preview", previewHandler);
  app.post("/worker/teacher-digest/payload-preview", previewHandler);

  app.post("/worker/teacher-digest/test-generation", async (req, res) => {
    if (!requireConfiguredAdminSecret_(req, res)) return;

    let batch;
    try {
      batch = buildDigestBatch(req.body?.batch || req.body || {});
    } catch (error) {
      res.status(400).json({
        ok: false,
        status: "INVALID_TEST_BATCH",
        error: String(error?.message || error),
        checked_at: nowIso_()
      });
      return;
    }

    const forced = req.body?.force === true;
    if (!forced) {
      res.json({
        ok: true,
        status: "DEEPSEEK_TEST_GENERATION_DRY_RUN",
        provider_called: false,
        persisted: false,
        delivery_queued: false,
        batch,
        checked_at: nowIso_()
      });
      return;
    }
    if (String(req.body?.confirm || "").trim() !== "call-deepseek-test-generation") {
      res.status(400).json({
        ok: false,
        status: "CONFIRMATION_REQUIRED",
        message: "Forced test generation requires confirm=call-deepseek-test-generation.",
        checked_at: nowIso_()
      });
      return;
    }

    try {
      const response = await generateDigestMessages({
        batch,
        model: String(req.body?.model || process.env.DEEPSEEK_MODEL || "deepseek-v4-pro").trim()
      });
      const validation = validateDigestBatchResponse({ expectedBatch: batch, response: response.content });
      res.status(validation.ok ? 200 : 422).json({
        ok: validation.ok,
        status: validation.ok ? "DEEPSEEK_TEST_RESPONSE_VALID" : "DEEPSEEK_TEST_RESPONSE_REJECTED",
        provider_called: true,
        persisted: false,
        delivery_queued: false,
        provider: response.provider,
        model: response.model,
        usage: response.usage,
        validation,
        checked_at: nowIso_()
      });
    } catch (error) {
      handleRouteError_(res, "/worker/teacher-digest/test-generation", error);
    }
  });

  app.post("/worker/teacher-digest/generate", async (req, res) => {
    if (!requireConfiguredAdminSecret_(req, res)) return;
    if (!requireLiveConfirmUnlessTest_(req, res, "generate-teacher-digest")) return;

    try {
      const result = await generateTeacherDigestsForActiveTeachers(optionsFromRequest_(req, 50, 500));
      res.status(result.generated_count > 0 ? 201 : 200).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/teacher-digest/generate", error);
    }
  });

  const generateOneHandler = async (req, res) => {
    if (!requireConfiguredAdminSecret_(req, res)) return;
    if (!requireLiveConfirmUnlessTest_(req, res, "generate-teacher-digest")) return;

    try {
      const result = await generateTeacherDigestForOneTeacher(optionsFromRequest_(req, 1, 50));
      res.status(result.pdf_count > 0 ? 201 : 200).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/teacher-digest/generate-one", error);
    }
  };
  app.get("/worker/teacher-digest/generate-one", generateOneHandler);
  app.post("/worker/teacher-digest/generate-one", generateOneHandler);
}
