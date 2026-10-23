import crypto from "node:crypto";

function clean_(value) { return String(value ?? "").trim(); }

export function speakingAudioSourceHash(canonicalSourceUrl) {
  return crypto.createHash("sha256").update(clean_(canonicalSourceUrl)).digest("hex");
}

export class SpeakingAudioLinkOwnershipError extends Error {
  constructor(message = "This SpeakPipe recording already belongs to another assignment.") {
    super(message);
    this.name = "SpeakingAudioLinkOwnershipError";
    this.code = "SPEAKPIPE_LINK_ASSIGNED_TO_OTHER_ASSIGNMENT";
    this.httpStatus = 409;
    this.retryable = false;
  }
}

function sameAssignment_(row, studentId, assignmentKey) {
  return clean_(row?.owner_student_id) === clean_(studentId)
    && clean_(row?.owner_assignment_key) === clean_(assignmentKey);
}

export async function claimSpeakingAudioLinkForAssignment(client, {
  canonicalSourceUrl,
  studentId,
  assignmentKey,
  submissionId
} = {}) {
  const sourceUrl = clean_(canonicalSourceUrl);
  const ownerStudentId = clean_(studentId);
  const ownerAssignmentKey = clean_(assignmentKey);
  if (!client || !sourceUrl || !ownerStudentId || !ownerAssignmentKey) {
    throw new Error("A canonical SpeakPipe URL, student_id and assignment_key are required to claim an audio link.");
  }

  const inserted = await client.query(
    `insert into speaking_audio_link_registry(
       canonical_source_url, source_url_sha256, owner_student_id, owner_assignment_key,
       first_submission_id, storage_status, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,'PENDING',now(),now())
     on conflict(canonical_source_url) do nothing
     returning *`,
    [sourceUrl, speakingAudioSourceHash(sourceUrl), ownerStudentId, ownerAssignmentKey, submissionId || null]
  );

  const row = inserted.rows[0] || (await client.query(
    `select * from speaking_audio_link_registry
      where canonical_source_url=$1
      for update`,
    [sourceUrl]
  )).rows[0];

  if (!row) throw new Error("The SpeakPipe link registry claim could not be loaded.");
  if (!sameAssignment_(row, ownerStudentId, ownerAssignmentKey)) {
    throw new SpeakingAudioLinkOwnershipError();
  }

  return { created: Boolean(inserted.rows[0]), registry: row };
}

export async function lockSpeakingAudioLinkRegistry(client, canonicalSourceUrl) {
  const result = await client.query(
    `select * from speaking_audio_link_registry
      where canonical_source_url=$1
      for update`,
    [clean_(canonicalSourceUrl)]
  );
  return result.rows[0] || null;
}

export async function storeSpeakingAudioLinkDriveReference(client, canonicalSourceUrl, drive = {}) {
  const result = await client.query(
    `update speaking_audio_link_registry set
       storage_status='STORED',
       stored_drive_file_id=$2,
       stored_drive_url=$3,
       resolved_download_url=$4,
       mime_type=$5,
       file_size_bytes=$6,
       storage_error_code=null,
       storage_error_message=null,
       stored_at=coalesce(stored_at,now()),
       updated_at=now()
     where canonical_source_url=$1
     returning *`,
    [
      clean_(canonicalSourceUrl),
      clean_(drive.drive_file_id || drive.stored_drive_file_id),
      clean_(drive.drive_url || drive.stored_drive_url),
      clean_(drive.resolved_download_url),
      clean_(drive.mime_type),
      Number(drive.size_bytes || drive.file_size_bytes || 0) || null
    ]
  );
  return result.rows[0] || null;
}
