import { queueStudentFeedbackEmails } from "../supabase/emailQueueRepository.js";
import {
  getEncouragementEmailSummary,
  queueWeeklyEncouragementEmails,
  queueWeeklyStudentEncouragementEmails,
  queueWeeklyTeacherEncouragementEmails
} from "../supabase/encouragementEmailRepository.js";
import {
  getStudentFeedbackEmailQueueSummary,
  sendOneQueuedStudentFeedbackEmail,
  sendQueuedStudentFeedbackEmailBatch
} from "../studentEmailDeliveryWorker.js";

function nowIso_() {
  return new Date().toISOString();
}

function getLimit_(req, fallback = 10, max = 100) {
  const raw = req.query.limit ?? req.body?.limit ?? fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
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
      "This route changes Supabase email queue state. Provide x-worker-admin-secret or ?secret=... matching your configured admin secret.",
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

function sourceTypesFromRequest_(req, fallback = "STUDENT_FEEDBACK_PDF") {
  return req.query.source_types || req.query.source_type || req.body?.source_types || req.body?.source_type || fallback;
}

function encouragementOptionsFromRequest_(req, fallbackLimit = 100) {
  return {
    limit: getLimit_(req, fallbackLimit, 500),
    cycleDate: req.query.cycle_date || req.body?.cycle_date,
    messageId: req.query.message_id || req.body?.message_id,
    messageKey: req.query.message_key || req.body?.message_key,
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
    message: `Live encouragement queueing requires confirm=${confirmValue}. Test-recipient queueing does not require this confirmation.`,
    checked_at: nowIso_()
  });

  return false;
}

export function registerEmailRoutes(app) {
  app.get("/worker/email/queue-summary", async (req, res) => {
    try {
      res.json(await getStudentFeedbackEmailQueueSummary({
        limit: getLimit_(req, 10, 50)
      }));
    } catch (error) {
      handleRouteError_(res, "/worker/email/queue-summary", error);
    }
  });

  app.post("/worker/email/queue-student-feedback", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;

    try {
      const result = await queueStudentFeedbackEmails({
        limit: getLimit_(req, 10, 100),
        studentId: req.query.student_id || req.body?.student_id,
        studentEmail: req.query.student_email || req.body?.student_email,
        pdfJobId: req.query.pdf_job_id || req.body?.pdf_job_id,
        finalFeedbackId: req.query.final_feedback_id || req.body?.final_feedback_id,
        testRecipientEmail: req.query.test_recipient_email || req.body?.test_recipient_email,
        testRecipientName: req.query.test_recipient_name || req.body?.test_recipient_name
      });

      res.status(result.queued_count > 0 ? 201 : 200).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/email/queue-student-feedback", error);
    }
  });

  app.get("/worker/email/encouragement-summary", async (req, res) => {
    try {
      res.json(await getEncouragementEmailSummary({
        limit: getLimit_(req, 20, 100)
      }));
    } catch (error) {
      handleRouteError_(res, "/worker/email/encouragement-summary", error);
    }
  });

  app.post("/worker/email/queue-weekly-student-encouragement", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;
    if (!requireLiveConfirmUnlessTest_(req, res, "queue-weekly-student-encouragement")) return;

    try {
      const result = await queueWeeklyStudentEncouragementEmails(encouragementOptionsFromRequest_(req, 100));
      res.status(result.queued_count > 0 ? 201 : 200).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/email/queue-weekly-student-encouragement", error);
    }
  });

  app.post("/worker/email/queue-weekly-teacher-encouragement", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;
    if (!requireLiveConfirmUnlessTest_(req, res, "queue-weekly-teacher-encouragement")) return;

    try {
      const result = await queueWeeklyTeacherEncouragementEmails(encouragementOptionsFromRequest_(req, 100));
      res.status(result.queued_count > 0 ? 201 : 200).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/email/queue-weekly-teacher-encouragement", error);
    }
  });

  app.post("/worker/email/queue-weekly-encouragement", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;
    if (!requireLiveConfirmUnlessTest_(req, res, "queue-weekly-encouragement")) return;

    try {
      const result = await queueWeeklyEncouragementEmails(encouragementOptionsFromRequest_(req, 100));
      res.status(result.ok === false ? 500 : 201).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/email/queue-weekly-encouragement", error);
    }
  });

  app.post("/worker/email/send-one", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;

    try {
      const result = await sendOneQueuedStudentFeedbackEmail({
        emailId: req.query.email_id || req.body?.email_id,
        sourceTypes: sourceTypesFromRequest_(req),
        workerId: req.get("x-worker-id") || req.body?.worker_id || "manual-email-send-one-route"
      });

      res.status(result.ok === false ? 500 : 200).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/email/send-one", error);
    }
  });

  app.post("/worker/email/send-batch", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;

    try {
      const result = await sendQueuedStudentFeedbackEmailBatch({
        limit: getLimit_(req, 1, 100),
        sourceTypes: sourceTypesFromRequest_(req),
        workerId: req.get("x-worker-id") || req.body?.worker_id || "manual-email-send-batch-route"
      });

      res.status(result.ok === false ? 500 : 200).json(result);
    } catch (error) {
      handleRouteError_(res, "/worker/email/send-batch", error);
    }
  });
}
