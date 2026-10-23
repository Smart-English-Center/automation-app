import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { downloadGoogleDriveFileBuffer } from "../google/driveClient.js";

const DEFAULT_MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_HTML_BYTES = 5 * 1024 * 1024;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60000;
const DEFAULT_FFMPEG_TIMEOUT_MS = 120000;
const DEFAULT_MAX_REDIRECTS = 8;

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export class AudioProcessingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AudioProcessingError";
    this.code = details.code || "AUDIO_PROCESSING_ERROR";
    this.details = details;
  }
}

export async function downloadAndConvertAudioToWavBuffer({
  sourceUrl,
  studentName = "",
  lessonKey = "",
  referenceName = "",
  maxBytes = DEFAULT_MAX_AUDIO_BYTES,
  downloadTimeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS,
  ffmpegTimeoutMs = DEFAULT_FFMPEG_TIMEOUT_MS
}) {
  const original = await downloadOriginalAudioForProcessing({
    sourceUrl,
    studentName,
    lessonKey,
    referenceName,
    maxBytes,
    timeoutMs: downloadTimeoutMs
  });

  const workDir = await createAudioWorkDir();

  try {
    const originalPath = path.join(workDir, original.original_filename);
    const wavFileBase = removeFileExtension(original.original_filename);
    const wavPath = path.join(workDir, `${wavFileBase}-azure.wav`);

    await fs.writeFile(originalPath, original.original_buffer);

    const conversion = await convertAudioFileToAzureWav({
      inputPath: originalPath,
      outputPath: wavPath,
      timeoutMs: ffmpegTimeoutMs
    });

    const wavBuffer = await fs.readFile(wavPath);

    if (!wavBuffer.length) {
      throw new AudioProcessingError("FFmpeg produced an empty WAV file.", {
        code: "EMPTY_CONVERTED_WAV"
      });
    }

    if (!looksLikeRiffWave(wavBuffer)) {
      throw new AudioProcessingError("Converted file does not look like a valid RIFF/WAVE file.", {
        code: "CONVERTED_FILE_NOT_WAV",
        first_bytes_hex: wavBuffer.slice(0, 32).toString("hex")
      });
    }

    return {
      ok: true,

      source_url: original.source_url,
      source_type: original.source_type,

      resolved_download_url: original.resolved_download_url,
      final_download_url: original.final_download_url,

      original_filename: original.original_filename,
      original_extension: original.original_extension,
      original_mime_type: original.original_mime_type,
      original_content_disposition: original.original_content_disposition,
      original_size_bytes: original.original_size_bytes,
      original_buffer: original.original_buffer,

      wav_filename: `${wavFileBase}-azure.wav`,
      wav_mime_type: "audio/wav",
      wav_size_bytes: wavBuffer.length,
      wav_buffer: wavBuffer,

      conversion
    };
  } finally {
    await removeWorkDirSafely(workDir);
  }
}

export async function downloadOriginalAudioForProcessing({
  sourceUrl,
  studentName = "",
  lessonKey = "",
  referenceName = "",
  maxBytes = DEFAULT_MAX_AUDIO_BYTES,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS
}) {
  const cleanSourceUrl = String(sourceUrl || "").trim();

  if (!cleanSourceUrl) {
    throw new AudioProcessingError("sourceUrl is required.", {
      code: "MISSING_SOURCE_URL"
    });
  }

  const sourceType = classifyAudioSourceUrl(cleanSourceUrl);

  let resolvedDownloadUrl = cleanSourceUrl;

  let downloaded = null;

  if (sourceType === "google_drive_file_id") {
    const driveFileId = cleanSourceUrl.replace(/^google-drive-file:\/\//i, "").trim();
    const driveDownload = await downloadGoogleDriveFileBuffer(driveFileId);
    resolvedDownloadUrl = `google-drive-file://${driveFileId}`;
    downloaded = {
      buffer: driveDownload.buffer,
      final_url: resolvedDownloadUrl,
      content_type: driveDownload.mime_type,
      content_disposition: driveDownload.filename ? `filename="${driveDownload.filename}"` : "",
      content_length_header: String(driveDownload.size_bytes || driveDownload.buffer.length || "")
    };
  } else {
    if (sourceType === "speakpipe") {
      resolvedDownloadUrl = await resolveSpeakPipeDownloadUrl({
        speakPipeUrl: cleanSourceUrl,
        timeoutMs
      });
    } else if (sourceType === "google_drive") {
      resolvedDownloadUrl = buildGoogleDrivePublicDownloadUrl(cleanSourceUrl);
    } else if (sourceType === "generic_url") {
      resolvedDownloadUrl = cleanSourceUrl;
    } else {
      throw new AudioProcessingError("Unsupported audio source URL.", {
        code: "UNSUPPORTED_AUDIO_SOURCE",
        source_url: cleanSourceUrl,
        source_type: sourceType
      });
    }

    downloaded = await downloadAudioFileFromResolvedUrl({
      sourceUrl: cleanSourceUrl,
      resolvedDownloadUrl,
      sourceType,
      maxBytes,
      timeoutMs
    });
  }

  const extension = detectExtensionFromResponse({
    downloadUrl: downloaded.final_url || resolvedDownloadUrl,
    contentType: downloaded.content_type,
    bytes: downloaded.buffer
  });

  const originalFilename = buildOriginalAudioFilename({
    studentName,
    lessonKey,
    referenceName,
    extension
  });

  return {
    ok: true,

    source_url: cleanSourceUrl,
    source_type: sourceType,

    resolved_download_url: resolvedDownloadUrl,
    final_download_url: downloaded.final_url,

    original_filename: originalFilename,
    original_extension: extension,
    original_mime_type: downloaded.content_type,
    original_content_disposition: downloaded.content_disposition,
    original_size_bytes: downloaded.buffer.length,
    original_buffer: downloaded.buffer,

    validation: {
      looks_like_audio: true,
      looks_like_riff_wave: looksLikeRiffWave(downloaded.buffer),
      looks_like_mp3: looksLikeMp3(downloaded.buffer),
      looks_like_ogg: looksLikeOgg(downloaded.buffer),
      looks_like_mp4_or_m4a: looksLikeMp4OrM4a(downloaded.buffer),
      looks_like_webm: looksLikeWebm(downloaded.buffer),
      first_bytes_hex: downloaded.buffer.slice(0, 32).toString("hex")
    }
  };
}

export async function inspectAudioSourceForProcessing({
  sourceUrl,
  maxBytes = DEFAULT_MAX_AUDIO_BYTES,
  timeoutMs = DEFAULT_DOWNLOAD_TIMEOUT_MS
}) {
  const cleanSourceUrl = String(sourceUrl || "").trim();

  if (!cleanSourceUrl) {
    throw new AudioProcessingError("sourceUrl is required.", {
      code: "MISSING_SOURCE_URL"
    });
  }

  const sourceType = classifyAudioSourceUrl(cleanSourceUrl);

  let resolvedDownloadUrl = cleanSourceUrl;
  let speakPipePageInspection = null;

  if (sourceType === "google_drive_file_id") {
    const driveFileId = cleanSourceUrl.replace(/^google-drive-file:\/\//i, "").trim();
    const driveDownload = await downloadGoogleDriveFileBuffer(driveFileId);
    return {
      ok: true,
      source_url: cleanSourceUrl,
      source_type: sourceType,
      resolved_download_url: cleanSourceUrl,
      final_download_url: cleanSourceUrl,
      http_status: 200,
      content_type: driveDownload.mime_type,
      content_disposition: driveDownload.filename ? `filename="${driveDownload.filename}"` : "",
      content_length_header: String(driveDownload.size_bytes || ""),
      size_bytes: driveDownload.buffer.length,
      looks_like_audio_or_download: true,
      looks_like_html: false,
      looks_like_riff_wave: looksLikeRiffWave(driveDownload.buffer),
      looks_like_mp3: looksLikeMp3(driveDownload.buffer),
      looks_like_ogg: looksLikeOgg(driveDownload.buffer),
      looks_like_mp4_or_m4a: looksLikeMp4OrM4a(driveDownload.buffer),
      looks_like_webm: looksLikeWebm(driveDownload.buffer),
      detected_extension: detectExtensionFromResponse({
        downloadUrl: cleanSourceUrl,
        contentType: driveDownload.mime_type,
        bytes: driveDownload.buffer
      }),
      first_bytes_hex: driveDownload.buffer.slice(0, 32).toString("hex"),
      first_bytes_text: driveDownload.buffer.slice(0, 32).toString("latin1"),
      speakpipe_page: null
    };
  }

  if (sourceType === "speakpipe") {
    const page = await fetchTextFromUrl({
      url: cleanSourceUrl,
      timeoutMs
    });

    const extracted = extractSpeakPipeDownloadAnchorHref(page.text, cleanSourceUrl);

    speakPipePageInspection = {
      page_url: cleanSourceUrl,
      page_http_status: page.http_status,
      page_final_url: page.final_url,
      page_content_type: page.content_type,
      page_size_bytes: page.text.length,
      download_anchor_found: Boolean(extracted),
      extracted_download_url: extracted
    };

    if (!extracted) {
      return {
        ok: false,
        source_url: cleanSourceUrl,
        source_type: sourceType,
        reason: "Could not find the SpeakPipe download link in the page.",
        speakpipe_page: speakPipePageInspection
      };
    }

    resolvedDownloadUrl = extracted;
  } else if (sourceType === "google_drive") {
    resolvedDownloadUrl = buildGoogleDrivePublicDownloadUrl(cleanSourceUrl);
  }

  const downloaded = await downloadBufferFromUrl({
    url: resolvedDownloadUrl,
    maxBytes,
    timeoutMs
  });

  const looksAudio = looksLikeAudioOrDownload({
    contentType: downloaded.content_type,
    contentDisposition: downloaded.content_disposition,
    bytes: downloaded.buffer,
    url: downloaded.final_url || resolvedDownloadUrl
  });

  return {
    ok: true,
    source_url: cleanSourceUrl,
    source_type: sourceType,
    resolved_download_url: resolvedDownloadUrl,
    final_download_url: downloaded.final_url,
    http_status: downloaded.http_status,
    content_type: downloaded.content_type,
    content_disposition: downloaded.content_disposition,
    content_length_header: downloaded.content_length_header,
    size_bytes: downloaded.buffer.length,
    looks_like_audio_or_download: looksAudio,
    looks_like_html: looksLikeHtml(downloaded.buffer, downloaded.content_type),
    looks_like_riff_wave: looksLikeRiffWave(downloaded.buffer),
    looks_like_mp3: looksLikeMp3(downloaded.buffer),
    looks_like_ogg: looksLikeOgg(downloaded.buffer),
    looks_like_mp4_or_m4a: looksLikeMp4OrM4a(downloaded.buffer),
    looks_like_webm: looksLikeWebm(downloaded.buffer),
    detected_extension: detectExtensionFromResponse({
      downloadUrl: downloaded.final_url || resolvedDownloadUrl,
      contentType: downloaded.content_type,
      bytes: downloaded.buffer
    }),
    first_bytes_hex: downloaded.buffer.slice(0, 32).toString("hex"),
    first_bytes_text: downloaded.buffer.slice(0, 32).toString("latin1"),
    speakpipe_page: speakPipePageInspection
  };
}

export function classifyAudioSourceUrl(url) {
  const cleanUrl = String(url || "").trim().toLowerCase();

  if (!cleanUrl) return "empty";
  if (cleanUrl.includes("speakpipe.com")) return "speakpipe";
  if (cleanUrl.startsWith("google-drive-file://")) return "google_drive_file_id";
  if (cleanUrl.includes("drive.google.com") || cleanUrl.includes("docs.google.com")) return "google_drive";
  if (cleanUrl.startsWith("http://") || cleanUrl.startsWith("https://")) return "generic_url";

  return "unknown";
}

async function resolveSpeakPipeDownloadUrl({
  speakPipeUrl,
  timeoutMs
}) {
  const page = await fetchTextFromUrl({
    url: speakPipeUrl,
    timeoutMs
  });

  const downloadUrl = extractSpeakPipeDownloadAnchorHref(page.text, speakPipeUrl);

  if (!downloadUrl) {
    throw new AudioProcessingError("Could not find the download link in the SpeakPipe page.", {
      code: "SPEAKPIPE_DOWNLOAD_LINK_NOT_FOUND",
      source_url: speakPipeUrl,
      page_final_url: page.final_url,
      page_content_type: page.content_type,
      page_preview: page.text.slice(0, 1000)
    });
  }

  return downloadUrl;
}

function extractSpeakPipeDownloadAnchorHref(html, baseUrl) {
  if (!html) return "";

  const exactDownloadAnchorMatch = String(html).match(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*>\s*download\s*<\/a>/i
  );

  if (exactDownloadAnchorMatch && exactDownloadAnchorMatch[1]) {
    return absolutizeUrl(
      decodeHtmlEntities(exactDownloadAnchorMatch[1]),
      baseUrl
    );
  }

  const downloadAttributeMatch = String(html).match(
    /<a\b[^>]*href=["']([^"']+)["'][^>]*download[^>]*>/i
  );

  if (downloadAttributeMatch && downloadAttributeMatch[1]) {
    return absolutizeUrl(
      decodeHtmlEntities(downloadAttributeMatch[1]),
      baseUrl
    );
  }

  return "";
}

async function downloadAudioFileFromResolvedUrl({
  sourceUrl,
  resolvedDownloadUrl,
  sourceType,
  maxBytes,
  timeoutMs
}) {
  const downloaded = await downloadBufferFromUrl({
    url: resolvedDownloadUrl,
    maxBytes,
    timeoutMs
  });

  if (looksLikeHtml(downloaded.buffer, downloaded.content_type)) {
    throw new AudioProcessingError("Resolved download link returned HTML instead of audio.", {
      code: "RESOLVED_AUDIO_RETURNED_HTML",
      source_url: sourceUrl,
      source_type: sourceType,
      resolved_download_url: resolvedDownloadUrl,
      final_download_url: downloaded.final_url,
      content_type: downloaded.content_type,
      html_preview: downloaded.buffer.slice(0, 1000).toString("utf8")
    });
  }

  const audioLooksValid = looksLikeAudioOrDownload({
    contentType: downloaded.content_type,
    contentDisposition: downloaded.content_disposition,
    bytes: downloaded.buffer,
    url: downloaded.final_url || resolvedDownloadUrl
  });

  if (!audioLooksValid) {
    throw new AudioProcessingError("Resolved download link did not return a recognised audio file.", {
      code: "RESOLVED_DOWNLOAD_NOT_AUDIO",
      source_url: sourceUrl,
      source_type: sourceType,
      resolved_download_url: resolvedDownloadUrl,
      final_download_url: downloaded.final_url,
      content_type: downloaded.content_type,
      content_disposition: downloaded.content_disposition,
      size_bytes: downloaded.buffer.length,
      first_bytes_hex: downloaded.buffer.slice(0, 32).toString("hex"),
      first_bytes_text: downloaded.buffer.slice(0, 32).toString("latin1")
    });
  }

  return downloaded;
}

async function fetchTextFromUrl({
  url,
  timeoutMs
}) {
  const response = await requestBufferWithRedirects({
    url,
    timeoutMs,
    maxBytes: DEFAULT_MAX_HTML_BYTES,
    maxRedirects: DEFAULT_MAX_REDIRECTS
  });

  const text = response.buffer.toString("utf8");

  if (response.http_status < 200 || response.http_status >= 300) {
    throw new AudioProcessingError("Failed to fetch page.", {
      code: "PAGE_FETCH_FAILED",
      url,
      final_url: response.final_url,
      http_status: response.http_status,
      content_type: response.content_type,
      body_preview: text.slice(0, 500)
    });
  }

  return {
    text,
    http_status: response.http_status,
    final_url: response.final_url || url,
    content_type: response.content_type || ""
  };
}

async function downloadBufferFromUrl({
  url,
  maxBytes,
  timeoutMs
}) {
  const response = await requestBufferWithRedirects({
    url,
    timeoutMs,
    maxBytes,
    maxRedirects: DEFAULT_MAX_REDIRECTS
  });

  if (response.http_status < 200 || response.http_status >= 300) {
    throw new AudioProcessingError("Audio download failed.", {
      code: "AUDIO_DOWNLOAD_FAILED",
      url,
      final_url: response.final_url || url,
      http_status: response.http_status,
      content_type: response.content_type,
      body_preview: response.buffer.slice(0, 500).toString("utf8")
    });
  }

  if (!response.buffer.length) {
    throw new AudioProcessingError("Downloaded audio file is empty.", {
      code: "EMPTY_AUDIO_DOWNLOAD",
      url,
      final_url: response.final_url || url
    });
  }

  return response;
}

async function requestBufferWithRedirects({
  url,
  timeoutMs,
  maxBytes,
  maxRedirects
}) {
  let currentUrl = String(url || "").trim();
  const visited = [];

  if (!currentUrl) {
    throw new AudioProcessingError("URL is required.", {
      code: "MISSING_URL"
    });
  }

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const response = await requestBufferOnce({
      url: currentUrl,
      timeoutMs,
      maxBytes
    });

    const status = response.http_status;
    const location = response.headers.location || response.headers.Location || "";

    if ([301, 302, 303, 307, 308].includes(status) && location) {
      visited.push({
        from: currentUrl,
        to: absolutizeUrl(location, currentUrl),
        status
      });

      currentUrl = absolutizeUrl(location, currentUrl);
      continue;
    }

    return {
      ...response,
      redirect_chain: visited
    };
  }

  throw new AudioProcessingError("Too many redirects while downloading URL.", {
    code: "TOO_MANY_REDIRECTS",
    url,
    max_redirects: maxRedirects,
    redirect_chain: visited
  });
}

function requestBufferOnce({
  url,
  timeoutMs,
  maxBytes
}) {
  return new Promise((resolve, reject) => {
    const cleanUrl = String(url || "").trim();
    const timeout = normalisePositiveInteger(timeoutMs, DEFAULT_DOWNLOAD_TIMEOUT_MS);
    const limit = normalisePositiveInteger(maxBytes, DEFAULT_MAX_AUDIO_BYTES);

    let parsedUrl;

    try {
      parsedUrl = new URL(cleanUrl);
    } catch (error) {
      reject(
        new AudioProcessingError("Invalid URL.", {
          code: "INVALID_URL",
          url: cleanUrl,
          error: String(error.message || error)
        })
      );
      return;
    }

    const transport = parsedUrl.protocol === "http:" ? http : https;

    const requestOptions = {
  protocol: parsedUrl.protocol,
  hostname: parsedUrl.hostname,
  port: parsedUrl.port || (parsedUrl.protocol === "http:" ? 80 : 443),
  path: parsedUrl.pathname + parsedUrl.search,
  method: "GET",
  family: 4,
  headers: {
    "User-Agent": BROWSER_USER_AGENT,
    "Accept": "*/*",
    "Accept-Encoding": "identity",
    "Connection": "close"
  }
};

    const req = transport.request(requestOptions, (response) => {
      const chunks = [];
      let totalBytes = 0;

      const headers = response.headers || {};
      const contentLengthHeader = String(headers["content-length"] || "");
      const contentLength = Number(contentLengthHeader || 0);

      if (contentLength && contentLength > limit) {
        req.destroy(
          new AudioProcessingError("Downloaded file is too large according to Content-Length.", {
            code: "AUDIO_TOO_LARGE_CONTENT_LENGTH",
            url: cleanUrl,
            content_length: contentLength,
            max_bytes: limit
          })
        );
        return;
      }

      response.on("data", (chunk) => {
        totalBytes += chunk.length;

        if (totalBytes > limit) {
          req.destroy(
            new AudioProcessingError("Downloaded file exceeded maximum allowed size.", {
              code: "AUDIO_TOO_LARGE_STREAMING",
              url: cleanUrl,
              size_bytes: totalBytes,
              max_bytes: limit
            })
          );
          return;
        }

        chunks.push(chunk);
      });

      response.on("end", () => {
        const buffer = Buffer.concat(chunks, totalBytes);

        resolve({
          buffer,
          http_status: Number(response.statusCode || 0),
          final_url: cleanUrl,
          headers,
          content_type: String(headers["content-type"] || ""),
          content_disposition: String(headers["content-disposition"] || ""),
          content_length_header: contentLengthHeader
        });
      });

      response.on("error", (error) => {
        reject(
          new AudioProcessingError("HTTP response stream failed.", {
            code: "HTTP_RESPONSE_STREAM_FAILED",
            url: cleanUrl,
            error_name: String(error.name || ""),
            error_message: String(error.message || error),
            error_code: String(error.code || "")
          })
        );
      });
    });

    req.setTimeout(timeout, () => {
      req.destroy(
        new AudioProcessingError("HTTP request timed out before completion.", {
          code: "HTTP_REQUEST_TIMEOUT",
          url: cleanUrl,
          timeout_ms: timeout
        })
      );
    });

    req.on("socket", (socket) => {
      socket.setTimeout(timeout);

      socket.on("timeout", () => {
        req.destroy(
          new AudioProcessingError("HTTP socket timed out.", {
            code: "HTTP_SOCKET_TIMEOUT",
            url: cleanUrl,
            timeout_ms: timeout
          })
        );
      });
    });

    req.on("error", (error) => {
      if (error instanceof AudioProcessingError) {
        reject(error);
        return;
      }

      reject(
        new AudioProcessingError("HTTP request failed before a usable response.", {
          code: "HTTP_REQUEST_FAILED",
          url: cleanUrl,
          error_name: String(error.name || ""),
          error_message: String(error.message || error),
          error_code: String(error.code || ""),
          error_errno: String(error.errno || ""),
          error_syscall: String(error.syscall || ""),
          error_hostname: String(error.hostname || "")
        })
      );
    });

    req.end();
  });
}

async function convertAudioFileToAzureWav({
  inputPath,
  outputPath,
  timeoutMs
}) {
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inputPath,
    "-vn",
    "-acodec",
    "pcm_s16le",
    "-ac",
    "1",
    "-ar",
    "16000",
    outputPath
  ];

  const result = await runCommandWithTimeout({
    command: "ffmpeg",
    args,
    timeoutMs: normalisePositiveInteger(timeoutMs, DEFAULT_FFMPEG_TIMEOUT_MS)
  });

  if (result.exit_code !== 0) {
    throw new AudioProcessingError("FFmpeg conversion failed.", {
      code: "FFMPEG_CONVERSION_FAILED",
      exit_code: result.exit_code,
      stderr_preview: result.stderr.slice(0, 1500),
      args
    });
  }

  return {
    command: "ffmpeg",
    args,
    exit_code: result.exit_code,
    stderr_preview: result.stderr.slice(0, 1500)
  };
}

function runCommandWithTimeout({
  command,
  args,
  timeoutMs
}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      if (settled) return;

      settled = true;

      try {
        child.kill("SIGKILL");
      } catch (error) {
        // Ignore kill errors.
      }

      reject(
        new AudioProcessingError(`${command} timed out.`, {
          code: "COMMAND_TIMEOUT",
          command,
          args,
          timeout_ms: timeoutMs,
          stdout_preview: stdout.slice(0, 1000),
          stderr_preview: stderr.slice(0, 1000)
        })
      );
    }, timeoutMs);

    child.stdout.on("data", chunk => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      reject(
        new AudioProcessingError(`${command} could not start.`, {
          code: "COMMAND_START_FAILED",
          command,
          args,
          error: String(error.message || error)
        })
      );
    });

    child.on("close", code => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);

      resolve({
        exit_code: Number(code),
        stdout,
        stderr
      });
    });
  });
}

function looksLikeAudioOrDownload({
  contentType,
  contentDisposition,
  bytes,
  url
}) {
  const ct = String(contentType || "").toLowerCase();
  const cd = String(contentDisposition || "").toLowerCase();
  const u = String(url || "").toLowerCase();

  if (ct.startsWith("audio/")) return true;
  if (ct.includes("application/octet-stream") && cd.includes("attachment")) return true;
  if (cd.includes("attachment")) return true;

  if (
    u.endsWith(".mp3") ||
    u.includes(".mp3?") ||
    u.endsWith(".wav") ||
    u.includes(".wav?") ||
    u.endsWith(".m4a") ||
    u.includes(".m4a?") ||
    u.endsWith(".ogg") ||
    u.includes(".ogg?") ||
    u.endsWith(".webm") ||
    u.includes(".webm?")
  ) {
    return true;
  }

  if (!bytes || bytes.length < 4) return false;

  if (looksLikeMp3(bytes)) return true;
  if (looksLikeRiffWave(bytes)) return true;
  if (looksLikeOgg(bytes)) return true;
  if (looksLikeMp4OrM4a(bytes)) return true;
  if (looksLikeWebm(bytes)) return true;

  return false;
}

function detectExtensionFromResponse({
  downloadUrl,
  contentType,
  bytes
}) {
  const ct = String(contentType || "").toLowerCase();
  const u = String(downloadUrl || "").toLowerCase();

  if (ct.includes("audio/mpeg") || ct.includes("audio/mp3")) return ".mp3";
  if (ct.includes("audio/wav") || ct.includes("audio/x-wav") || ct.includes("audio/wave")) return ".wav";
  if (ct.includes("audio/mp4") || ct.includes("audio/x-m4a")) return ".m4a";
  if (ct.includes("audio/ogg") || ct.includes("application/ogg")) return ".ogg";
  if (ct.includes("audio/webm") || ct.includes("video/webm")) return ".webm";

  if (u.endsWith(".mp3") || u.includes(".mp3?")) return ".mp3";
  if (u.endsWith(".wav") || u.includes(".wav?")) return ".wav";
  if (u.endsWith(".m4a") || u.includes(".m4a?")) return ".m4a";
  if (u.endsWith(".ogg") || u.includes(".ogg?")) return ".ogg";
  if (u.endsWith(".webm") || u.includes(".webm?")) return ".webm";

  if (looksLikeMp3(bytes)) return ".mp3";
  if (looksLikeRiffWave(bytes)) return ".wav";
  if (looksLikeOgg(bytes)) return ".ogg";
  if (looksLikeMp4OrM4a(bytes)) return ".m4a";
  if (looksLikeWebm(bytes)) return ".webm";

  return ".audio";
}

function looksLikeHtml(buffer, contentType) {
  const ct = String(contentType || "").toLowerCase();

  if (ct.includes("text/html")) return true;

  if (!buffer || !buffer.length) return false;

  const preview = buffer.slice(0, 300).toString("utf8").trim().toLowerCase();

  return (
    preview.startsWith("<!doctype html") ||
    preview.startsWith("<html") ||
    preview.includes("<head") ||
    preview.includes("<body")
  );
}

function looksLikeMp3(bytes) {
  if (!bytes || bytes.length < 3) return false;

  const hasId3 = bytes[0] === 73 && bytes[1] === 68 && bytes[2] === 51;
  const hasMp3Frame =
    bytes.length >= 2 &&
    bytes[0] === 255 &&
    (bytes[1] === 251 || bytes[1] === 243 || bytes[1] === 242 || bytes[1] === 250);

  return hasId3 || hasMp3Frame;
}

function looksLikeRiffWave(bytes) {
  if (!bytes || bytes.length < 12) return false;

  return (
    bytes.slice(0, 4).toString("ascii") === "RIFF" &&
    bytes.slice(8, 12).toString("ascii") === "WAVE"
  );
}

function looksLikeOgg(bytes) {
  if (!bytes || bytes.length < 4) return false;

  return bytes.slice(0, 4).toString("ascii") === "OggS";
}

function looksLikeMp4OrM4a(bytes) {
  if (!bytes || bytes.length < 12) return false;

  return bytes.slice(4, 8).toString("ascii") === "ftyp";
}

function looksLikeWebm(bytes) {
  if (!bytes || bytes.length < 4) return false;

  return (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  );
}

function buildGoogleDrivePublicDownloadUrl(url) {
  const fileId = extractGoogleDriveFileId(url);

  if (!fileId) {
    return url;
  }

  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

function extractGoogleDriveFileId(url) {
  const cleanUrl = String(url || "").trim();

  const filePathMatch = cleanUrl.match(/\/file\/d\/([^/]+)/i);
  if (filePathMatch && filePathMatch[1]) {
    return filePathMatch[1];
  }

  const openIdMatch = cleanUrl.match(/[?&]id=([^&]+)/i);
  if (openIdMatch && openIdMatch[1]) {
    return openIdMatch[1];
  }

  return "";
}

function buildOriginalAudioFilename({
  studentName,
  lessonKey,
  referenceName,
  extension
}) {
  const parts = [
    sanitizeFilename(studentName),
    sanitizeFilename(lessonKey),
    sanitizeFilename(referenceName)
  ].filter(Boolean);

  const base = parts.length ? parts.join("_") : `audio_${new Date().toISOString().slice(0, 10)}`;
  const cleanExtension = String(extension || ".audio").startsWith(".")
    ? String(extension || ".audio")
    : `.${extension}`;

  return `${base}${cleanExtension}`;
}

function sanitizeFilename(text) {
  const clean = String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/*?:"<>|]/g, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return clean;
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x2F;/gi, "/")
    .replace(/&apos;/g, "'");
}

function absolutizeUrl(url, baseUrl) {
  const cleanUrl = String(url || "").trim();

  if (!cleanUrl) return "";

  try {
    return new URL(cleanUrl, baseUrl).toString();
  } catch (error) {
    return cleanUrl;
  }
}

function removeFileExtension(filename) {
  const clean = String(filename || "audio").trim();
  const ext = path.extname(clean);

  if (!ext) return clean;

  return clean.slice(0, -ext.length) || "audio";
}

async function createAudioWorkDir() {
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");

  const dir = path.join(os.tmpdir(), `jea-audio-${id}`);

  await fs.mkdir(dir, {
    recursive: true
  });

  return dir;
}

async function removeWorkDirSafely(dir) {
  if (!dir) return;

  try {
    await fs.rm(dir, {
      recursive: true,
      force: true
    });
  } catch (error) {
    // Temporary cleanup failure should not break the worker.
  }
}

function normalisePositiveInteger(value, fallback) {
  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) {
    return fallback;
  }

  return Math.round(number);
}
