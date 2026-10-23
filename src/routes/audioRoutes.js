import {
  getAudioDriveStorageSummary,
  storeAudioAssetsInDriveBatch,
  storeOneAudioAssetInDrive
} from "../supabase/audioDriveStorageRepository.js";

function nowIso_() {
  return new Date().toISOString();
}

function getConfiguredAdminSecret_() {
  return String(process.env.WORKER_ADMIN_TEST_SECRET || process.env.WORKER_ADMIN_SECRET || process.env.ADMIN_SECRET || "").trim();
}

function getProvidedAdminSecret_(req) {
  return String(req.get("x-worker-admin-secret") || req.query.secret || req.body?.secret || "").trim();
}

function requireAdminSecret_(req, res) {
  const configured = getConfiguredAdminSecret_();
  if (!configured) return true;
  if (getProvidedAdminSecret_(req) === configured) return true;
  res.status(401).json({ ok: false, status: "UNAUTHORIZED", message: "Admin secret required.", checked_at: nowIso_() });
  return false;
}

function getLimit_(req, fallback = 5, max = 100) {
  const parsed = Number(req.query.limit ?? req.body?.limit ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function handleRouteError_(res, route, error) {
  res.status(500).json({ ok: false, route, error: String(error && error.message ? error.message : error), checked_at: nowIso_() });
}

export function registerAudioRoutes(app) {
  app.get("/worker/audio/storage-summary", async (req, res) => {
    try {
      res.json(await getAudioDriveStorageSummary());
    } catch (error) {
      handleRouteError_(res, "/worker/audio/storage-summary", error);
    }
  });

  app.post("/worker/audio/store-one", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;
    try {
      res.json(await storeOneAudioAssetInDrive({ audioId: req.query.audio_id || req.body?.audio_id }));
    } catch (error) {
      handleRouteError_(res, "/worker/audio/store-one", error);
    }
  });

  app.post("/worker/audio/store-batch", async (req, res) => {
    if (!requireAdminSecret_(req, res)) return;
    try {
      res.json(await storeAudioAssetsInDriveBatch({
        limit: getLimit_(req, 5, 100),
        maxAttempts: req.query.max_attempts || req.body?.max_attempts
      }));
    } catch (error) {
      handleRouteError_(res, "/worker/audio/store-batch", error);
    }
  });
}
