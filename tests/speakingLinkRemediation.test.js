import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { queueBadSpeakpipeLinkEmails } from "../src/supabase/interventionEmailRepository.js";
import { correctRemediationLink, resolveRemediationWithoutSpeaking } from "../src/speakingLinkRemediation/service.js";
import { registerSpeakingLinkRemediationRoutes } from "../src/routes/speakingLinkRemediationRoutes.js";
import { createSpeakingLinkRemediationCase } from "../src/supabase/speakingLinkRemediationRepository.js";
import {
  claimSpeakingAudioLinkForAssignment,
  lockSpeakingAudioLinkRegistry,
  SpeakingAudioLinkOwnershipError,
  speakingAudioSourceHash
} from "../src/supabase/speakingAudioLinkRepository.js";
import {
  findGoogleDriveFileByAppProperty,
  uploadBufferToGoogleDrive
} from "../src/google/driveClient.js";

const MESSAGE_ID = "9t8xklgg9944bprc";
const CANONICAL_LINK = `https://www.speakpipe.com/voice-recorder/msg/${MESSAGE_ID}`;

function caseRow(overrides = {}) {
  return {
    id: "case-1",
    submission_id: "submission-1",
    student_id: "student-1",
    teacher_id: "teacher-1",
    speaking_task_id: "task-1",
    assignment_key: "A2_M1_U1_D1_ASSIGNMENT",
    level: "A2",
    version: 1,
    status: "AWAITING_ACTION",
    original_link: "https://www.speakpipe.com/",
    canonical_link: null,
    recipient_email: "teacher@example.com",
    has_final_feedback: false,
    audio_asset_id: null,
    speaking_draft_id: null,
    ...overrides
  };
}

function correctionClient(row = caseRow()) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      if (/from speaking_link_remediation_cases c/.test(sql)) return { rows: [row] };
      if (/insert into speaking_audio_link_registry/.test(sql)) return { rows: [{ canonical_source_url: params[0], owner_student_id: row.student_id, owner_assignment_key: row.assignment_key }] };
      if (/insert into audio_assets/.test(sql)) return { rows: [{ id: "audio-1", source_url: params[4], status: "READY_FOR_STORAGE" }] };
      if (/insert into ai_drafts/.test(sql)) return { rows: [{ id: "draft-1", status: /NOT_ASSESSED/.test(sql) ? "NOT_ASSESSED" : "WAITING_FOR_AUDIO_STORAGE" }] };
      if (/update speaking_link_remediation_cases/.test(sql)) return { rows: [{ ...row, status: params.length > 1 ? "LINK_CORRECTED" : "RESOLVED_WITHOUT_SPEAKING", canonical_link: params[1] || null, version: 2 }] };
      return { rows: [] };
    }
  };
}

test("teacher invalid-link notification queues one teacher email with both remediation actions", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [{ id: "email-1", source_type: params[0], recipient_email: params[4] }] };
    }
  };
  const queued = await queueBadSpeakpipeLinkEmails(client, {
    submission: { id: "submission-1", assignment_key: "A2_M1_U1_D1", level: "A2", audio_link: "https://www.speakpipe.com/", writing_answer: "My answer" },
    student: { id: "student-1", full_name: "Awa Test", email: "student@example.com" },
    enrollment: { id: "enrollment-1", teacher_id: "teacher-1", teacher_name: "Teacher Test", teacher_email: "teacher@example.com", level: "A2" },
    linkInfo: { issue_code: "SPEAKPIPE_MESSAGE_ID_MISSING", issue_message: "The message id is missing." },
    remediation: {
      case: { id: "case-1" },
      correct_url: "https://worker.example/api/speaking-link-remediation?token=secret&mode=correct",
      resolve_url: "https://worker.example/api/speaking-link-remediation?token=secret&mode=resolve"
    }
  });

  assert.equal(queued.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[0], "BAD_SPEAKPIPE_LINK_TEACHER_ALERT");
  assert.equal(calls[0].params[4], "teacher@example.com");
  assert.match(calls[0].params[10], /Enter the correct speaking link/);
  assert.match(calls[0].params[10], /Continue without speaking/);
  assert.doesNotMatch(calls[0].params[11], /student has already been notified/i);
  assert.doesNotMatch(calls[0].params[12], /token=secret/);
});

test("duplicate scheduler execution reuses the existing remediation case without creating another action", async () => {
  const calls = [];
  const existing = caseRow();
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (/insert into speaking_link_remediation_cases/.test(sql)) return { rows: [] };
      if (/select \* from speaking_link_remediation_cases/.test(sql)) return { rows: [existing] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  const result = await createSpeakingLinkRemediationCase(client, {
    submission: { id: "submission-1" },
    student: { id: "student-1" },
    enrollment: { id: "enrollment-1", teacher_id: "teacher-1", teacher_email: "teacher@example.com" },
    speakingTask: { id: "task-1" },
    linkInfo: { issue_code: "BAD_LINK", issue_message: "Bad link" }
  });
  assert.equal(result.created, false);
  assert.equal(result.case, existing);
  assert.equal(result.token_raw, "");
  assert.equal(calls.some((sql) => /insert into speaking_link_remediation_actions/.test(sql)), false);
});

test("corrected SpeakPipe link is canonicalised and creates one pending audio asset and speaking draft", async () => {
  const client = correctionClient();
  const result = await correctRemediationLink({
    token: "raw-token",
    version: "1",
    confirmation: "verified",
    corrected_link: ` http://speakpipe.com/voice-recorder/msg/${MESSAGE_ID}/?utm_source=email `
  }, { withSupabaseClient: async (callback) => callback(client) });

  assert.equal(result.status, "LINK_CORRECTED");
  const audioInsert = client.calls.find(({ sql }) => /insert into audio_assets/.test(sql));
  const draftInsert = client.calls.find(({ sql }) => /insert into ai_drafts/.test(sql));
  assert.equal(audioInsert.params[4], CANONICAL_LINK);
  assert.match(draftInsert.sql, /WAITING_FOR_AUDIO_STORAGE/);
  assert.equal(client.calls.filter(({ sql }) => /insert into audio_assets/.test(sql)).length, 1);
  assert.equal(client.calls.at(-1).sql, "commit");
});

test("the same SpeakPipe link is allowed for another submission of the same student assignment", async () => {
  const existingOwner = {
    canonical_source_url: CANONICAL_LINK,
    owner_student_id: "student-1",
    owner_assignment_key: "A2_M1_U1_D1_ASSIGNMENT"
  };
  const client = {
    async query(sql) {
      if (/insert into speaking_audio_link_registry/.test(sql)) return { rows: [] };
      if (/select \* from speaking_audio_link_registry/.test(sql)) return { rows: [existingOwner] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  const result = await claimSpeakingAudioLinkForAssignment(client, {
    canonicalSourceUrl: CANONICAL_LINK,
    studentId: "student-1",
    assignmentKey: "A2_M1_U1_D1_ASSIGNMENT",
    submissionId: "submission-2"
  });
  assert.equal(result.created, false);
  assert.equal(result.registry, existingOwner);
});

test("a SpeakPipe link owned by one assignment is rejected for another assignment or student", async () => {
  const existingOwner = {
    canonical_source_url: CANONICAL_LINK,
    owner_student_id: "student-1",
    owner_assignment_key: "A2_M1_U1_D1_ASSIGNMENT"
  };
  const makeClient = () => ({
    async query(sql) {
      if (/insert into speaking_audio_link_registry/.test(sql)) return { rows: [] };
      if (/select \* from speaking_audio_link_registry/.test(sql)) return { rows: [existingOwner] };
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  });
  for (const identity of [
    { studentId: "student-1", assignmentKey: "A2_M1_U1_D2_ASSIGNMENT" },
    { studentId: "student-2", assignmentKey: "A2_M1_U1_D1_ASSIGNMENT" }
  ]) {
    await assert.rejects(
      claimSpeakingAudioLinkForAssignment(makeClient(), {
        canonicalSourceUrl: CANONICAL_LINK,
        ...identity,
        submissionId: "submission-other"
      }),
      (error) => error instanceof SpeakingAudioLinkOwnershipError
        && error.code === "SPEAKPIPE_LINK_ASSIGNED_TO_OTHER_ASSIGNMENT"
    );
  }
  assert.equal(speakingAudioSourceHash(CANONICAL_LINK).length, 64);
});

test("Drive source-marker lookup can recover an earlier upload without uploading again", async () => {
  const previousFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ files: [{ id: "drive-file-1", name: "audio.mp3", mimeType: "audio/mpeg", size: "1234", webViewLink: "https://drive.example/file-1" }] });
      }
    };
  };
  try {
    const hash = speakingAudioSourceHash(CANONICAL_LINK);
    const found = await findGoogleDriveFileByAppProperty("jea_audio_source_sha256", hash, {
      accessToken: "test-token",
      folderId: "audio-folder"
    });
    assert.equal(found.drive_file_id, "drive-file-1");
    assert.equal(found.size_bytes, 1234);
    const query = new URL(requestedUrl).searchParams.get("q");
    assert.match(query, /appProperties has/);
    assert.match(query, new RegExp(hash));
    assert.match(query, /audio-folder/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("new Drive uploads carry the canonical source hash for crash recovery", async () => {
  const previousFetch = globalThis.fetch;
  const previousEnvironment = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REFRESH_TOKEN: process.env.GOOGLE_REFRESH_TOKEN
  };
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.GOOGLE_REFRESH_TOKEN = "test-refresh";
  let uploadMetadata = null;
  let callCount = 0;
  globalThis.fetch = async (_url, options = {}) => {
    callCount += 1;
    if (callCount === 1) {
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ access_token: "test-access-token" }); }
      };
    }
    uploadMetadata = JSON.parse(await options.body.get("metadata").text());
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ id: "drive-file-new", name: "audio.mp3", mimeType: "audio/mpeg", size: "4" });
      }
    };
  };
  try {
    const sourceHash = speakingAudioSourceHash(CANONICAL_LINK);
    const uploaded = await uploadBufferToGoogleDrive(Buffer.from("test"), {
      filename: "audio.mp3",
      mimeType: "audio/mpeg",
      appProperties: { jea_audio_source_sha256: sourceHash }
    });
    assert.equal(uploaded.drive_file_id, "drive-file-new");
    assert.deepEqual(uploadMetadata.appProperties, { jea_audio_source_sha256: sourceHash });
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("audio storage takes a database row lock for the canonical source URL", async () => {
  let statement = "";
  const client = {
    async query(sql, params) {
      statement = String(sql);
      assert.deepEqual(params, [CANONICAL_LINK]);
      return { rows: [{ canonical_source_url: CANONICAL_LINK }] };
    }
  };
  const locked = await lockSpeakingAudioLinkRegistry(client, CANONICAL_LINK);
  assert.equal(locked.canonical_source_url, CANONICAL_LINK);
  assert.match(statement, /where canonical_source_url=\$1\s+for update/);
});

test("continue without speaking creates the terminal speaking outcome only after explicit confirmation", async () => {
  await assert.rejects(
    resolveRemediationWithoutSpeaking({ token: "raw-token", version: 1 }),
    (error) => error.code === "CONFIRMATION_REQUIRED"
  );

  const client = correctionClient();
  const result = await resolveRemediationWithoutSpeaking({
    token: "raw-token",
    version: 1,
    confirmation: "continue_without_speaking"
  }, { withSupabaseClient: async (callback) => callback(client) });
  assert.equal(result.status, "RESOLVED_WITHOUT_SPEAKING");
  const draftInsert = client.calls.find(({ sql }) => /insert into ai_drafts/.test(sql));
  assert.match(draftInsert.sql, /'NOT_ASSESSED','BAD_SUBMISSION'/);
  assert.equal(client.calls.at(-1).sql, "commit");
});

test("GET remediation page is read-only and exposes correction and resolution forms", async () => {
  const routes = {};
  const app = {
    get(path, handler) { routes[`GET ${path}`] = handler; },
    post(path, handler) { routes[`POST ${path}`] = handler; }
  };
  let correctCalls = 0;
  let resolveCalls = 0;
  registerSpeakingLinkRemediationRoutes(app, {
    loadRemediationPage: async () => ({ ...caseRow(), student_name: "Awa Test", assignment_key: "A2_M1_U1_D1", issue_message: "Invalid link" }),
    correctRemediationLink: async () => { correctCalls += 1; },
    resolveRemediationWithoutSpeaking: async () => { resolveCalls += 1; }
  });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, send(value) { this.body = value; return this; } };
  await routes["GET /api/speaking-link-remediation"]({ query: { token: "raw-token" } }, response);
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Validate and start speaking processing/);
  assert.match(response.body, /Continue without speaking/);
  assert.equal(correctCalls, 0);
  assert.equal(resolveCalls, 0);
});

test("downstream gates, assignment-level ownership, and source-level Drive deduplication are preserved in code", async () => {
  const [finalFeedback, emailQueue, scheduler, audioStorage, dataImport] = await Promise.all([
    readFile(new URL("../src/supabase/finalFeedbackRepository.js", import.meta.url), "utf8"),
    readFile(new URL("../src/supabase/emailQueueRepository.js", import.meta.url), "utf8"),
    readFile(new URL("../src/scheduler.js", import.meta.url), "utf8"),
    readFile(new URL("../src/supabase/audioDriveStorageRepository.js", import.meta.url), "utf8"),
    readFile(new URL("../src/supabase/dataImportRepository.js", import.meta.url), "utf8")
  ]);
  assert.match(finalFeedback, /rc\.status = 'AWAITING_ACTION'/);
  assert.match(finalFeedback, /rc\.status = 'LINK_CORRECTED'/);
  assert.match(emailQueue, /RETIRED_AUTOMATIC_REMINDER_SOURCE_TYPES = \[\s*"BAD_SPEAKPIPE_LINK_STUDENT"/);
  assert.doesNotMatch(scheduler, /ASSIGNMENT_RECEIPT_ACK,BAD_SPEAKPIPE_LINK_STUDENT/);
  const sourceLock = audioStorage.indexOf("lockSpeakingAudioLinkRegistry(sourceClient, sourceUrl)");
  const reuseBranch = audioStorage.indexOf("if (reusableStoredAudio)", sourceLock);
  const sourceDownload = audioStorage.indexOf("downloadOriginalAudioForProcessing({", sourceLock);
  const driveUpload = audioStorage.indexOf("uploadBufferToGoogleDrive(downloaded.original_buffer");
  assert.ok(sourceLock >= 0 && driveUpload > sourceLock);
  assert.ok(reuseBranch > sourceLock && sourceDownload > reuseBranch);
  assert.match(audioStorage, /findReusableStoredAudioAsset_\(sourceClient, meta, sourceUrl\)/);
  assert.match(audioStorage, /findGoogleDriveFileByAppProperty/);
  assert.match(audioStorage, /DRIVE_AUDIO_SOURCE_HASH_PROPERTY/);
  assert.doesNotMatch(audioStorage, /qaa\("submission_id"\).*\$3/);
  assert.match(dataImport, /claimSpeakingAudioLinkForAssignment/);
  assert.match(dataImport, /SpeakingAudioLinkOwnershipError/);
  assert.doesNotMatch(dataImport, /DUPLICATE_SPEAKPIPE_LINK/);
  assert.doesNotMatch(dataImport, /createTerminalSpeakingDraftForBadLink_/);
});
