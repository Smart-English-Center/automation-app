import express from "express";
import { startInternalScheduler } from "./scheduler.js";
import { getEnvironmentStatus } from "./config.js";
import { getBuildInfo } from "./buildInfo.js";
import { getSupabaseDiagnosticReport, getSupabaseHealth } from "./supabase/diagnostics.js";
import { registerReviewRoutes } from "./routes/reviewRoutes.js";
import { registerFinalFeedbackRoutes } from "./routes/finalFeedbackRoutes.js";
import { registerPdfRoutes } from "./routes/pdfRoutes.js";
import { registerEmailRoutes } from "./routes/emailRoutes.js";
import { registerTeacherDigestRoutes } from "./routes/teacherDigestRoutes.js";
import { registerDataImportRoutes } from "./routes/dataImportRoutes.js";
import { registerAudioRoutes } from "./routes/audioRoutes.js";
import { registerCorrectionRoutes } from "./routes/correctionRoutes.js";
import { registerRegistrationRoutes } from "./routes/registrationRoutes.js";
import { registerAdminPaymentControlRoutes } from "./routes/adminPaymentControlRoutes.js";
import { registerSpeakingProfileRoutes } from "./routes/speakingProfileRoutes.js";
import { registerSpeakingRoutes } from "./routes/speakingRoutes.js";
import { registerSpeakingLinkRemediationRoutes } from "./routes/speakingLinkRemediationRoutes.js";
import { registerSpeakingTopicResponseRoutes } from "./routes/speakingTopicResponseRoutes.js";

const app = express();

app.use(express.json({
  limit: "25mb",
  verify: (req, res, buffer) => {
    req.rawBody = buffer.toString("utf8");
  }
}));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

function nowIso_() {
  return new Date().toISOString();
}

function notMigrated_(routeName) {
  return (req, res) => {
    res.status(501).json({
      ok: false,
      status: "NOT_MIGRATED",
      route: routeName || req.path,
      method: req.method,
      message:
        "This route has not been connected to the Supabase worker system yet. The server is running in the new Supabase-native shell.",
      next_step:
        "Implement this route against the Supabase repositories before using it in production.",
      checked_at: nowIso_()
    });
  };
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "jea-master-platform",
    mode: "supabase-native",
    message: "JEA Master Supabase-native worker server is running.",
    routes: {
      health: "/health",
      version: "/version",
      config: "/config-check",
      supabase: "/diagnostics/supabase"
    },
    checked_at: nowIso_()
  });
});

app.get(["/health", "/live"], (req, res) => {
  res.status(200).json({
    ok: true,
    service: "jea-master-platform",
    mode: "supabase-native",
    health_type: "liveness",
    message: "HTTP server is alive. This endpoint does not check external dependencies so platform health checks do not restart active workers during transient database/API failures.",
    checked_at: nowIso_()
  });
});

app.get(["/version", "/worker/version"], (req, res) => {
  res.status(200).json({
    ok: true,
    ...getBuildInfo(),
    checked_at: nowIso_()
  });
});

app.get(["/ready", "/health/db"], async (req, res) => {
  try {
    const supabase = await getSupabaseHealth();

    res.status(supabase.ok ? 200 : 503).json({
      ok: supabase.ok,
      service: "jea-master-platform",
      mode: "supabase-native",
      health_type: "readiness",
      supabase,
      checked_at: nowIso_()
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      service: "jea-master-platform",
      mode: "supabase-native",
      health_type: "readiness",
      error: String(error && error.message ? error.message : error),
      checked_at: nowIso_()
    });
  }
});

app.get(["/config-check", "/worker/config-check"], (req, res) => {
  res.json({
    ok: true,
    mode: "supabase-native",
    environment: getEnvironmentStatus(),
    checked_at: nowIso_()
  });
});

app.get("/diagnostics/supabase", async (req, res) => {
  try {
    const report = await getSupabaseDiagnosticReport();
    res.status(report.ok ? 200 : 500).json(report);
  } catch (error) {
    res.status(500).json({
      ok: false,
      diagnostic: "supabase",
      error: String(error && error.message ? error.message : error),
      checked_at: nowIso_()
    });
  }
});

registerReviewRoutes(app);
registerFinalFeedbackRoutes(app);
registerPdfRoutes(app);
registerEmailRoutes(app);
registerTeacherDigestRoutes(app);
registerDataImportRoutes(app);
registerAudioRoutes(app);
registerCorrectionRoutes(app);
registerRegistrationRoutes(app);
registerAdminPaymentControlRoutes(app);
registerSpeakingProfileRoutes(app);
registerSpeakingRoutes(app);
registerSpeakingLinkRemediationRoutes(app);
registerSpeakingTopicResponseRoutes(app);

const plannedWorkerRoutes = [
  "/worker/run-once",
  "/worker/run-batch"
];

for (const route of plannedWorkerRoutes) {
  app.all(route, notMigrated_(route));
}

app.all(/^\/worker\/.*/, notMigrated_());
app.all(/^\/diagnostics\/.*/, notMigrated_());

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    status: "NOT_FOUND",
    path: req.path,
    method: req.method,
    checked_at: nowIso_()
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  return res.status(500).json({
    ok: false,
    status: "SERVER_ERROR",
    message: String(error && error.message ? error.message : error),
    checked_at: nowIso_()
  });
});

process.on("unhandledRejection", (reason) => {
  console.error(JSON.stringify({
    ok: false,
    process_event: "unhandledRejection",
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
    at: nowIso_()
  }));
});

process.on("uncaughtException", (error) => {
  console.error(JSON.stringify({
    ok: false,
    process_event: "uncaughtException",
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    at: nowIso_()
  }));

  process.exit(1);
});

process.on("SIGTERM", () => {
  console.log(JSON.stringify({
    ok: true,
    process_event: "SIGTERM",
    message: "Process received SIGTERM. Platform is stopping or restarting the container.",
    at: nowIso_()
  }));
});

process.on("SIGINT", () => {
  console.log(JSON.stringify({
    ok: true,
    process_event: "SIGINT",
    message: "Process received SIGINT.",
    at: nowIso_()
  }));
});

app.listen(PORT, HOST, () => {
  console.log(`JEA Master Supabase-native server listening on ${HOST}:${PORT}`);

  try {
    startInternalScheduler();
  } catch (error) {
    console.error(JSON.stringify({
      ok: false,
      process_event: "scheduler_start_failed",
      message: "HTTP server is still running, but the internal scheduler failed to start.",
      error: String(error && error.message ? error.message : error),
      stack: error instanceof Error ? error.stack : undefined,
      at: nowIso_()
    }));
  }
});
