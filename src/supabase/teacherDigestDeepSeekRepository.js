import crypto from "node:crypto";
import { generateDigestMessages } from "../deepseek/digestClient.js";
import {
  buildDigestBatch,
  buildDigestStudentRequest,
  partitionDigestItems
} from "../teacherDigest/deepseekPayload.js";
import {
  LOCKED_TEACHER_DIGEST_PROMPT_SHA256,
  TEACHER_DIGEST_PROMPT_VERSION
} from "../teacherDigest/deepseekPrompt.js";
import { validateDigestBatchResponse } from "../teacherDigest/deepseekValidator.js";

function clean(value) { return String(value ?? "").trim(); }
function lower(value) { return clean(value).toLowerCase(); }
function retryAt(minutes) {
  const value = Number(minutes);
  return new Date(Date.now() + (Number.isFinite(value) && value >= 1 ? value : 5) * 60_000);
}
function boundedInteger(value,fallback,min,max){const parsed=Number(value);return Number.isInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;}
function safeError(error) {
  return clean(error?.sanitisedMessage || error?.message || error).slice(0, 1000);
}
function runKey({ teacherId, cycleKey, testRecipientEmail }) {
  if (!clean(testRecipientEmail)) return `teacher-digest-deepseek:${cycleKey}:${teacherId}`;
  const hash = crypto.createHash("sha256").update(lower(testRecipientEmail)).digest("hex").slice(0, 16);
  return `teacher-digest-deepseek-test:${cycleKey}:${teacherId}:${hash}`;
}
function rowRequest(row) {
  return {
    request_id: row.request_id,
    student_name_for_message: row.student_name_for_message,
    language: row.language,
    context: row.context_json || {},
    evidence: row.evidence_json || {},
    must_deliver: Array.isArray(row.must_deliver_json) ? row.must_deliver_json : []
  };
}

async function insertEvidenceRows(client, run, message, item, teacherId) {
  for (const feedback of item.facts.feedback_items_to_include || []) {
    await client.query(
      `insert into teacher_digest_deepseek_evidence_items(
         run_id,message_id,teacher_id,student_id,source_kind,source_id,delivery_key,payload_snapshot,is_included,created_at
       ) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'FINAL_FEEDBACK',$5::uuid,$6,$7::jsonb,false,now())
       on conflict(message_id,source_kind,source_id,delivery_key) do nothing`,
      [run.id,message.id,teacherId,item.student_id,feedback.id,clean(feedback.delivery_key),JSON.stringify(feedback)]
    );
  }
  for (const quiz of item.facts.quiz_items_to_include || []) {
    await client.query(
      `insert into teacher_digest_deepseek_evidence_items(
         run_id,message_id,teacher_id,student_id,source_kind,source_id,delivery_key,payload_snapshot,is_included,created_at
       ) values($1::uuid,$2::uuid,$3::uuid,$4::uuid,'QUIZ_SCORE',$5::uuid,'',$6::jsonb,false,now())
       on conflict(message_id,source_kind,source_id,delivery_key) do nothing`,
      [run.id,message.id,teacherId,item.student_id,quiz.id,JSON.stringify(quiz)]
    );
  }
}

async function ensureRunAndMessages(client, { teacher, window, evidenceItems, options }) {
  const testRecipientEmail = lower(options.testRecipientEmail || options.test_recipient_email);
  const key = runKey({ teacherId: teacher.teacher_id, cycleKey: window.cycle_key, testRecipientEmail });
  const model = clean(options.model || process.env.DEEPSEEK_MODEL) || "deepseek-v4-pro";
  await client.query("begin");
  try {
    const insertedRun = await client.query(
      `insert into teacher_digest_deepseek_runs(
         run_key,teacher_id,cycle_key,cycle_date,cycle_day,test_mode,test_recipient_email,status,
         expected_message_count,validated_message_count,provider,model,prompt_version,prompt_sha256,window_json,created_at,updated_at
       ) values($1,$2::uuid,$3,$4::date,$5,$6,$7,'COLLECTING',$8,0,'deepseek',$9,$10,$11,$12::jsonb,now(),now())
       on conflict(run_key) do nothing
       returning *`,
      [key,teacher.teacher_id,window.cycle_key,window.cycle_date,window.cycle_day,Boolean(testRecipientEmail),
        testRecipientEmail||null,evidenceItems.length,model,TEACHER_DIGEST_PROMPT_VERSION,
        LOCKED_TEACHER_DIGEST_PROMPT_SHA256,JSON.stringify(window)]
    );
    const isNewRun = insertedRun.rows.length === 1;
    const run = insertedRun.rows[0] || (await client.query(
      "select * from teacher_digest_deepseek_runs where run_key=$1",
      [key]
    )).rows[0];
    for (const item of isNewRun ? evidenceItems : []) {
      const request = buildDigestStudentRequest({
        requestId: crypto.randomUUID(),
        student: item.student,
        facts: item.facts,
        window
      });
      const message = (await client.query(
        `insert into teacher_digest_deepseek_messages(
           run_id,request_id,teacher_id,student_id,student_name_for_message,language,context_json,evidence_json,must_deliver_json,
           status,provider,model,prompt_version,prompt_sha256,is_test,created_at,updated_at
         ) values($1::uuid,$2,$3::uuid,$4::uuid,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,'PENDING','deepseek',$10,$11,$12,$13,now(),now())
         on conflict(run_id,student_id) do nothing
         returning *`,
        [run.id,request.request_id,teacher.teacher_id,item.student_id,request.student_name_for_message,request.language,
          JSON.stringify(request.context),JSON.stringify(request.evidence),JSON.stringify(request.must_deliver),
          model,TEACHER_DIGEST_PROMPT_VERSION,LOCKED_TEACHER_DIGEST_PROMPT_SHA256,Boolean(testRecipientEmail)]
      )).rows[0];
      if (message) await insertEvidenceRows(client,run,message,item,teacher.teacher_id);
    }
    await client.query("commit");
    return run;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

function usageNumber(usage, names) {
  for (const name of names) {
    const value = Number(usage?.[name]);
    if (Number.isFinite(value)) return Math.trunc(value);
  }
  return null;
}
function reasoningUsageNumber(usage) {
  return usageNumber(usage,["reasoning_tokens"]) ??
    usageNumber(usage?.completion_tokens_details,["reasoning_tokens"]);
}

function attemptBatchId(run, rows) {
  const requestHash = crypto.createHash("sha256")
    .update(rows.map((row) => row.request_id).sort().join("|"))
    .digest("hex")
    .slice(0, 12);
  return `${run.run_key}:${requestHash}:${crypto.randomUUID()}`;
}

async function createAttempt(client, { run, rows, batch }) {
  const attempt = (await client.query(
    `insert into teacher_digest_deepseek_attempts(
       run_id,batch_id,status,request_count,request_ids,request_payload,provider,model,
       prompt_version,prompt_sha256,started_at,created_at
     ) values($1::uuid,$2,'REQUESTED',$3,$4::text[],$5::jsonb,'deepseek',$6,$7,$8,now(),now())
     returning *`,
    [run.id,batch.batch_id,rows.length,rows.map((row) => row.request_id),JSON.stringify(batch),
      run.model,TEACHER_DIGEST_PROMPT_VERSION,LOCKED_TEACHER_DIGEST_PROMPT_SHA256]
  )).rows[0];
  await client.query(
    `update teacher_digest_deepseek_messages
     set status='GENERATING',attempt_count=attempt_count+1,last_attempt_at=now(),next_attempt_at=null,
         error_code=null,error_message=null,updated_at=now()
     where id=any($1::uuid[]) and status not in('VALIDATED','INCLUDED')`,
    [rows.map((row) => row.id)]
  );
  return attempt;
}

async function saveValidation(client, { run, attempt, response, validation, retryMinutes }) {
  const validById = new Map(validation.valid_messages.map((item) => [item.request_id, item]));
  const invalidById = new Map(validation.invalid_messages.map((item) => [item.request_id, item]));
  await client.query("begin");
  try {
    for (const [requestId, valid] of validById) {
      await client.query(
        `update teacher_digest_deepseek_messages
         set status='VALIDATED',message_text=$2,message_sha256=$3,question_count=$4,emoji_count=$5,
             provider=$6,model=$7,provider_request_id=$8,usage_json=$9::jsonb,
             validated_at=coalesce(validated_at,now()),next_attempt_at=null,error_code=null,error_message=null,updated_at=now()
         where run_id=$1::uuid and request_id=$10 and status not in('VALIDATED','INCLUDED')`,
        [run.id,valid.message,crypto.createHash("sha256").update(valid.message).digest("hex"),
          valid.question_count,valid.emoji_count,response.provider || "deepseek",response.model || run.model,
          response.provider_request_id || null,JSON.stringify(response.usage || {}),requestId]
      );
    }
    for (const [requestId, invalid] of invalidById) {
      await client.query(
        `update teacher_digest_deepseek_messages
         set status='RETRY_WAIT',next_attempt_at=$3::timestamptz,error_code='INVALID_RESPONSE',
             error_message=$4,updated_at=now()
         where run_id=$1::uuid and request_id=$2 and status not in('VALIDATED','INCLUDED')`,
        [run.id,requestId,retryAt(retryMinutes),clean((invalid.errors || []).join(", ")).slice(0,1000)]
      );
    }
    const usage = response.usage || {};
    const attemptStatus = validById.size && invalidById.size ? "PARTIAL" : invalidById.size ? "FAILED" : "SUCCEEDED";
    const validationSummary = {
      ok: validation.ok,
      batch_errors: validation.batch_errors,
      missing_request_ids: validation.missing_request_ids,
      duplicate_request_ids: validation.duplicate_request_ids,
      unexpected_request_ids: validation.unexpected_request_ids,
      valid_request_ids: validation.valid_messages.map((item) => item.request_id),
      invalid_messages: validation.invalid_messages
    };
    const responseSummary = {
      batch_id: validation.parsed?.batch_id || null,
      output_count: Array.isArray(validation.parsed?.messages) ? validation.parsed.messages.length : null
    };
    await client.query(
      `update teacher_digest_deepseek_attempts
       set status=$2,provider_request_id=$3,response_payload=$4::jsonb,validation_json=$5::jsonb,
           input_tokens=$6,output_tokens=$7,reasoning_tokens=$8,total_tokens=$9,error_code=$10,error_message=$11,completed_at=now()
       where id=$1::uuid`,
      [attempt.id,attemptStatus,response.provider_request_id || null,JSON.stringify(responseSummary),
        JSON.stringify(validationSummary),usageNumber(usage,["prompt_tokens","input_tokens"]),
        usageNumber(usage,["completion_tokens","output_tokens"]),reasoningUsageNumber(usage),usageNumber(usage,["total_tokens"]),
        invalidById.size ? "INVALID_RESPONSE" : null,
        invalidById.size ? clean(validation.batch_errors.concat(validation.invalid_messages.flatMap((item) => item.errors || [])).join(", ")).slice(0,1000) : null]
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function saveProviderFailure(client, { run, attempt, rows, error, retryMinutes, retryable }) {
  const status = retryable ? "RETRY_WAIT" : "FAILED";
  const code = clean(error?.providerCode) || (error?.status ? `DEEPSEEK_HTTP_${error.status}` : "DEEPSEEK_GENERATION_ERROR");
  const message = safeError(error);
  await client.query("begin");
  try {
    await client.query(
      `update teacher_digest_deepseek_messages
       set status=$2,next_attempt_at=$3::timestamptz,error_code=$4,error_message=$5,updated_at=now()
       where id=any($1::uuid[]) and status not in('VALIDATED','INCLUDED')`,
      [rows.map((row) => row.id),status,retryable ? retryAt(retryMinutes) : null,code,message]
    );
    await client.query(
      `update teacher_digest_deepseek_attempts
       set status='FAILED',error_code=$2,error_message=$3,completed_at=now()
       where id=$1::uuid`,
      [attempt.id,code,message]
    );
    await client.query("commit");
  } catch (saveError) {
    await client.query("rollback");
    throw saveError;
  }
}

async function loadRunMessages(client, runId) {
  return (await client.query(
    `select * from teacher_digest_deepseek_messages
     where run_id=$1::uuid
     order by created_at,id`,
    [runId]
  )).rows;
}

async function updateRunStatus(client, run, messages) {
  const validated = messages.filter((row) => ["VALIDATED","INCLUDED"].includes(clean(row.status).toUpperCase())).length;
  const failed = messages.filter((row) => clean(row.status).toUpperCase() === "FAILED").length;
  const ready = messages.length === Number(run.expected_message_count) && validated === Number(run.expected_message_count);
  const status = ready ? "VALIDATED" : failed ? "FAILED" : "RETRY_WAIT";
  await client.query(
    `update teacher_digest_deepseek_runs
     set status=$2,validated_message_count=$3,
         validated_at=case when $2='VALIDATED' then coalesce(validated_at,now()) else validated_at end,
         last_error_code=case when $2='VALIDATED' then null else last_error_code end,
         updated_at=now()
     where id=$1::uuid`,
    [run.id,status,validated]
  );
  return { ready, status, validated, failed };
}

export async function ensureValidatedTeacherDigestMessages(
  client,
  { teacher, window, evidenceItems, options = {}, dependencies = {} }
) {
  const run = await ensureRunAndMessages(client,{ teacher,window,evidenceItems,options });
  const batchSize = boundedInteger(options.deepSeekBatchSize,10,1,25);
  const immediateAttempts = boundedInteger(options.deepSeekImmediateAttempts,2,1,3);
  const maxAttempts = Math.max(immediateAttempts,boundedInteger(options.deepSeekMaxAttempts,6,1,20));
  const retryMinutes = Number(options.deepSeekRetryMinutes || 5);
  const generator = dependencies.generateDigestMessages || generateDigestMessages;
  let messages = await loadRunMessages(client,run.id);
  const due = messages.filter((row) => {
    const status = clean(row.status).toUpperCase();
    if (["VALIDATED","INCLUDED","FAILED"].includes(status)) return false;
    if (Number(row.attempt_count || 0) >= maxAttempts) return false;
    return !row.next_attempt_at || new Date(row.next_attempt_at).getTime() <= Date.now();
  });

  for (const initialRows of partitionDigestItems(due,batchSize)) {
    let remaining = initialRows;
    for (let pass = 0; pass < immediateAttempts && remaining.length; pass += 1) {
      const batch = buildDigestBatch({ batch_id: attemptBatchId(run,remaining), students: remaining.map(rowRequest) });
      const attempt = await createAttempt(client,{ run,rows:remaining,batch });
      try {
        const response = await generator({ batch,model:run.model });
        const validation = validateDigestBatchResponse({ expectedBatch:batch,response:response.content });
        await saveValidation(client,{ run,attempt,response,validation,retryMinutes });
        const invalidIds = new Set(validation.invalid_messages.map((item) => item.request_id));
        remaining = remaining.filter((row) => invalidIds.has(row.request_id) && Number(row.attempt_count || 0) + pass + 1 < maxAttempts);
      } catch (error) {
        const retryable = error?.retryable !== false;
        await saveProviderFailure(client,{ run,attempt,rows:remaining,error,retryMinutes,retryable });
        if (!retryable) break;
      }
    }
  }

  await client.query(
    `update teacher_digest_deepseek_messages
     set status='FAILED',next_attempt_at=null,error_code=coalesce(error_code,'MAX_ATTEMPTS_EXCEEDED'),
         error_message=coalesce(error_message,'DeepSeek digest generation reached the maximum attempt count.'),updated_at=now()
     where run_id=$1::uuid and status='RETRY_WAIT' and attempt_count>=$2`,
    [run.id,maxAttempts]
  );
  messages = await loadRunMessages(client,run.id);
  const state = await updateRunStatus(client,run,messages);
  return {
    run_id: run.id,
    run_key: run.run_key,
    ready: state.ready,
    status: state.status,
    expected_count: Number(run.expected_message_count),
    validated_count: state.validated,
    failed_count: state.failed,
    messages
  };
}

export async function linkDeepSeekRunToDigestRun(client, { deepSeekRunId, teacherDigestRunId }) {
  await client.query(
    `update teacher_digest_deepseek_runs
     set teacher_digest_run_id=$2::uuid,status=case when status='VALIDATED' then 'DOCUMENTS_QUEUED' else status end,updated_at=now()
     where id=$1::uuid`,
    [deepSeekRunId,teacherDigestRunId]
  );
}
