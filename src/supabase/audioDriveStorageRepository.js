import {
  findGoogleDriveFileByAppProperty,
  updateGoogleDriveFileAppProperties,
  uploadBufferToGoogleDrive
} from "../google/driveClient.js";
import {
  AudioProcessingError,
  classifyAudioSourceUrl,
  downloadOriginalAudioForProcessing
} from "../utils/audioProcessing.js";
import { classifySpeakPipeLink } from "../submissionPolicy.js";
import { withSupabaseClient } from "./client.js";
import {
  lockSpeakingAudioLinkRegistry,
  speakingAudioSourceHash,
  storeSpeakingAudioLinkDriveReference
} from "./speakingAudioLinkRepository.js";

const DRIVE_AUDIO_SOURCE_HASH_PROPERTY = "jea_audio_source_sha256";

function nowIso_() {
  return new Date().toISOString();
}

function clean_(value) {
  return String(value ?? "").trim();
}

function canUseGoogleDriveMarkerApi_() {
  return Boolean(
    clean_(process.env.GOOGLE_CLIENT_ID)
    && clean_(process.env.GOOGLE_CLIENT_SECRET)
    && clean_(process.env.GOOGLE_REFRESH_TOKEN)
  );
}

function quoteIdent_(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function normaliseLimit_(value, fallback = 5, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function normalisePositiveInteger_(value, fallback, max = 10000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function getMaxAttempts_(options = {}) {
  return normalisePositiveInteger_(
    options.maxAttempts || options.max_attempts || process.env.AUDIO_STORAGE_MAX_ATTEMPTS,
    5,
    50
  );
}

function getRetryMinutes_(options = {}) {
  return normalisePositiveInteger_(
    options.retryMinutes || options.retry_minutes || process.env.AUDIO_STORAGE_RETRY_MINUTES,
    30,
    1440
  );
}

function getStaleMinutes_(options = {}) {
  return normalisePositiveInteger_(
    options.staleMinutes || options.stale_minutes || process.env.AUDIO_STORAGE_STALE_MINUTES,
    30,
    1440
  );
}

function classifyStorageSource_(sourceUrl) {
  const sourceType = classifyAudioSourceUrl(sourceUrl);
  const url = clean_(sourceUrl);
  const linkInfo = classifySpeakPipeLink(url);
  const effectiveSourceType = linkInfo.valid ? "speakpipe" : sourceType;

  if (!url) {
    return {
      ok: false,
      source_type: effectiveSourceType,
      code: "MISSING_AUDIO_LINK",
      message: "The speaking task could not be assessed because no audio link was submitted."
    };
  }

  if (effectiveSourceType === "google_drive" || effectiveSourceType === "google_drive_file_id") {
    return {
      ok: false,
      source_type: effectiveSourceType,
      code: "GOOGLE_DRIVE_AUDIO_NOT_ACCEPTED",
      message: "The speaking task could not be assessed because Google Drive audio links are not accepted for speaking assessment. Please submit a valid SpeakPipe message link."
    };
  }

  if (effectiveSourceType !== "speakpipe") {
    return {
      ok: false,
      source_type: effectiveSourceType,
      code: "UNSUPPORTED_AUDIO_SOURCE",
      message: "The speaking task could not be assessed because the submitted audio link was not a valid SpeakPipe message link."
    };
  }

  if (linkInfo.issue_code === "BAD_SPEAKPIPE_INCOMPLETE_LINK") {
    return {
      ok: false,
      source_type: effectiveSourceType,
      code: "INCOMPLETE_SPEAKPIPE_LINK",
      message: "The speaking task could not be assessed because the submitted SpeakPipe audio link was incomplete."
    };
  }

  if (!linkInfo.valid) {
    return {
      ok: false,
      source_type: effectiveSourceType,
      code: "INVALID_SPEAKPIPE_MESSAGE_LINK",
      message: "The speaking task could not be assessed because the submitted SpeakPipe link was not a valid message link."
    };
  }

  return {
    ok: true,
    source_type: effectiveSourceType,
    code: "VALID_SPEAKPIPE_MESSAGE_LINK",
    message: "",
    normalized_url: linkInfo.normalized_url
  };
}

function errorPayload_(error) {
  const details = error instanceof AudioProcessingError ? error.details || {} : {};
  return {
    code: details.code || error?.code || "AUDIO_STORAGE_ERROR",
    message: error instanceof Error ? error.message : String(error),
    details
  };
}

function appendNote_(current, note) {
  return [clean_(current), clean_(note)].filter(Boolean).join("\n");
}


function shouldUseAppsScriptAudioDownloader_() {
  return clean_(process.env.AUDIO_DOWNLOAD_PROVIDER).toUpperCase() === "APPS_SCRIPT";
}

async function storeSpeakPipeAudioWithAppsScript_(meta, sourceUrl) {
  const url = clean_(process.env.APPS_SCRIPT_AUDIO_DOWNLOADER_URL);
  const secret = clean_(process.env.APPS_SCRIPT_AUDIO_DOWNLOADER_SECRET);

  if (!url) {
    throw new AudioProcessingError("Apps Script audio downloader URL is not configured.", {
      code: "APPS_SCRIPT_AUDIO_DOWNLOADER_URL_MISSING"
    });
  }

  if (!secret) {
    throw new AudioProcessingError("Apps Script audio downloader secret is not configured.", {
      code: "APPS_SCRIPT_AUDIO_DOWNLOADER_SECRET_MISSING"
    });
  }

  const filename = buildAudioFilename_(meta.row, {
    original_mime_type: "audio/mpeg",
    original_extension: "mp3"
  });

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        secret,
        source_url: sourceUrl,
        filename,
        audio_id: meta.row[meta.idColumn],
        submission_id: meta.row.submission_id
      })
    });
  } catch (error) {
    throw new AudioProcessingError("Apps Script audio downloader request failed.", {
      code: "APPS_SCRIPT_AUDIO_DOWNLOADER_REQUEST_FAILED",
      error_name: String(error?.name || ""),
      error_message: String(error?.message || error)
    });
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text || "{}");
  } catch (error) {
    throw new AudioProcessingError("Apps Script audio downloader returned invalid JSON.", {
      code: "APPS_SCRIPT_AUDIO_DOWNLOADER_INVALID_JSON",
      http_status: response.status,
      response_preview: text.slice(0, 1000),
      error_message: String(error?.message || error)
    });
  }

  if (!response.ok || !payload.ok) {
    throw new AudioProcessingError(payload.error || "Apps Script audio downloader failed.", {
      code: payload.status || "APPS_SCRIPT_AUDIO_DOWNLOADER_FAILED",
      http_status: response.status,
      apps_script_response: payload
    });
  }

  if (!clean_(payload.drive_file_id)) {
    throw new AudioProcessingError("Apps Script audio downloader did not return drive_file_id.", {
      code: "APPS_SCRIPT_AUDIO_DOWNLOADER_MISSING_DRIVE_FILE_ID",
      apps_script_response: payload
    });
  }

  return {
    drive_file_id: clean_(payload.drive_file_id),
    drive_url: clean_(payload.drive_url),
    resolved_download_url: clean_(payload.resolved_download_url),
    mime_type: clean_(payload.mime_type) || "audio/mpeg",
    file_size_bytes: Number(payload.file_size_bytes || 0),
    filename: clean_(payload.filename)
  };
}

async function tableExists_(client, tableName) {
  const result = await client.query(
    `select 1 from information_schema.tables where table_schema = 'public' and table_name = $1 limit 1`,
    [tableName]
  );
  return result.rowCount > 0;
}

async function getTableColumns_(client, tableName) {
  const result = await client.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
    [tableName]
  );
  return new Set(result.rows.map((row) => row.column_name));
}

function pickColumn_(columns, candidates) {
  return candidates.find((candidate) => columns.has(candidate)) || "";
}

function safeFilenamePart_(value, fallback = "audio") {
  return clean_(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
}


function twoNameSlug_(fullName, fallback = "student") {
  const clean = clean_(fullName)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

  const parts = clean
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 2);

  return parts.join("_") || fallback;
}

function lessonSlug_(row) {
  const level = safeFilenamePart_(row.level || row.level_snapshot || "level", "level").toUpperCase();
  const moduleNo = safeFilenamePart_(row.module || "", "").replace(/^M/i, "");
  const unitNo = safeFilenamePart_(row.unit || "", "").replace(/^U/i, "");
  const dayNo = safeFilenamePart_(row.day || "", "").replace(/^D/i, "");
  const parts = [level];
  if (moduleNo) parts.push(`M${moduleNo}`);
  if (unitNo) parts.push(`U${unitNo}`);
  if (dayNo) parts.push(`D${dayNo}`);
  return parts.join("_");
}

function extensionFromMime_(mimeType, fallback = "audio") {
  const mime = clean_(mimeType).toLowerCase();
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  return fallback;
}

async function loadReadyAudioAssets_(client, options = {}) {
  if (!(await tableExists_(client, "audio_assets"))) return [];
  const columns = await getTableColumns_(client, "audio_assets");
  const idColumn = pickColumn_(columns, ["id", "audio_id"]);
  const sourceColumn = pickColumn_(columns, ["source_url", "audio_link", "original_audio_url"]);
  const driveColumn = pickColumn_(columns, ["stored_drive_file_id", "drive_file_id"]);
  const statusColumn = pickColumn_(columns, ["status", "storage_status"]);
  const attemptsColumn = pickColumn_(columns, ["storage_attempt_count", "attempt_count"]);
  const nextRetryColumn = pickColumn_(columns, ["next_storage_retry_at"]);
  const updatedAtColumn = pickColumn_(columns, ["updated_at"]);
  const createdAtColumn = pickColumn_(columns, ["created_at"]);

  if (!idColumn || !sourceColumn) return [];

  const qaa = (column) => `aa.${quoteIdent_(column)}`;
  const filters = [`nullif(trim(${qaa(sourceColumn)}::text), '') is not null`];
  const params = [];

  if (driveColumn) filters.push(`nullif(trim(coalesce(${qaa(driveColumn)}::text, '')), '') is null`);

  if (statusColumn) {
    const readyStatuses = ["READY_FOR_STORAGE", "STORAGE_FAILED_RETRYABLE", "FAILED_RETRYABLE"];
    if (updatedAtColumn || createdAtColumn) {
      params.push(`${getStaleMinutes_(options)} minutes`);
      const updatedExpr = updatedAtColumn ? qaa(updatedAtColumn) : "null";
      const createdExpr = createdAtColumn ? qaa(createdAtColumn) : "null";
      filters.push(`(
        coalesce(upper(trim(${qaa(statusColumn)}::text)), 'READY_FOR_STORAGE') = any(array[${readyStatuses.map((status) => `'${status}'`).join(",")}])
        or (
          coalesce(upper(trim(${qaa(statusColumn)}::text)), '') = 'STORAGE_IN_PROGRESS'
          and coalesce(${updatedExpr}, ${createdExpr}, now()) < now() - $${params.length}::interval
        )
      )`);
    } else {
      filters.push(`coalesce(upper(trim(${qaa(statusColumn)}::text)), 'READY_FOR_STORAGE') = any(array[${readyStatuses.map((status) => `'${status}'`).join(",")}])`);
    }
  }

  if (nextRetryColumn) filters.push(`(${qaa(nextRetryColumn)} is null or ${qaa(nextRetryColumn)} <= now())`);
  if (attemptsColumn) {
    params.push(getMaxAttempts_(options));
    filters.push(`coalesce(${qaa(attemptsColumn)}, 0) < $${params.length}`);
  }

  if (options.audioId || options.audio_id) {
    params.push(clean_(options.audioId || options.audio_id));
    filters.push(`${qaa(idColumn)}::text = $${params.length}`);
  }

  params.push(normaliseLimit_(options.limit, 5, 100));

  const result = await client.query(
    `select
       aa.*,
       s.full_name as student_name,
       si.level,
       si.module,
       si.unit,
       si.day
     from audio_assets aa
     left join students s on s.id = aa.student_id
     left join submission_inbox si on si.id = aa.submission_id
     where ${filters.join(" and ")}
     order by aa.created_at nulls last, ${qaa(idColumn)} limit $${params.length}
     for update of aa skip locked`,
    params
  );

  return result.rows.map((row) => ({ row, columns, idColumn, sourceColumn, statusColumn, driveColumn, attemptsColumn }));
}

async function updateAudioAsset_(client, meta, updates) {
  const cleanUpdates = {};
  for (const [key, value] of Object.entries(updates)) {
    if (meta.columns.has(key)) cleanUpdates[key] = value;
  }
  if (!Object.keys(cleanUpdates).length) return null;
  const keys = Object.keys(cleanUpdates);
  const setSql = keys.map((key, index) => `${quoteIdent_(key)} = $${index + 2}`).join(", ");
  const result = await client.query(
    `update audio_assets set ${setSql} where ${quoteIdent_(meta.idColumn)} = $1 returning *`,
    [meta.row[meta.idColumn], ...keys.map((key) => cleanUpdates[key])]
  );
  return result.rows[0] || null;
}

async function findReusableStoredAudioAsset_(client, meta, sourceUrl) {
  if (!meta?.driveColumn || !meta?.sourceColumn || !sourceUrl) return null;

  const qaa = (column) => `aa.${quoteIdent_(column)}`;
  const params = [meta.row[meta.idColumn], sourceUrl];
  const filters = [
    `${qaa(meta.idColumn)} <> $1`,
    `nullif(trim(${qaa(meta.sourceColumn)}::text), '') = $2`,
    `nullif(trim(coalesce(${qaa(meta.driveColumn)}::text, '')), '') is not null`
  ];
  const orderParts = [];

  if (meta.columns.has("student_id")) {
    params.push(meta.row.student_id || null);
    orderParts.push(`case when aa.student_id is not distinct from $${params.length} then 0 else 1 end`);
  }

  if (meta.columns.has("task_id")) {
    params.push(meta.row.task_id || null);
    orderParts.push(`case when aa.task_id is not distinct from $${params.length} then 0 else 1 end`);
  }

  const updatedOrder = meta.columns.has("updated_at") ? "aa.updated_at desc nulls last," : "";
  const createdOrder = meta.columns.has("created_at") ? "aa.created_at desc nulls last," : "";
  const orderSql = [...orderParts, `${updatedOrder} ${createdOrder} ${qaa(meta.idColumn)}`]
    .filter(Boolean)
    .join(", ");

  const result = await client.query(
    `select aa.*
       from audio_assets aa
      where ${filters.join(" and ")}
      order by ${orderSql}
      limit 1`,
    params
  );

  return result.rows[0] || null;
}

async function reuseStoredAudioAsset_(meta, reusable, sourceUrl, existingClient = null) {
  if (!reusable) return null;

  const reuse = async (client) => {
    const updated = await updateAudioAsset_(client, meta, {
      resolved_download_url: reusable.resolved_download_url || "",
      stored_drive_file_id: reusable.stored_drive_file_id || reusable.drive_file_id || "",
      stored_drive_url: reusable.stored_drive_url || reusable.drive_url || "",
      mime_type: reusable.mime_type || "",
      file_size_bytes: reusable.file_size_bytes || null,
      status: "STORED",
      storage_attempt_count: Number(meta.row.storage_attempt_count || 0),
      last_error_code: "",
      last_error_message: "",
      next_storage_retry_at: null,
      updated_at: nowIso_(),
      notes: appendNote_(
        meta.row.notes,
        `Reused stored audio from audio_assets ${reusable[meta.idColumn] || reusable.id || "unknown"} on ${nowIso_()} instead of downloading duplicate source_url.`
      )
    });

    return {
      ok: true,
      status: "AUDIO_ASSET_STORED_IN_DRIVE",
      storage_provider: "REUSED_EXISTING_AUDIO_ASSET",
      audio_id: meta.row[meta.idColumn],
      submission_id: meta.row.submission_id,
      source_url: sourceUrl,
      reused_from_audio_id: reusable[meta.idColumn] || reusable.id || null,
      resolved_download_url: reusable.resolved_download_url || "",
      drive: {
        drive_file_id: reusable.stored_drive_file_id || reusable.drive_file_id || "",
        drive_url: reusable.stored_drive_url || reusable.drive_url || "",
        mime_type: reusable.mime_type || "",
        size_bytes: reusable.file_size_bytes || 0,
        filename: ""
      },
      updated,
      checked_at: nowIso_()
    };
  };

  return existingClient ? reuse(existingClient) : withSupabaseClient(reuse);
}

async function markSpeakingDraftNotAssessed_(client, submissionId, reason, model = "audio-storage-handler") {
  if (!submissionId || !(await tableExists_(client, "ai_drafts"))) return [];
  const result = await client.query(
    `update ai_drafts
        set status = 'NOT_ASSESSED',
            review_status = 'PARTIAL_FEEDBACK',
            score = null,
            reviewed_score = null,
            student_draft_feedback = null,
            reviewed_student_feedback = '',
            review_note = $2,
            reviewed_at = coalesce(reviewed_at, now()),
            review_provider = coalesce(review_provider, 'system'),
            review_model = coalesce(review_model, $3),
            updated_at = now()
      where submission_id = $1
        and job_type in ('SPEAKING_EVALUATION', 'SPEAKING_CORRECTION')
        and status not in ('COMPLETED', 'NOT_ASSESSED')
        and coalesce(review_status, 'NOT_READY') not in ('PARTIAL_FEEDBACK', 'BAD_SUBMISSION', 'FIXED', 'APPROVED', 'REGENERATED')
      returning id, submission_id, job_type, status, review_status, review_note`,
    [submissionId, reason, model]
  );
  return result.rows;
}

async function markAudioNotAssessed_(meta, reason, code = "AUDIO_NOT_ASSESSED", options = {}) {
  const finalStorageFailure = Boolean(options.finalStorageFailure);
  const attemptCount = Number(options.attemptCount || 0);
  const underlyingCode = clean_(options.underlyingCode || "");
  const finalMessage = underlyingCode && underlyingCode !== code
    ? `${reason} Underlying storage error code: ${underlyingCode}.`
    : reason;

  return withSupabaseClient(async (client) => {
    const updates = {
      status: "NOT_ASSESSED",
      last_error_code: code,
      last_error_message: finalMessage,
      next_storage_retry_at: null,
      updated_at: nowIso_(),
      notes: appendNote_(meta.row.notes, `Marked NOT_ASSESSED on ${nowIso_()}: ${finalMessage}`)
    };

    if (attemptCount > 0) {
      updates.storage_attempt_count = attemptCount;
    }

    if (finalStorageFailure) {
      updates.storage_failed_final_at = nowIso_();
    }

    const updated = await updateAudioAsset_(client, meta, updates);
    const drafts = await markSpeakingDraftNotAssessed_(client, meta.row.submission_id, finalMessage, "audio-not-assessed-handler");
    return { updated, drafts };
  });
}

async function recordStorageFailure_(meta, error, options = {}) {
  const payload = errorPayload_(error);
  const attemptCount = Number(meta.row.storage_attempt_count || 0) + 1;
  const maxAttempts = getMaxAttempts_(options);
  const retryMinutes = getRetryMinutes_(options);
  const finalFailure = attemptCount >= maxAttempts;

  if (finalFailure) {
    const reason = `The speaking task could not be assessed because the audio could not be downloaded after ${attemptCount} storage attempt(s). Last error: ${payload.message}`;
    const result = await markAudioNotAssessed_(meta, reason, "AUDIO_STORAGE_FAILED_FINAL", {
      finalStorageFailure: true,
      attemptCount,
      underlyingCode: payload.code || ""
    });
    return {
      ok: false,
      status: "AUDIO_ASSET_NOT_ASSESSED_AFTER_STORAGE_FAILURES",
      audio_id: meta.row[meta.idColumn],
      submission_id: meta.row.submission_id,
      source_url: meta.row[meta.sourceColumn],
      error_code: payload.code,
      error: payload.message,
      error_details: payload.details,
      attempt_count: attemptCount,
      max_attempts: maxAttempts,
      updated: result.updated,
      speaking_drafts: result.drafts,
      checked_at: nowIso_()
    };
  }

  return withSupabaseClient(async (client) => {
    const updated = await updateAudioAsset_(client, meta, {
      status: "STORAGE_FAILED_RETRYABLE",
      storage_attempt_count: attemptCount,
      next_storage_retry_at: new Date(Date.now() + retryMinutes * 60 * 1000).toISOString(),
      last_error_code: payload.code,
      last_error_message: payload.message,
      updated_at: nowIso_(),
      notes: appendNote_(meta.row.notes, `Storage attempt ${attemptCount}/${maxAttempts} failed on ${nowIso_()}: ${payload.code} - ${payload.message}`)
    });

    return {
      ok: false,
      status: "AUDIO_ASSET_STORAGE_FAILED_RETRYABLE",
      audio_id: meta.row[meta.idColumn],
      submission_id: meta.row.submission_id,
      source_url: meta.row[meta.sourceColumn],
      error_code: payload.code,
      error: payload.message,
      error_details: payload.details,
      attempt_count: attemptCount,
      max_attempts: maxAttempts,
      next_storage_retry_at: updated?.next_storage_retry_at || null,
      updated,
      checked_at: nowIso_()
    };
  });
}

function buildAudioFilename_(asset, downloaded) {
  const student = twoNameSlug_(asset.student_name || asset.student_name_snapshot || asset.student_id || "student", "student");
  const lesson = lessonSlug_(asset);
  const ext = extensionFromMime_(downloaded.original_mime_type, downloaded.original_extension || "audio");
  return `${student}_${lesson}.${ext}`;
}

export async function getAudioDriveStorageSummary() {
  return withSupabaseClient(async (client) => {
    if (!(await tableExists_(client, "audio_assets"))) {
      return { ok: false, status: "AUDIO_ASSETS_TABLE_MISSING", checked_at: nowIso_() };
    }
    const result = await client.query(
      `select coalesce(status, 'UNKNOWN') as status, count(*)::integer as row_count from audio_assets group by coalesce(status, 'UNKNOWN') order by status`
    );
    return {
      ok: true,
      status: "AUDIO_DRIVE_STORAGE_SUMMARY",
      folder_configured: Boolean(clean_(process.env.GOOGLE_AUDIO_STORAGE_FOLDER_ID || process.env.GOOGLE_DRIVE_AUDIO_FOLDER_ID)),
      counts: result.rows,
      checked_at: nowIso_()
    };
  });
}

export async function storeOneAudioAssetInDrive(options = {}) {
  const withClient = options.dependencies?.withSupabaseClient || withSupabaseClient;
  let meta = null;

  await withClient(async (client) => {
    await client.query("begin");
    try {
      const [claimed] = await loadReadyAudioAssets_(client, { ...options, limit: 1 });
      if (!claimed) {
        await client.query("commit");
        return;
      }

      meta = claimed;
      await updateAudioAsset_(client, meta, {
        status: "STORAGE_IN_PROGRESS",
        storage_attempt_count: Number(meta.row.storage_attempt_count || 0) + 1,
        last_error_code: "",
        last_error_message: "",
        updated_at: nowIso_()
      });

      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });

  if (!meta) {
    return { ok: true, status: "NO_AUDIO_ASSET_READY_FOR_STORAGE", stored: null, checked_at: nowIso_() };
  }

  const submittedSourceUrl = clean_(meta.row[meta.sourceColumn]);
  const source = classifyStorageSource_(submittedSourceUrl);
  const sourceUrl = source.normalized_url || submittedSourceUrl;

  if (!source.ok) {
    const notAssessed = await markAudioNotAssessed_(meta, source.message, source.code);
    return {
      ok: true,
      status: "AUDIO_ASSET_MARKED_NOT_ASSESSED",
      audio_id: meta.row[meta.idColumn],
      submission_id: meta.row.submission_id,
      source_url: sourceUrl,
      source_type: source.source_type,
      reason_code: source.code,
      reason: source.message,
      updated: notAssessed.updated,
      speaking_drafts: notAssessed.drafts,
      checked_at: nowIso_()
    };
  }

  try {
    return await withClient(async (sourceClient) => {
      await sourceClient.query("begin");
      try {
        const registry = await lockSpeakingAudioLinkRegistry(sourceClient, sourceUrl);
        if (!registry) {
          throw new Error(`SPEAKING_AUDIO_LINK_REGISTRY_MISSING: No assignment-level registry row exists for ${sourceUrl}.`);
        }

        let reusableStoredAudio = null;
        if (clean_(registry.stored_drive_file_id)) {
          reusableStoredAudio = registry;
        } else {
          reusableStoredAudio = await findReusableStoredAudioAsset_(sourceClient, meta, sourceUrl);
        }

        const sourceHash = speakingAudioSourceHash(sourceUrl);
        const folderId = process.env.GOOGLE_AUDIO_STORAGE_FOLDER_ID || process.env.GOOGLE_DRIVE_AUDIO_FOLDER_ID || "";
        if (!reusableStoredAudio && (!shouldUseAppsScriptAudioDownloader_() || canUseGoogleDriveMarkerApi_())) {
          const markedDriveFile = await findGoogleDriveFileByAppProperty(
            DRIVE_AUDIO_SOURCE_HASH_PROPERTY,
            sourceHash,
            { folderId }
          );
          if (markedDriveFile) {
            reusableStoredAudio = {
              stored_drive_file_id: markedDriveFile.drive_file_id,
              stored_drive_url: markedDriveFile.drive_url,
              resolved_download_url: "",
              mime_type: markedDriveFile.mime_type,
              file_size_bytes: markedDriveFile.size_bytes
            };
          }
        }

        if (reusableStoredAudio) {
          const reused = await reuseStoredAudioAsset_(meta, reusableStoredAudio, sourceUrl, sourceClient);
          await storeSpeakingAudioLinkDriveReference(sourceClient, sourceUrl, {
            drive_file_id: reusableStoredAudio.stored_drive_file_id || reusableStoredAudio.drive_file_id,
            drive_url: reusableStoredAudio.stored_drive_url || reusableStoredAudio.drive_url,
            resolved_download_url: reusableStoredAudio.resolved_download_url || "",
            mime_type: reusableStoredAudio.mime_type || "",
            size_bytes: reusableStoredAudio.file_size_bytes || reusableStoredAudio.size_bytes || 0
          });
          await sourceClient.query("commit");
          return reused;
        }

        if (shouldUseAppsScriptAudioDownloader_()) {
          const appsScriptResult = await storeSpeakPipeAudioWithAppsScript_(meta, sourceUrl);
          const updated = await updateAudioAsset_(sourceClient, meta, {
            resolved_download_url: appsScriptResult.resolved_download_url || "",
            stored_drive_file_id: appsScriptResult.drive_file_id,
            stored_drive_url: appsScriptResult.drive_url,
            mime_type: appsScriptResult.mime_type,
            file_size_bytes: appsScriptResult.file_size_bytes || null,
            status: "STORED",
            last_error_code: "",
            last_error_message: "",
            next_storage_retry_at: null,
            updated_at: nowIso_(),
            notes: appendNote_(meta.row.notes, `Stored audio in Google Drive via Apps Script on ${nowIso_()}.`)
          });
          await storeSpeakingAudioLinkDriveReference(sourceClient, sourceUrl, {
            drive_file_id: appsScriptResult.drive_file_id,
            drive_url: appsScriptResult.drive_url,
            resolved_download_url: appsScriptResult.resolved_download_url || "",
            mime_type: appsScriptResult.mime_type,
            size_bytes: appsScriptResult.file_size_bytes || 0
          });
          await sourceClient.query("commit");
          let markerWarning = "";
          if (canUseGoogleDriveMarkerApi_()) {
            try {
              await updateGoogleDriveFileAppProperties(
                appsScriptResult.drive_file_id,
                { [DRIVE_AUDIO_SOURCE_HASH_PROPERTY]: sourceHash }
              );
            } catch (markerError) {
              markerWarning = `Drive source marker could not be attached: ${String(markerError?.message || markerError)}`;
            }
          }
          return {
            ok: true,
            status: "AUDIO_ASSET_STORED_IN_DRIVE",
            storage_provider: "APPS_SCRIPT",
            audio_id: meta.row[meta.idColumn],
            submission_id: meta.row.submission_id,
            source_url: sourceUrl,
            resolved_download_url: appsScriptResult.resolved_download_url || "",
            drive: {
              drive_file_id: appsScriptResult.drive_file_id,
              drive_url: appsScriptResult.drive_url,
              mime_type: appsScriptResult.mime_type,
              size_bytes: appsScriptResult.file_size_bytes || 0,
              filename: appsScriptResult.filename || ""
            },
            source_marker_warning: markerWarning,
            updated,
            checked_at: nowIso_()
          };
        }

        const downloaded = await downloadOriginalAudioForProcessing({
          sourceUrl,
          studentName: meta.row.student_name || meta.row.student_id || "",
          lessonKey: lessonSlug_(meta.row),
          referenceName: meta.row[meta.idColumn] || ""
        });

        const drive = await uploadBufferToGoogleDrive(downloaded.original_buffer, {
          folderId,
          filename: buildAudioFilename_(meta.row, downloaded),
          mimeType: downloaded.original_mime_type || "application/octet-stream",
          appProperties: { [DRIVE_AUDIO_SOURCE_HASH_PROPERTY]: sourceHash }
        });

        const updated = await updateAudioAsset_(sourceClient, meta, {
          resolved_download_url: downloaded.resolved_download_url || downloaded.final_download_url || "",
          stored_drive_file_id: drive.drive_file_id,
          stored_drive_url: drive.drive_url,
          mime_type: downloaded.original_mime_type || drive.mime_type,
          file_size_bytes: downloaded.original_size_bytes || drive.size_bytes,
          status: "STORED",
          last_error_code: "",
          last_error_message: "",
          next_storage_retry_at: null,
          updated_at: nowIso_(),
          notes: appendNote_(meta.row.notes, `Stored audio in Google Drive on ${nowIso_()}.`)
        });
        await storeSpeakingAudioLinkDriveReference(sourceClient, sourceUrl, {
          ...drive,
          resolved_download_url: downloaded.resolved_download_url || downloaded.final_download_url || "",
          mime_type: downloaded.original_mime_type || drive.mime_type,
          size_bytes: downloaded.original_size_bytes || drive.size_bytes
        });
        await sourceClient.query("commit");
        return {
          ok: true,
          status: "AUDIO_ASSET_STORED_IN_DRIVE",
          storage_provider: "NODE",
          audio_id: meta.row[meta.idColumn],
          submission_id: meta.row.submission_id,
          source_url: sourceUrl,
          resolved_download_url: downloaded.resolved_download_url || downloaded.final_download_url || "",
          final_download_url: downloaded.final_download_url || "",
          original_mime_type: downloaded.original_mime_type || "",
          original_size_bytes: downloaded.original_size_bytes || 0,
          drive,
          updated,
          checked_at: nowIso_()
        };
      } catch (error) {
        await sourceClient.query("rollback").catch(() => {});
        throw error;
      }
    });
  } catch (error) {
    return recordStorageFailure_(meta, error, options);
  }
}

export async function storeAudioAssetsInDriveBatch(options = {}) {
  const limit = normaliseLimit_(options.limit, 5, 100);
  const stored = [];
  const notAssessed = [];
  const failed = [];

  for (let i = 0; i < limit; i += 1) {
    const result = await storeOneAudioAssetInDrive(options);
    if (result.status === "NO_AUDIO_ASSET_READY_FOR_STORAGE") break;

    if (result.status === "AUDIO_ASSET_STORED_IN_DRIVE") {
      stored.push(result);
    } else if (result.status === "AUDIO_ASSET_MARKED_NOT_ASSESSED" || result.status === "AUDIO_ASSET_NOT_ASSESSED_AFTER_STORAGE_FAILURES") {
      notAssessed.push(result);
    } else {
      failed.push(result);
    }
  }

  return {
    ok: failed.length === 0,
    status: "AUDIO_DRIVE_STORAGE_BATCH_FINISHED",
    stored_count: stored.length,
    not_assessed_count: notAssessed.length,
    failed_count: failed.length,
    stored,
    not_assessed: notAssessed,
    failed,
    checked_at: nowIso_()
  };
}
