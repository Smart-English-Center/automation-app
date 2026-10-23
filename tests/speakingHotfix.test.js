import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import express from "express";
import { classifySpeakPipeLink } from "../src/submissionPolicy.js";
import { correctRemediationLink } from "../src/speakingLinkRemediation/service.js";
import { registerSpeakingLinkRemediationRoutes } from "../src/routes/speakingLinkRemediationRoutes.js";
import { ensureSpeakingCycle } from "../src/supabase/speakingTopicRepository.js";
import { runSpeakingPipelineOnce } from "../src/speaking/pipeline.js";
import { getSpeakingConfig } from "../src/speaking/config.js";
import { getConfig } from "../src/config.js";
import { getSpeakingAudioModels, buildSpeakingCorrectionChatCompletionBody, generateJeaSpeakingCorrectionFromAudioWithOpenAi } from "../src/clients/openaiAudio.js";
import { storeOneAudioAssetInDrive } from "../src/supabase/audioDriveStorageRepository.js";
import { processTranscriptionOne } from "../src/supabase/correctionRepository.js";

const direct = "https://www.speakpipe.com/voice-recorder/msg/exampleRecording_1";
const highlighted = "https://www.speakpipe.com/voice-recorder#:~:text=https%3A//www.speakpipe.com/voice%2Drecorder/msg/exampleRecording_1";
const issue = "Le lien SpeakPipe semble incomplet. Il doit contenir l’identifiant du message audio.";

async function withEnvironment(values, callback) {
  const old = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await callback(); }
  finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

function remediationRow(overrides = {}) {
  return { id:"case-1", submission_id:"submission-1", student_id:"student-1", assignment_key:"B1_M1_U2_D2_ASSIGNMENT", speaking_task_id:"task-1", level:"B1", status:"AWAITING_ACTION", version:1, original_link:highlighted, issue_message:issue, has_final_feedback:false, ...overrides };
}

function routeHarness(row, dependencies = {}) {
  const routes = {};
  registerSpeakingLinkRemediationRoutes({ get:(path, handler)=>{routes[`GET ${path}`]=handler;}, post:(path, handler)=>{routes[`POST ${path}`]=handler;} }, { loadRemediationPage:async()=>row, ...dependencies });
  const res = { statusCode:200, set(){return this;}, status(value){this.statusCode=value;return this;}, send(value){this.body=value;return this;} };
  return { routes, res };
}

test("highlighted and normal recording URLs have one canonical identity across message IDs", () => {
  for (const link of [highlighted, direct, `${direct}/?utm_source=email#note`]) {
    assert.equal(classifySpeakPipeLink(link).normalized_url, direct);
  }
  for (const messageId of ["exampleRecording_1", "another-recording-2", "ABC123", "recording_3"]) {
    for (const recordingPath of [`voice-recorder/msg/${messageId}`, `msg/s/123/456/${messageId}`]) {
      const canonical = `https://www.speakpipe.com/${recordingPath}`;
      for (const host of ["speakpipe.com", "www.speakpipe.com"]) {
        const recording = `https://${host}/${recordingPath}`;
        const encoded = `https://${host}/voice-recorder#:~:text=${encodeURIComponent(recording)}`;
        const partiallyEncoded = `https://${host}/voice-recorder#:~:text=${recording.replace("https:", "https%3A").replace("voice-recorder", "voice%2Drecorder")}`;
        for (const link of [recording, encoded, partiallyEncoded]) {
          assert.equal(classifySpeakPipeLink(link).normalized_url, canonical, link);
        }
      }
    }
  }
  for (const link of [
    "https://www.speakpipe.com/voice-recorder/msg/",
    "https://www.speakpipe.com/voice-recorder#:~:text=https%3A//www.speakpipe.com/voice-recorder/msg/",
    highlighted.replace("www.speakpipe.com/voice-recorder#", "evil.example/voice-recorder#"),
    "https://www.speakpipe.com/voice-recorder#:~:text=https%3A%2F%2Fevil.example%2Fvoice-recorder%2Fmsg%2Fid",
    `${highlighted}&text=${encodeURIComponent(direct)}`,
    `${highlighted}%20another%20link`,
    `${highlighted}%ZZ`
  ]) assert.equal(classifySpeakPipeLink(link).valid, false, link);
});

test("a highlighted replacement saves the canonical link to the submission, asset, case and audit in one transaction", async () => {
  const row = remediationRow();
  const calls = [];
  const client = { async query(sql, params = []) {
    calls.push({sql, params});
    if (sql.includes("from speaking_link_remediation_cases c")) return {rows:[row]};
    if (sql.includes("insert into speaking_audio_link_registry")) return {rows:[{owner_student_id:row.student_id,owner_assignment_key:row.assignment_key}]};
    if (sql.includes("insert into audio_assets")) return {rows:[{id:"audio-1"}]};
    if (sql.includes("insert into ai_drafts")) return {rows:[{id:"draft-1"}]};
    if (sql.includes("update speaking_link_remediation_cases")) return {rows:[{...row,status:"LINK_CORRECTED",canonical_link:params[1],version:2}]};
    return {rows:[]};
  } };
  const result = await correctRemediationLink({token:"local-token",version:1,confirmation:"verified",corrected_link:highlighted}, {withSupabaseClient:callback=>callback(client)});
  assert.equal(result.case.canonical_link, direct);
  assert.deepEqual(calls.find(c=>c.sql.includes("update submission_inbox")).params, [row.submission_id,direct]);
  assert.equal(calls.find(c=>c.sql.includes("insert into audio_assets")).params[4], direct);
  assert.equal(calls.find(c=>c.sql.includes("insert into speaking_link_remediation_actions")).params[5], direct);
  assert.equal(calls.at(-1).sql, "commit");
});

test("the actual URL-encoded correction form preserves and saves the highlighted link",async()=>{
  let row=remediationRow();
  const client={async query(sql,params=[]){
    if(sql.includes("from speaking_link_remediation_cases c"))return{rows:[row]};
    if(sql.includes("insert into speaking_audio_link_registry"))return{rows:[{owner_student_id:row.student_id,owner_assignment_key:row.assignment_key}]};
    if(sql.includes("insert into audio_assets"))return{rows:[{id:"audio-1"}]};
    if(sql.includes("insert into ai_drafts"))return{rows:[{id:"draft-1"}]};
    if(sql.includes("update speaking_link_remediation_cases")){row={...row,status:"LINK_CORRECTED",canonical_link:params[1],version:2};return{rows:[row]};}
    return{rows:[]};
  }};
  const app=express();app.use(express.urlencoded({extended:false}));
  registerSpeakingLinkRemediationRoutes(app,{loadRemediationPage:async()=>row,correctRemediationLink:input=>correctRemediationLink(input,{withSupabaseClient:callback=>callback(client)})});
  const server=app.listen(0,"127.0.0.1");
  await new Promise((resolve,reject)=>{server.once("listening",resolve);server.once("error",reject);});
  try{
    const body=new URLSearchParams({token:"local-token",version:"1",confirmation:"verified",corrected_link:highlighted}).toString();
    const response=await new Promise((resolve,reject)=>{
      const req=request({hostname:"127.0.0.1",port:server.address().port,path:"/api/speaking-link-remediation/correct",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(body)}},res=>{
        let html="";res.setEncoding("utf8");res.on("data",part=>{html+=part;});res.on("end",()=>resolve({status:res.statusCode,html}));
      });req.on("error",reject);req.end(body);
    });
    assert.equal(response.status,200);assert.equal(row.canonical_link,direct);assert.equal(row.version,2);
    assert.match(response.html,/Saved decision: use the corrected recording link/);
    assert.doesNotMatch(response.html,/Detected issue:/);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

test("the resolved page shows the saved decision on reopening and keeps original issues historical", async () => {
  for (const status of ["LINK_CORRECTED", "RESOLVED_WITHOUT_SPEAKING"]) {
    const row = remediationRow({status,version:2,canonical_link:status==="LINK_CORRECTED"?direct:null,resolved_at:"2026-10-02T05:43:53Z",has_final_feedback:true});
    const {routes,res}=routeHarness(row);
    await routes["GET /api/speaking-link-remediation"]({query:{token:"local-token"}},res);
    assert.match(res.body,/Saved decision:/);
    assert.match(res.body,/Decision saved at:/);
    assert.match(res.body,/Original issue — historical/);
    assert.doesNotMatch(res.body,/Detected issue:/);
    assert.doesNotMatch(res.body,/<form/);
    assert.match(res.body,status==="LINK_CORRECTED"?/use the corrected recording link/:/continue without speaking/);
  }
});

test("editable resolutions permit a corrected recording without repeating the resolve action", async () => {
  const {routes,res}=routeHarness(remediationRow({status:"RESOLVED_WITHOUT_SPEAKING",version:2}));
  await routes["GET /api/speaking-link-remediation"]({query:{token:"local-token"}},res);
  assert.match(res.body,/action="\/api\/speaking-link-remediation\/correct"/);
  assert.doesNotMatch(res.body,/action="\/api\/speaking-link-remediation\/resolve"/);
});

test("the page uses the backend storage and draft restrictions when offering replacement", async () => {
  for (const state of [
    {audio_asset_id:"audio-1",audio_status:"READY_FOR_STORAGE",stored_drive_file_id:"drive-1"},
    {audio_asset_id:"audio-1",audio_status:"READY_FOR_STORAGE",speaking_draft_id:"draft-1",speaking_draft_status:"TRANSCRIBING"}
  ]) {
    const {routes,res}=routeHarness(remediationRow({status:"LINK_CORRECTED",canonical_link:direct,...state}));
    await routes["GET /api/speaking-link-remediation"]({query:{token:"local-token"}},res);
    assert.doesNotMatch(res.body,/<form/);
  }
});

test("a rejected replacement preserves the input and explicitly says that no correction was saved", async () => {
  const {routes,res}=routeHarness(remediationRow(),{correctRemediationLink:async()=>{throw Object.assign(new Error(issue),{httpStatus:400});}});
  await routes["POST /api/speaking-link-remediation/correct"]({body:{token:"local-token",corrected_link:"https://www.speakpipe.com/voice-recorder"}},res);
  assert.equal(res.statusCode,400);
  assert.match(res.body,/Correction not saved/);
  assert.match(res.body,/value="https:\/\/www.speakpipe.com\/voice-recorder"/);
  assert.match(res.body,/<form/);
});

test("successful correction output reports the saved link without a current incomplete-link warning", async () => {
  const {routes,res}=routeHarness(remediationRow({status:"LINK_CORRECTED",canonical_link:direct,audio_asset_id:"audio-1",audio_status:"READY_FOR_STORAGE"}),{correctRemediationLink:async()=>({ok:true})});
  await routes["POST /api/speaking-link-remediation/correct"]({body:{token:"local-token",corrected_link:highlighted}},res);
  assert.equal(res.statusCode,200);
  assert.match(res.body,/The corrected link was accepted/);
  assert.match(res.body,/Saved decision: use the corrected recording link/);
  assert.doesNotMatch(res.body,/Detected issue:/);
});

test("group topic preparation binds a consistent smallint count for zero through three reused topics", async () => {
  for (const reusedCount of [0, 1, 2, 3]) {
    const calls = [];
    const client = { async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("insert into speaking_topic_cycles")) return { rows: [{ id: "cycle-1", status: "OPEN" }] };
      if (sql.includes("with active_enrolments")) return { rows: [{ id: "enrollment-1", student_id: "student-1", student_type: "group", full_name: "Learner", approved_summary: "Approved", current_level: "B1" }] };
      if (sql.includes("insert into speaking_topic_targets")) return { rows: [{ id: "target-1", student_id: "student-1", target_type: "group", status: "PENDING", curriculum_snapshot: { level: "B1" } }] };
      if (sql.includes("select progress.topic_id")) return { rows: Array.from({ length: reusedCount }, (_, index) => ({ topic_id: `topic-${index + 1}` })) };
      if (sql.includes("set requested_topic_count")) return { rows: [{ id: "target-1", requested_topic_count: params[1] }] };
      return { rows: [] };
    } };
    await ensureSpeakingCycle({ cycleDate: "2026-10-02", cycleDay: "FRIDAY" }, { withSupabaseClient: callback => callback(client) });
    const update = calls.find(call => call.sql.includes("set requested_topic_count"));
    assert.deepEqual(update.params, ["target-1", 3 - reusedCount]);
    // The database column is smallint. Guard every occurrence against the
    // untyped assignment/comparison conflict that caused PostgreSQL 42P08.
    assert.equal((update.sql.match(/\$2::smallint/g) || []).length, 2);
    assert.doesNotMatch(update.sql, /\$2(?!::smallint)/);
    assert.match(update.sql, /case when \$2::smallint=0::smallint then 'READY' else 'PENDING'/);
    const mappings = calls.filter(call => call.sql.includes("insert into speaking_group_cycle_topics"));
    assert.deepEqual(mappings.map(call => call.params[2]), Array.from({ length: reusedCount }, (_, index) => index + 1));
    assert.equal(calls.at(-1).sql, "commit");
  }
});

test("a new cycle with three carried topics is persisted and duplicate execution creates no second target", async () => {
  let cycleExists=false, targetExists=false, targets=0, mappings=0, requested=null;
  const client={async query(sql,params=[]){
    if(sql.includes("insert into speaking_topic_cycles")){cycleExists=true;return{rows:[{id:"cycle-1",status:"OPEN"}]};}
    if(sql.includes("with active_enrolments"))return{rows:[{id:"enrollment-1",student_id:"student-1",student_type:"group",full_name:"Learner",approved_summary:"Approved",profile_approved_at:"2026-09-01T00:00:00Z",current_level:"B1"}]};
    if(sql.includes("insert into speaking_topic_targets")){
      if(targetExists)return{rows:[]};
      assert.equal(cycleExists,true);targetExists=true;targets++;
      return{rows:[{id:"target-1",student_id:"student-1",target_type:"group",status:"PENDING",curriculum_snapshot:{level:"B1"}}]};
    }
    if(sql.includes("select progress.topic_id"))return{rows:[1,2,3].map(id=>({topic_id:`topic-${id}`}))};
    if(sql.includes("insert into speaking_group_cycle_topics"))mappings++;
    if(sql.includes("set requested_topic_count")){requested=params[1];return{rows:[{id:"target-1",status:"READY",requested_topic_count:requested}]};}
    return{rows:[]};
  }};
  const dependencies={withSupabaseClient:callback=>callback(client)};
  await ensureSpeakingCycle({cycleDate:"2026-10-02",cycleDay:"FRIDAY"},dependencies);
  await ensureSpeakingCycle({cycleDate:"2026-10-02",cycleDay:"FRIDAY"},dependencies);
  assert.equal(targets,1);assert.equal(mappings,3);assert.equal(requested,0);
});

test("a reuse failure rolls back target preparation while retaining a cycle with an actionable error", async () => {
  const calls=[];
  const client={async query(sql){
    calls.push(sql);
    if(sql.includes("insert into speaking_topic_cycles"))return{rows:[{id:"cycle-1"}]};
    if(sql.includes("with active_enrolments"))return{rows:[{id:"enrollment-1",student_id:"student-1",student_type:"group",full_name:"Learner",approved_summary:"Approved",profile_approved_at:"2026-09-01T00:00:00Z",current_level:"B1"}]};
    if(sql.includes("insert into speaking_topic_targets"))return{rows:[{id:"target-1",student_id:"student-1",target_type:"group",status:"PENDING",curriculum_snapshot:{level:"B1"}}]};
    if(sql.includes("select progress.topic_id"))throw Object.assign(new Error("synthetic database failure"),{code:"XX000"});
    return{rows:[]};
  }};
  await assert.rejects(ensureSpeakingCycle({cycleDate:"2026-10-02",cycleDay:"FRIDAY"},{withSupabaseClient:callback=>callback(client)}),error=>error.cycleId==="cycle-1"&&error.message.includes("synthetic database failure"));
  assert(calls.indexOf("begin")>calls.findIndex(sql=>sql.includes("insert into speaking_topic_cycles")));
  assert(calls.includes("rollback"));
  assert(calls.at(-1).includes("last_error_code='CYCLE_INITIALIZATION_FAILED'"));
});

const runtimeEnvironment={DEEPSEEK_API_KEY:"local-test-only",SCHEDULER_TIMEZONE:"Africa/Douala",SPEAKING_TOPIC_PIPELINE_ENABLED:"true",SPEAKING_PROFILE_FORM_URL:"https://example.test/profile",PDFMONKEY_SPEAKING_TEACHER_TEMPLATE_ID:"template-1",SPEAKING_GROUP_B1_TEACHER_EMAILS:"teacher@example.test"};

test("reused topics still produce a teacher PDF and bundle without calling DeepSeek",async()=>withEnvironment(runtimeEnvironment,async()=>{
  let job=null, pdfCalls=0, generationCalls=0, bundleCalls=0, emailQueues=0;
  const cycle={id:"cycle-1",cycle_date:"2026-10-02",cycle_day:"FRIDAY"};
  const row={id:"target-1",full_name:"Learner",target_type:"group",level:"B1",status:"READY",curriculum_snapshot:{level:"B1",module:"1"}};
  const topics=[1,2,3].map(position=>({id:`existing-topic-${position}`,target_id:row.id,position,title:`Reused ${position}`,learner_content:{heading:"Scenario",body:"Discuss your choice.",points:["Explain why."]},teacher_sections:[{heading:"Teacher",items:["Why?"]}]}));
  const repository={
    ensureSpeakingCycle:async()=>({cycle}),listOpenCycles:async()=>[cycle],recoverStaleGenerationAttempts:async()=>({}),claimGenerationBatch:async()=>({targets:[]}),
    queueDueGroupEmails:async()=>{emailQueues++;return{queued:1};},groupEmailsComplete:async()=>true,loadDocumentCandidates:async()=>[row],clearCycleRoutingError:async()=>{},
    createDocumentJob:async plan=>{job={id:"job-1",document_scope:plan.scope,audience_snapshot:plan.audience,part_number:1,total_parts:1};return job;},
    markCycleCompletedIfDone:async()=>{},listPendingDocumentJobs:async()=>job?[job]:[],loadDocumentJobBundle:async()=>({job,cycle,rows:[row],topics}),
    updateDocumentJob:async(id,updates)=>({...job,status:updates.status}),queueReadyTeacherDocumentBundles:async()=>{bundleCalls++;return{queued:1};}
  };
  const result=await runSpeakingPipelineOnce({now:new Date("2026-10-02T08:00:00Z"),dependencies:{repository,generateSpeakingTopics:async()=>{generationCalls++;throw new Error("must not generate reused topics");},createPdfMonkeyDocument:async payload=>{pdfCalls++;assert.equal(payload.sections[0].entries[0].topics.length,3);return{document_id:"pdf-1"};},waitForPdfMonkeyDocument:async()=>({status:"success",download_url:"https://example.test/pdf"}),uploadPdfUrlToGoogleDrive:async()=>({drive_file_id:"drive-1",drive_url:"https://example.test/drive"})}});
  assert.equal(generationCalls,0);assert.equal(pdfCalls,1);assert.equal(bundleCalls,1);assert.equal(emailQueues,1);assert.equal(result.documents[0].status,"PDF_READY");
}));

test("an existing cycle continues on Tuesday and waits for all student emails before document creation",async()=>withEnvironment(runtimeEnvironment,async()=>{
  let ensureCalls=0;
  const cycle={id:"cycle-1",cycle_date:"2026-09-28",cycle_day:"MONDAY"};
  const repository={ensureSpeakingCycle:async()=>{ensureCalls++;},listOpenCycles:async()=>[cycle],recoverStaleGenerationAttempts:async()=>({}),claimGenerationBatch:async()=>({targets:[]}),queueDueGroupEmails:async()=>({}),groupEmailsComplete:async()=>false,markCycleCompletedIfDone:async()=>{},listPendingDocumentJobs:async()=>[]};
  const result=await runSpeakingPipelineOnce({now:new Date("2026-09-29T09:00:00Z"),dependencies:{repository}});
  assert.equal(ensureCalls,0);assert.equal(result.cycles.length,1);assert.equal(result.cycles[0].group_documents.blocked,"WAITING_FOR_ALL_GROUP_EMAILS");
}));

test("failed or interrupted target initialisation is retried on a non-cycle day",async()=>withEnvironment(runtimeEnvironment,async()=>{
  const initialisations=[];
  const cycle={id:"cycle-1",cycle_date:"2026-09-28",cycle_day:"MONDAY",last_error_code:"CYCLE_INITIALIZATION_FAILED"};
  const repository={ensureSpeakingCycle:async input=>{initialisations.push(input);},listOpenCycles:async()=>[cycle],recoverStaleGenerationAttempts:async()=>({}),claimGenerationBatch:async()=>({targets:[]}),queueDueGroupEmails:async()=>({}),groupEmailsComplete:async()=>false,markCycleCompletedIfDone:async()=>{},listPendingDocumentJobs:async()=>[]};
  await runSpeakingPipelineOnce({now:new Date("2026-09-29T09:00:00Z"),dependencies:{repository}});
  cycle.last_error_code="CYCLE_INITIALIZATION_PENDING";
  await runSpeakingPipelineOnce({now:new Date("2026-09-29T09:00:00Z"),dependencies:{repository}});
  assert.deepEqual(initialisations,[{cycleDate:"2026-09-28",cycleDay:"MONDAY"},{cycleDate:"2026-09-28",cycleDay:"MONDAY"}]);
}));

test("a provider configuration failure leaves the scheduled cycle created",async()=>withEnvironment({...runtimeEnvironment,DEEPSEEK_API_KEY:undefined},async()=>{
  let created=0;
  await assert.rejects(runSpeakingPipelineOnce({now:new Date("2026-10-02T08:00:00Z"),dependencies:{repository:{ensureSpeakingCycle:async()=>{created++;}}}}),/Missing DEEPSEEK_API_KEY/);
  assert.equal(created,1);
}));

test("audio model selection is dynamic and consistent with diagnostics and uncapped request bodies",async()=>withEnvironment({DATABASE_URL:"postgres://unused-local-test",OPENAI_SPEAKING_AUDIO_MODEL:" gpt-audio-mini ",OPENAI_SPEAKING_AUDIO_FALLBACK_MODEL:"gpt-audio-mini",OPENAI_AUDIO_FEEDBACK_MODEL:undefined,OPENAI_AUDIO_FEEDBACK_FALLBACK_MODEL:undefined},async()=>{
  assert.deepEqual(getSpeakingAudioModels(),{model:"openai/gpt-audio-mini",fallbackModel:"openai/gpt-audio-mini"});
  assert.equal(getConfig().openrouter.audioFeedbackModel,"openai/gpt-audio-mini");
  const body=buildSpeakingCorrectionChatCompletionBody({audioBuffer:Buffer.from("mock-audio"),transcriptText:"I speak English.",speakingPrompt:"Introduce yourself."});
  assert.equal(body.model,"openai/gpt-audio-mini");
  for(const key of ["max_tokens","max_completion_tokens","max_output_tokens"])assert.equal(key in body,false);
  delete process.env.OPENAI_SPEAKING_AUDIO_MODEL;
  assert.equal(getSpeakingAudioModels().model,"openai/gpt-4o-audio-preview");
}));

test("an unavailable mini model does not silently escalate to a full audio model",async()=>withEnvironment({OPENAI_SPEAKING_AUDIO_MODEL:"gpt-audio-mini",OPENAI_SPEAKING_AUDIO_FALLBACK_MODEL:"openai/gpt-audio-mini",OPENROUTER_API_KEY:"local-test-only"},async()=>{
  const oldFetch=globalThis.fetch;const models=[];
  globalThis.fetch=async(_url,options)=>{models.push(JSON.parse(options.body).model);return{ok:false,status:404,text:async()=>JSON.stringify({error:{message:"model_not_found"}})};};
  try {
    await assert.rejects(generateJeaSpeakingCorrectionFromAudioWithOpenAi({audioBuffer:Buffer.from("mock-audio"),transcriptText:"I speak English.",speakingPrompt:"Introduce yourself."}),/all configured audio models/);
    assert.deepEqual(models,["openai/gpt-audio-mini"]);
  }finally{globalThis.fetch=oldFetch;}
}));

test("a retry reuses its completed transcript without downloading audio or paying for transcription again",async()=>{
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error("No provider call is permitted for a completed transcript");};
  const calls=[];
  const draft={id:"draft-1",submission_id:"submission-1",student_id:"student-1",assignment_key:"B1_M1_U2_D2_ASSIGNMENT",audio_asset_id:"audio-1",stored_drive_file_id:"drive-existing",existing_transcript_id:"transcript-1",existing_transcript:"I am learning English.",existing_transcript_status:"COMPLETED"};
  try{
    const result=await processTranscriptionOne({dependencies:{claimSpeakingDraft:async()=>draft,findDeliveredWritingCorrection:async()=>null,withSupabaseClient:callback=>callback({query:async(sql)=>{calls.push(sql);return{rows:[]};}})}});
    assert.equal(result.status,"TRANSCRIPTION_REUSED");
    assert.equal(result.transcript_id,"transcript-1");
    assert(calls.some(sql=>sql.includes("status = 'TRANSCRIBED'")));
    assert.equal(calls.some(sql=>/insert into transcripts|update transcripts/.test(sql)),false);
  }finally{globalThis.fetch=oldFetch;}
});

test("a successfully saved correction is not reported as unsaved when the page reload fails",async()=>{
  const {routes,res}=routeHarness(remediationRow(),{correctRemediationLink:async()=>({ok:true}),loadRemediationPage:async()=>{throw new Error("synthetic read failure");}});
  await routes["POST /api/speaking-link-remediation/correct"]({body:{token:"local-token",corrected_link:direct}},res);
  assert.equal(res.statusCode,503);
  assert.match(res.body,/The corrected link was saved/);
  assert.doesNotMatch(res.body,/Correction not saved/);
});

test("two submissions sharing a stored recording reuse the same Drive file without downloading or uploading",async()=>{
  const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error("No provider call is permitted during stored-file reuse");};
  const columns=["id","submission_id","student_id","task_id","source_url","stored_drive_file_id","stored_drive_url","status","storage_attempt_count","created_at","updated_at","notes"];
  let nextSubmission=1;const calls=[];
  const client={async query(sql,params=[]){
    calls.push(sql);
    if(sql.includes("information_schema.tables"))return{rowCount:1,rows:[{}]};
    if(sql.includes("information_schema.columns"))return{rows:columns.map(column_name=>({column_name}))};
    if(sql.includes("s.full_name as student_name"))return{rows:[{id:`audio-${nextSubmission}`,submission_id:`submission-${nextSubmission++}`,student_id:"student-1",task_id:"task-1",source_url:highlighted,status:"READY_FOR_STORAGE"}]};
    if(sql.includes("select * from speaking_audio_link_registry"))return{rows:[{canonical_source_url:direct,stored_drive_file_id:"drive-existing",stored_drive_url:"https://example.test/audio",mime_type:"audio/mpeg"}]};
    if(sql.startsWith("update audio_assets"))return{rows:[{id:params[0]}]};
    if(sql.includes("update speaking_audio_link_registry"))return{rows:[{canonical_source_url:direct,stored_drive_file_id:params[1]}]};
    return{rows:[]};
  }};
  try {
    for(let index=0;index<2;index++){
      const result=await storeOneAudioAssetInDrive({dependencies:{withSupabaseClient:callback=>callback(client)}});
      assert.equal(result.storage_provider,"REUSED_EXISTING_AUDIO_ASSET");assert.equal(result.drive.drive_file_id,"drive-existing");assert.equal(result.source_url,direct);
    }
    assert.equal(calls.filter(sql=>sql.includes("where canonical_source_url=$1")&&sql.includes("for update")).length,2);
  }finally{globalThis.fetch=oldFetch;}
});
