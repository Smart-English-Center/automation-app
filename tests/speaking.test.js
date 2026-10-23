import test from "node:test";
import assert from "node:assert/strict";
import { getSpeakingConfig, localParts, normaliseSpeakingCycleDate, speakingScheduledInstant, timeReached } from "../src/speaking/config.js";
import { buildSpeakingTopicRequestBody, validateGeneratedIelts, validateGeneratedTarget } from "../src/speaking/prompt.js";
import { buildProfileSummaryRequestBody } from "../src/speaking/deepseekClient.js";
import { renderGroupTopicsEmail, renderTeacherMaterialEmail, topicWhatsAppMessage } from "../src/speaking/emailRenderer.js";
import { assertTeacherPdfPayload, buildTeacherPdfPayload } from "../src/speaking/pdfPayload.js";
import { planGroupTeacherDocuments, teacherDocumentFilename } from "../src/speaking/pipeline.js";
import { assignedTeacherDocumentReadiness } from "../src/speaking/readiness.js";
import { assertContentfulPdfBuffer } from "../src/google/driveClient.js";
import { storeRenderedQueuedEmailContent } from "../src/supabase/emailQueueRepository.js";
import { buildTeacherBundleQueuePayload, buildTeacherRecipientBundles, canonicalTeacherBundleCycleDate, loadGrammarCatalogue } from "../src/supabase/speakingTopicRepository.js";
import { registerSpeakingRoutes } from "../src/routes/speakingRoutes.js";
import { decryptReviewPayload, encryptReviewPayload } from "../src/speakingProfile/security.js";
import fs from "node:fs";

test("speaking times are environment-controlled and reuse scheduler timezone",()=>{
  const previous={...process.env};
  Object.assign(process.env,{SCHEDULER_TIMEZONE:"Africa/Douala",SPEAKING_CYCLE_CUTOFF_TIME:"01:15",SPEAKING_STUDENT_EMAIL_TIME:"04:30",SPEAKING_TEACHER_DOCUMENT_TIME:"06:45"});
  const config=getSpeakingConfig();
  assert.equal(config.timezone,"Africa/Douala");assert.equal(config.cycleCutoffTime,"01:15");assert.equal(config.studentEmailTime,"04:30");assert.equal(config.teacherDocumentTime,"06:45");
  assert.equal(timeReached("04:29",config.studentEmailTime),false);assert.equal(timeReached("04:30",config.studentEmailTime),true);
  process.env=previous;
});

test("DeepSeek topic and profile requests enable thinking and omit token caps",()=>{
  const common={model:"deepseek-v4-pro",thinkingMode:"enabled",reasoningEffort:"high"};
  const topic=buildSpeakingTopicRequestBody({...common,targets:[],grammarCatalogue:[]});
  const profile=buildProfileSummaryRequestBody({...common,answers:[]});
  for(const body of [topic,profile]){assert.equal(body.thinking.type,"enabled");assert.equal(body.thinking.reasoning_effort,"high");assert.equal(body.stream,false);assert.equal("max_tokens" in body,false);assert.equal("max_completion_tokens" in body,false);}
});

test("group validation enforces three independent compact outputs and derives database display labels",()=>{
  const target={id:"target-1",target_type:"group",curriculum_snapshot:{level:"A1",module:"3"}};
  const make=(i,theme)=>({title:`Topic ${i}`,learner_content:{body:"A complete scenario",points:["1","2","3","4"]},teacher_questions:["1","2","3","4","5"],theme_code:theme,situation_slug:`situation_${i}`,outcome_code:"CHOOSE"});
  const result=validateGeneratedTarget(target,{target_id:"target-1",topics:[make(1,"WORK"),make(2,"DAILY_LIFE"),make(3,"WORK")]});
  assert.equal(result.ok,true);assert.equal(result.topics.length,3);
  assert.deepEqual(result.topics[0].learner_content,{heading:"Scenario",body:"A complete scenario",points_heading:"Points à mentionner",points:["1","2","3","4"]});
});

test("private validation requires ten topics and seven questions each",()=>{
  const target={id:"private-1",target_type:"private",curriculum_snapshot:{level:"A2",module:"1"}};
  const topics=Array.from({length:10},(_,i)=>({title:`Topic ${i+1}`,learner_content:{body:"Level-adjusted scenario",points:[]},teacher_questions:Array.from({length:7},(_,q)=>`Question ${q+1}`),theme_code:"DAILY_LIFE",situation_slug:`private_${i+1}`,outcome_code:"EXPLAIN"}));
  topics.forEach((topic)=>{topic.learner_content.points=["A discussion point"];});
  const result=validateGeneratedTarget(target,{target_id:target.id,topics});
  assert.equal(result.ok,true);
  assert.equal(result.topics[0].learner_content.points_heading,"Discussion points");
});

test("topic validation rejects empty discussion points before Supabase insertion",()=>{
  const target={id:"target-empty",target_type:"group",curriculum_snapshot:{level:"A2",module:"1"}};
  const make=(i,points)=>({title:`Topic ${i}`,learner_content:{body:"A complete scenario",points},teacher_questions:["Question"],theme_code:i===1?"WORK":"DAILY_LIFE",situation_slug:`empty_${i}`,outcome_code:"EXPLAIN"});
  const result=validateGeneratedTarget(target,{target_id:target.id,topics:[make(1,[]),make(2,["Point"]),make(3,["Point"])]});
  assert.equal(result.ok,false);
  assert.match(result.errors.join("; "),/requires non-empty discussion points/);
});

test("discussion-point guidance is prompt-driven without action-verb validation",()=>{
  const target={id:"target-guidance",target_type:"group",curriculum_snapshot:{level:"A2",module:"1"}};
  const make=(i,theme)=>({title:`Topic ${i}`,learner_content:{body:"A complete scenario",points:["A neutral discussion focus"]},teacher_questions:["What would you like to say about it?"],theme_code:theme,situation_slug:`guidance_${i}`,outcome_code:"EXPLAIN"});
  const result=validateGeneratedTarget(target,{target_id:target.id,topics:[make(1,"WORK"),make(2,"DAILY_LIFE"),make(3,"WORK")]});
  assert.equal(result.ok,true);
  const request=buildSpeakingTopicRequestBody({targets:[target],grammarCatalogue:[]});
  const prompt=request.messages[0].content;
  assert.match(prompt,/Discussion points are guidance about what the learner should discuss/);
  assert.match(prompt,/They are not sample answers/);
  assert.match(prompt,/Every discussion point must have at least one teacher question/);
  assert.match(prompt,/As the learner advances through the curriculum, scenarios may become more developed and support longer conversations/);
  assert.match(prompt,/do not force every known grammar point into a topic/);
});

test("IELTS validation enforces official three-part shape",()=>{
  const sets=Array.from({length:10},(_,i)=>({title:`Set ${i+1}`,part_1:[{subtopic:"Home",questions:["1","2","3"]},{subtopic:"Work",questions:["1","2","3"]}],part_2:{prompt:"Describe a place you enjoy.",points:["where","when","what","why"]},part_2_follow_ups:["One?","Two?"],part_3:["1","2","3","4","5"]}));
  assert.equal(validateGeneratedIelts({sets}).ok,true);
});

test("student email includes learner content but never teacher questions",()=>{
  const target={student_name:"Awa",topic_response_url:"https://worker.example/api/speaking-topic-response?token=test",curriculum_snapshot:{level:"A2",module:"2"},topics:[{title:"A decision",learner_content:{body:"Choose a practical option.",points:["Compare the options."]},teacher_sections:[{heading:"Teacher questions",items:["PRIVATE TEACHER QUESTION"]}]}]};
  const rendered=renderGroupTopicsEmail(target);assert.match(rendered.text,/Choose a practical option/);assert.doesNotMatch(rendered.text,/PRIVATE TEACHER QUESTION/);
  assert.match(rendered.text,/Update my speaking topics/);
  assert.match(rendered.html,/speaking-topic-response/);
});

test("WhatsApp message uses the approved bold signature",()=>{
  const message=topicWhatsAppMessage({topic:{title:"Topic",learner_content:{body:"Speak freely.",points:[]}},curriculum:{level:"A2",module:1}});
  assert.match(message,/\*The John’s English Academy Team\*/);
});

test("review payload encryption round-trips without database storage",()=>{
  process.env.SPEAKING_PROFILE_PAYLOAD_ENCRYPTION_KEY="a secure test encryption key with more than 32 characters";
  const input={event_id:"event-1",answers:[{question:"Goal",answer:"Speak freely"}]};
  const encrypted=encryptReviewPayload(input);assert.doesNotMatch(encrypted,/Speak freely/);assert.deepEqual(decryptReviewPayload(encrypted),input);
});

test("profile review service binds the encrypted answers to the review event",()=>{
  const source=fs.readFileSync(new URL("../src/speakingProfile/service.js",import.meta.url),"utf8");
  assert.match(source,/hashEventId\(context\.event_id\) !== review\.event_id_hash/);
  assert.match(source,/context\.verified_email/);
});

test("profile cancellation discards the receipt and deletes all temporary review data",()=>{
  const repository=fs.readFileSync(new URL("../src/speakingProfile/repository.js",import.meta.url),"utf8");
  const service=fs.readFileSync(new URL("../src/speakingProfile/service.js",import.meta.url),"utf8");
  const discardIndex=repository.indexOf("set status='discarded', resolved_at=now()");
  const deleteIndex=repository.indexOf("delete from speaking_profile_reviews where id=$1",discardIndex);
  assert.ok(discardIndex>=0);
  assert.ok(deleteIndex>discardIndex);
  assert.match(repository,/select id,event_id_hash from speaking_profile_reviews where id=\$1 for update/);
  assert.match(service,/clean\(confirmation\) !== "discard"/);
  assert.match(service,/repository\.discardAndDeleteReview/);
});

test("every profile review page exposes a confirmed cancellation route",()=>{
  const source=fs.readFileSync(new URL("../src/routes/speakingProfileRoutes.js",import.meta.url),"utf8");
  assert.match(source,/Cancel and discard request/);
  assert.match(source,/\/api\/speaking-profiles\/review\/cancel\/confirm/);
  assert.match(source,/\/api\/speaking-profiles\/review\/cancel/);
  assert.match(source,/hidden\("confirmation","discard"\)/);
});

test("Douala local date calculation is deterministic",()=>{
  const parts=localParts(new Date("2026-09-06T23:05:00Z"),"Africa/Douala");
  assert.deepEqual(parts,{date:"2026-09-07",weekday:"MONDAY",time:"00:05"});
});

test("speaking cycle dates accept PostgreSQL Date values without producing invalid timestamps",()=>{
  const dateValue=new Date("2026-09-07T00:00:00.000Z");
  assert.equal(normaliseSpeakingCycleDate(dateValue,"Africa/Douala"),"2026-09-07");
  assert.equal(normaliseSpeakingCycleDate("2026-09-07","Africa/Douala"),"2026-09-07");
  assert.equal(speakingScheduledInstant(dateValue,"04:00","Africa/Douala").toISOString(),"2026-09-07T03:00:00.000Z");
});

test("teacher bundle payload uses PostgreSQL canonical cycle date instead of stringifying Date objects",()=>{
  const postgresDate=new Date("2026-09-14T00:00:00.000Z");
  const cycle={cycle_date:postgresDate,cycle_date_iso:"2026-09-14"};
  assert.equal(canonicalTeacherBundleCycleDate(cycle),"2026-09-14");
  assert.equal(canonicalTeacherBundleCycleDate({cycle_date:"2026-09-14",cycle_date_iso:"2026-09-14"}),"2026-09-14");
  const payload=buildTeacherBundleQueuePayload({
    cycle,
    cycleId:"dab16059-893c-4e59-b6b5-13849ef5b381",
    bundle:{recipient_email:"teacher@example.com",recipient_name:"Teacher",documents:[{job_id:"job-1"}]}
  });
  assert.equal(payload.cycle_date,"2026-09-14");
  assert.doesNotMatch(payload.cycle_date,/Mon Sep 14/);
  assert.throws(()=>canonicalTeacherBundleCycleDate({cycle_date:postgresDate,cycle_date_iso:"Mon Sep 14"}),/canonical YYYY-MM-DD/);
  assert.throws(()=>canonicalTeacherBundleCycleDate({cycle_date:postgresDate}),/canonical YYYY-MM-DD/);
  assert.throws(()=>canonicalTeacherBundleCycleDate({cycle_date_iso:"2026-02-31"}),/canonical YYYY-MM-DD/);
});

test("speaking email queue uses the delivery record as its source",()=>{
  const source=fs.readFileSync(new URL("../src/supabase/speakingTopicRepository.js",import.meta.url),"utf8");
  assert.match(source,/\[scheduledFor,sourceType,delivery\.id,row\.student_email/);
  assert.match(source,/from speaking_topic_email_deliveries d\s+join speaking_topic_targets t on t\.id=d\.target_id/);
  assert.match(source,/where target_id=\$1 order by position",\[target\.id\]/);
  assert.doesNotMatch(source,/where target_id=\$1 order by position",\[sourceId\]/);
});

test("rendered speaking email content is stored before delivery",async()=>{
  let statement="";let values=[];
  const stored=await storeRenderedQueuedEmailContent({emailId:"00000000-0000-0000-0000-000000000001",subject:"Speaking topics",bodyHtml:"<p>Topic</p>",bodyText:"Topic"},{withSupabaseClient:async(callback)=>callback({query:async(sql,params)=>{statement=sql;values=params;return{rows:[{id:params[0],subject:params[1],body_html:params[2],body_text:params[3]}]};}})});
  assert.match(statement,/set subject=\$2,body_html=\$3,body_text=\$4/);
  assert.match(statement,/status='SENDING'/);
  assert.deepEqual(values.slice(1),["Speaking topics","<p>Topic</p>","Topic"]);
  assert.equal(stored.body_text,"Topic");
});

test("teacher payload validation rejects missing entries and topic loss",()=>{
  assert.throws(()=>assertTeacherPdfPayload({document:{title:"Teacher materials"},sections:[]},{expectedTargetCount:1,expectedTopicCount:1}),/no sections/);
  const payload={document:{title:"Teacher materials"},sections:[{entries:[{name:"Student",topics:[{title:"Topic",learner_content:{heading:"Scenario",body:"Discuss a plan."}}],whatsapp_actions:[]}]}]};
  assert.deepEqual(assertTeacherPdfPayload(payload,{expectedTargetCount:1,expectedTopicCount:1}),{sectionCount:1,entryCount:1,topicCount:1});
  assert.throws(()=>assertTeacherPdfPayload(payload,{expectedTargetCount:1,expectedTopicCount:2}),/topic count mismatch/);
});

test("speaking teacher PDF validation rejects the observed blank PDF pattern",()=>{
  const observedBlank=Buffer.from("%PDF-1.4\n3 0 obj\n<</Length 0>> stream\nendstream\nendobj\n2 0 obj\n<</Type /Page /Contents 3 0 R>>\nendobj\n%%EOF");
  assert.throws(()=>assertContentfulPdfBuffer(observedBlank,{minBytes:100}),/zero-length page content streams/);
  assert.throws(()=>assertContentfulPdfBuffer(Buffer.from("%PDF-1.4\n%%EOF"),{minBytes:2048}),/appears blank or incomplete/);
  const validLooking=Buffer.concat([Buffer.from("%PDF-1.4\n3 0 obj\n<</Length 12>> stream\nHello world!\nendstream\nendobj\n2 0 obj\n<</Type /Page /Contents 3 0 R>>\nendobj\n"),Buffer.alloc(2200,32),Buffer.from("\n%%EOF")]);
  assert.doesNotThrow(()=>assertContentfulPdfBuffer(validLooking,{minBytes:2048}));
});

test("a group teacher document completes only after every recipient email is sent",()=>{
  const source=fs.readFileSync(new URL("../src/supabase/emailQueueRepository.js",import.meta.url),"utf8");
  assert.match(source,/sibling\.source_type='SPEAKING_TEACHER_MATERIALS'/);
  assert.match(source,/payload_json->'document_job_ids'/);
  assert.match(source,/sibling\.status<>'SENT'/);
});

test("an assigned-teacher document waits for every private and required IELTS topic",()=>{
  assert.deepEqual(assignedTeacherDocumentReadiness({
    privateRows:[{id:"private-1",status:"READY"},{id:"private-2",status:"RETRY_WAIT"}],
    ieltsStudents:[]
  }),{
    ready:false,
    pending_private_target_ids:["private-2"],
    waiting_for_ielts:false
  });
  assert.deepEqual(assignedTeacherDocumentReadiness({
    privateRows:[{id:"private-1",status:"READY"}],
    ieltsStudents:[{full_name:"IELTS Student"}],
    ielts:{id:"ielts-shared",status:"GENERATING"}
  }),{
    ready:false,
    pending_private_target_ids:[],
    waiting_for_ielts:true
  });
  assert.equal(assignedTeacherDocumentReadiness({
    privateRows:[{id:"private-1",status:"READY"}],
    ieltsStudents:[{full_name:"IELTS Student"}],
    ielts:{id:"ielts-shared",status:"READY"}
  }).ready,true);
});

test("assigned-teacher documents no longer create pending supplements",()=>{
  const source=fs.readFileSync(new URL("../src/speaking/pipeline.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/pending_names|ielts_pending|A supplement will follow/);
  assert.match(source,/if\(!readiness\.ready\)/);
  assert.match(source,/WAITING_FOR_COMPLETE_DOCUMENT_SET/);
});

test("unknown lesson keys use the end of the first week instead of the whole level",()=>{
  const source=fs.readFileSync(new URL("../src/supabase/speakingTopicRepository.js",import.meta.url),"utf8");
  assert.match(source,/first_week_bounds as/);
  assert.match(source,/max\(gc\.lesson_order\) max_order/);
  assert.match(source,/regexp_replace\(coalesce\(gc\.module::text,''\),'\[\^0-9\]','','g'\)='1'/);
  assert.match(source,/regexp_replace\(coalesce\(gc\.unit::text,''\),'\[\^0-9\]','','g'\)='1'/);
  assert.doesNotMatch(source,/min\(first_week\.lesson_order\)/);
});

test("grammar catalogue is shared once while each student keeps an individual boundary",async()=>{
  const early={id:"00000000-0000-0000-0000-000000000001",target_type:"group",curriculum_snapshot:{level:"A1",module:"1",unit:"1",day:"2",lesson_key:"A1_M1_U1_D2",first_week_basis:false}};
  const later={id:"00000000-0000-0000-0000-000000000002",target_type:"group",curriculum_snapshot:{level:"A1",module:"2",unit:"1",day:"4",lesson_key:"A1_M2_U1_D4",first_week_basis:false}};
  let suppliedWindows=[];
  const result=await loadGrammarCatalogue([early,later],{
    withSupabaseClient:async(callback)=>callback({
      query:async(_sql,params)=>{
        suppliedWindows=JSON.parse(params[0]);
        return{rows:[{
          grammar_catalogue:[
            {level:"A1",lesson_key:"A1_M1_U1_D1",lesson_order:1,grammar:"be"},
            {level:"A1",lesson_key:"A1_M2_U1_D4",lesson_order:11,grammar:"present simple"}
          ],
          target_bounds:[
            {target_id:early.id,grammar_max_order:2,grammar_basis:"latest_valid_submission"},
            {target_id:later.id,grammar_max_order:11,grammar_basis:"latest_valid_submission"}
          ]
        }]};
      }
    })
  });
  assert.equal(suppliedWindows.length,2);
  assert.equal(result.grammarCatalogue.length,2);
  assert.equal(result.targets[0].curriculum_snapshot.grammar_max_order,2);
  assert.equal(result.targets[1].curriculum_snapshot.grammar_max_order,11);
  assert.equal(result.targets[0].curriculum_snapshot.grammar_basis,"latest_valid_submission");
  assert.deepEqual(result.unresolvedTargets,[]);

  const body=buildSpeakingTopicRequestBody({targets:result.targets,grammarCatalogue:result.grammarCatalogue});
  const payload=JSON.parse(body.messages[1].content);
  assert.equal(payload.shared_curriculum_grammar.length,2);
  assert.equal(payload.targets[0].curriculum.grammar_max_order,2);
  assert.equal(payload.targets[1].curriculum.grammar_max_order,11);
});

test("a missing grammar boundary isolates only that target",async()=>{
  const missing={id:"00000000-0000-0000-0000-000000000003",target_type:"private",curriculum_snapshot:{level:"Z9",first_week_basis:true}};
  const ielts={id:"00000000-0000-0000-0000-000000000004",target_type:"ielts_shared",curriculum_snapshot:{}};
  const result=await loadGrammarCatalogue([missing,ielts],{withSupabaseClient:async(callback)=>callback({query:async()=>({rows:[{grammar_catalogue:[],target_bounds:[{target_id:missing.id,grammar_max_order:null,grammar_basis:"first_week"}]}]})})});
  assert.deepEqual(result.targets,[ielts]);
  assert.deepEqual(result.unresolvedTargets,[missing]);
});

test("speaking cycle lesson keys cast numeric positions before using an empty-text fallback",()=>{
  const source=fs.readFileSync(new URL("../src/supabase/speakingTopicRepository.js",import.meta.url),"utf8");
  for(const column of ["module","unit","day"]){
    assert.match(source,new RegExp(`coalesce\\(si\\.${column}::text,''\\)`));
    assert.doesNotMatch(source,new RegExp(`coalesce\\(si\\.${column},''\\)`));
  }
});

test("stale speaking generation attempts are recovered and persistence failures stay target-specific",()=>{
  const repository=fs.readFileSync(new URL("../src/supabase/speakingTopicRepository.js",import.meta.url),"utf8");
  const pipeline=fs.readFileSync(new URL("../src/speaking/pipeline.js",import.meta.url),"utf8");
  assert.match(repository,/recoverStaleGenerationAttempts/);
  assert.match(repository,/STALE_ATTEMPT_RECOVERED/);
  assert.match(repository,/status='RETRY_WAIT'/);
  assert.match(pipeline,/code:"PERSISTENCE_FAILURE"/);
  assert.match(pipeline,/normaliseSpeakingCycleDate\(cycle\.cycle_date,config\.timezone\)/);
});

test("level-specific teacher routing deduplicates case-insensitively and only uses the legacy fallback when all four levels are empty",()=>{
  const keys=["SPEAKING_GROUP_A1_TEACHER_EMAILS","SPEAKING_GROUP_A2_TEACHER_EMAILS","SPEAKING_GROUP_B1_TEACHER_EMAILS","SPEAKING_GROUP_B2_TEACHER_EMAILS","SPEAKING_GROUP_TEACHER_EMAILS"];
  const previous=Object.fromEntries(keys.map((key)=>[key,process.env[key]]));
  try{
    Object.assign(process.env,{SPEAKING_GROUP_A1_TEACHER_EMAILS:"One@Example.com; one@example.com,Two@example.com",SPEAKING_GROUP_A2_TEACHER_EMAILS:"one@example.com",SPEAKING_GROUP_B1_TEACHER_EMAILS:"",SPEAKING_GROUP_B2_TEACHER_EMAILS:"",SPEAKING_GROUP_TEACHER_EMAILS:"legacy@example.com"});
    let config=getSpeakingConfig();
    assert.deepEqual(config.groupTeacherEmailsByLevel.A1,["one@example.com","two@example.com"]);
    assert.deepEqual(config.groupTeacherEmailsByLevel.A2,["one@example.com"]);
    assert.deepEqual(config.groupTeacherEmailsByLevel.B1,[]);
    assert.equal(config.usesLegacyGroupTeacherFallback,false);
    for(const level of ["A1","A2","B1","B2"])process.env[`SPEAKING_GROUP_${level}_TEACHER_EMAILS`]="";
    config=getSpeakingConfig();
    for(const level of ["A1","A2","B1","B2"])assert.deepEqual(config.groupTeacherEmailsByLevel[level],["legacy@example.com"]);
    assert.equal(config.usesLegacyGroupTeacherFallback,true);
  }finally{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});

test("speaking configuration route exposes readiness metadata but no addresses or external identifiers",()=>{
  const keys=["WORKER_ADMIN_SECRET","SPEAKING_GROUP_A1_TEACHER_EMAILS","SPEAKING_PROFILE_FORM_URL","PDFMONKEY_SPEAKING_TEACHER_TEMPLATE_ID","SPEAKING_TEACHER_DRIVE_FOLDER_ID"];
  const previous=Object.fromEntries(keys.map((key)=>[key,process.env[key]]));
  try{
    Object.assign(process.env,{WORKER_ADMIN_SECRET:"safe-route-secret",SPEAKING_GROUP_A1_TEACHER_EMAILS:"teacher@example.com",SPEAKING_PROFILE_FORM_URL:"https://secret-form.example",PDFMONKEY_SPEAKING_TEACHER_TEMPLATE_ID:"private-template",SPEAKING_TEACHER_DRIVE_FOLDER_ID:"private-folder"});
    const handlers=new Map();
    const app={get:(path,handler)=>handlers.set(path,handler),post:()=>{}};
    registerSpeakingRoutes(app);
    let payload=null;
    const response={status(){return this;},json(value){payload=value;return value;}};
    handlers.get("/worker/speaking/config")({get:(name)=>name==="x-worker-admin-secret"?"safe-route-secret":"",query:{},body:{}},response);
    assert.equal(payload.ok,true);
    assert.deepEqual(payload.config.groupTeacherEmailsByLevel.A1,{configured:true,recipient_count:1});
    assert.equal(payload.config.profileFormConfigured,true);
    assert.equal(payload.config.pdfMonkeyTemplateConfigured,true);
    assert.equal(payload.config.driveFolderConfigured,true);
    for(const key of ["groupTeacherEmails","profileFormUrl","pdfMonkeyTemplateId","driveFolderId"])assert.equal(key in payload.config,false);
    assert.doesNotMatch(JSON.stringify(payload),/teacher@example\.com|secret-form|private-template|private-folder/);
  }finally{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});

test("group document planning separates levels, alphabetises complete names and fails closed for unrouted material",()=>{
  const rows=[
    {id:"3",level:"A2",full_name:"ZOBO NGONO Jean Christophe"},
    {id:"1",level:"A1",full_name:"MATENE Emsy Pascale"},
    {id:"2",level:"A1",full_name:"ABANDA Marie Claire"}
  ];
  const config={studentsPerPdfPart:1,groupTeacherEmailsByLevel:{A1:["teacher@example.com"],A2:["teacher@example.com"],B1:[],B2:[]}};
  const result=planGroupTeacherDocuments(rows,config);
  assert.deepEqual(result.unroutedLevels,[]);
  assert.deepEqual(result.plans.map((plan)=>[plan.level,plan.partNumber,plan.rows[0].full_name]),[
    ["A1",1,"ABANDA Marie Claire"],
    ["A1",2,"MATENE Emsy Pascale"],
    ["A2",1,"ZOBO NGONO Jean Christophe"]
  ]);
  const unrouted=planGroupTeacherDocuments(rows,{...config,groupTeacherEmailsByLevel:{A1:["teacher@example.com"],A2:[],B1:[],B2:[]}});
  assert.deepEqual(unrouted,{plans:[],unroutedLevels:["A2"]});
});

test("one recipient receives several levels and assigned private/IELTS material in one bundle while another teacher can share a level",()=>{
  const group=(id,level,emails,part=1,total=1)=>({id,document_scope:"group",part_number:part,total_parts:total,pdf_drive_url:`https://drive/${id}`,pdf_filename:`${id}.pdf`,audience_snapshot:{group_level:level,recipient_emails:emails,student_count:4,alphabetical_start:"A Student",alphabetical_end:"Z Student"}});
  const assigned={id:"private-ielts",document_scope:"assigned_teacher",teacher_id:"teacher-id",part_number:1,total_parts:1,pdf_drive_url:"https://drive/private",pdf_filename:"private.pdf",audience_snapshot:{teacher_email:"MAIN@EXAMPLE.COM",teacher_name:"NGONO Velia",has_private:true,has_ielts:true,private_student_names:["PRIVATE Alice Marie"],ielts_student_names:["IELTS Bruno Marc"]}};
  const bundles=buildTeacherRecipientBundles({
    jobs:[group("a1","A1",["main@example.com","second@example.com"]),group("b1","B1",["MAIN@example.com"]),assigned],
    teacherDirectory:[{id:"teacher-id",email:"main@example.com",full_name:"NGONO Velia"}]
  });
  assert.equal(bundles.length,2);
  assert.deepEqual(bundles.find((bundle)=>bundle.recipient_email==="main@example.com").documents.map((document)=>document.job_id),["a1","b1","private-ielts"]);
  assert.deepEqual(bundles.find((bundle)=>bundle.recipient_email==="second@example.com").documents.map((document)=>document.job_id),["a1"]);
});

test("teacher email combines PDF parts in approved order and uses the approved English guidance",()=>{
  const rendered=renderTeacherMaterialEmail({
    cycle_date:"2026-09-07",
    recipient_name:"NGONO Velia",
    documents:[
      {job_id:"a1-2",material_type:"GROUP",level:"A1",part_number:2,total_parts:2,student_count:2,coverage_start:"M Student",coverage_end:"Z Student",pdf_drive_url:"https://drive/a1-2",pdf_filename:"JEA_Speaking_Group_A1_2026-09-07_P2-of-2.pdf"},
      {job_id:"a1-1",material_type:"GROUP",level:"A1",part_number:1,total_parts:2,student_count:3,coverage_start:"A Student",coverage_end:"L Student",pdf_drive_url:"https://drive/a1-1",pdf_filename:"JEA_Speaking_Group_A1_2026-09-07_P1-of-2.pdf"},
      {job_id:"assigned",material_type:"ASSIGNED",has_private:true,has_ielts:true,private_student_names:["PRIVATE Alice Marie"],ielts_student_names:["IELTS Bruno Marc"],pdf_drive_url:"https://drive/assigned",pdf_filename:"JEA_Speaking_Private-IELTS_2026-09-07.pdf"}
    ]
  });
  assert.equal(rendered.subject,"JEA speaking materials — Monday 7 September 2026 — A1, Private and IELTS");
  assert.match(rendered.text,/^Hello Velia,/);
  assert.match(rendered.text,/This email brings together all the documents assigned to you: A1, Private and IELTS\./);
  assert.match(rendered.text,/Open A1 document — Part 1/);
  assert.ok(rendered.text.indexOf("Part 1")<rendered.text.indexOf("Part 2"));
  assert.ok(rendered.text.indexOf("GROUP STUDENTS — A1")<rendered.text.indexOf("PRIVATE STUDENTS"));
  assert.ok(rendered.text.indexOf("PRIVATE STUDENTS")<rendered.text.indexOf("IELTS STUDENTS"));
  assert.match(rendered.text,/Please do not forward the PDFs or the teacher questions to students/);
});

test("teacher email falls back to Hello and omits inapplicable private or IELTS sections",()=>{
  const groupOnly=renderTeacherMaterialEmail({cycle_date:"2026-09-07",recipient_name:"",documents:[{job_id:"a2",material_type:"GROUP",level:"A2",part_number:1,total_parts:1,student_count:1,coverage_start:"Student One",coverage_end:"Student One",pdf_drive_url:"https://drive/a2",pdf_filename:"JEA_Speaking_Group_A2_2026-09-07.pdf"}]});
  assert.match(groupOnly.text,/^Hello,/);
  assert.doesNotMatch(groupOnly.text,/PRIVATE STUDENTS|IELTS STUDENTS/);
  const privateOnly=renderTeacherMaterialEmail({cycle_date:"2026-09-07",recipient_name:"TEACHER Mary",documents:[{job_id:"private",material_type:"ASSIGNED",has_private:true,has_ielts:false,private_student_names:["STUDENT Full Name"],ielts_student_names:[],pdf_drive_url:"https://drive/private",pdf_filename:"JEA_Speaking_Private_2026-09-07.pdf"}]});
  assert.match(privateOnly.text,/PRIVATE STUDENTS/);
  assert.doesNotMatch(privateOnly.text,/IELTS STUDENTS/);
});

test("teacher document filenames preserve the approved short structure",()=>{
  assert.equal(teacherDocumentFilename({document_scope:"group",part_number:1,total_parts:1,audience_snapshot:{group_level:"A1"}},"2026-09-07"),"JEA_Speaking_Group_A1_2026-09-07.pdf");
  assert.equal(teacherDocumentFilename({document_scope:"group",part_number:1,total_parts:2,audience_snapshot:{group_level:"A1"}},"2026-09-07"),"JEA_Speaking_Group_A1_2026-09-07_P1-of-2.pdf");
  assert.equal(teacherDocumentFilename({document_scope:"assigned_teacher",part_number:1,total_parts:1,audience_snapshot:{has_private:true,has_ielts:true}},"2026-09-07"),"JEA_Speaking_Private-IELTS_2026-09-07.pdf");
});

test("private PDF material is grouped by level and IELTS follows it without empty sections",()=>{
  const topic=(targetId)=>({target_id:targetId,position:1,title:"Topic",learner_content:{heading:"Scenario",body:"Discuss this.",points:[]},teacher_sections:[]});
  const job={document_scope:"assigned_teacher",part_number:1,total_parts:1,audience_snapshot:{recipient_label:"Teacher",summary_cards:[]}};
  const rows=[{id:"b",target_type:"private",status:"READY",generation_basis:"approved_profile",full_name:"ZULU Zoe Anne",level:"B1",curriculum_snapshot:{}},{id:"a",target_type:"private",status:"READY",generation_basis:"approved_profile",full_name:"ALPHA Alice Marie",level:"A1",curriculum_snapshot:{}},{id:"ielts",target_type:"ielts_shared",status:"READY"}];
  const payload=buildTeacherPdfPayload({job,cycle:{cycle_date:"2026-09-07"},rows,topics:[topic("a"),topic("b"),topic("ielts")],ielts:rows[2],ieltsStudents:[{full_name:"IELTS Full Name"}],config:{profileFormUrl:"https://form"}});
  assert.deepEqual(payload.sections.map((section)=>section.title),["PRIVATE STUDENTS — A1","PRIVATE STUDENTS — B1","IELTS STUDENTS"]);
  assert.equal(payload.sections[0].entries[0].name,"ALPHA Alice Marie");
});

test("teacher bundle release depends on group sends and recipient PDF readiness, not the fixed teacher hour",()=>{
  const pipeline=fs.readFileSync(new URL("../src/speaking/pipeline.js",import.meta.url),"utf8");
  const repository=fs.readFileSync(new URL("../src/supabase/speakingTopicRepository.js",import.meta.url),"utf8");
  assert.match(pipeline,/groupEmailsComplete\(cycle\.id\)/);
  assert.doesNotMatch(pipeline,/timeReached\(local\.time,config\.teacherDocumentTime\)/);
  assert.match(repository,/t\.target_type='group'/);
  assert.match(repository,/WAITING_FOR_RECIPIENT_PDFS/);
  assert.match(repository,/speaking-teacher-bundle:\$\{cycleId\}:\$\{bundle\.recipient_email\}/);
  assert.match(repository,/on conflict\(idempotency_key\)/);
});

test("private and IELTS targets do not block the required group-student email dependency",()=>{
  const repository=fs.readFileSync(new URL("../src/supabase/speakingTopicRepository.js",import.meta.url),"utf8");
  const match=repository.match(/export async function groupEmailsComplete\(cycleId\) \{[\s\S]*?\n\}/);
  assert.ok(match,"groupEmailsComplete implementation was not found");
  assert.match(match[0],/t\.target_type='group'/);
  assert.doesNotMatch(match[0],/target_type='private'|target_type='ielts_shared'/);
});

test("duplicate speaking scheduler execution reuses keys without erasing teacher-email failures",()=>{
  const repository=fs.readFileSync(new URL("../src/supabase/speakingTopicRepository.js",import.meta.url),"utf8");
  assert.match(repository,/on conflict\(cycle_date\) do update/);
  assert.match(repository,/if\(error\.code==='23505'\)return null/);
  assert.match(repository,/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(repository,/speaking-teacher-bundle:\$\{cycleId\}:\$\{bundle\.recipient_email\}/);
  assert.match(repository,/on conflict\(idempotency_key\) do nothing/);
  assert.doesNotMatch(repository,/status=case when email_queue\.status in\('FAILED','FAILED_RETRYABLE'\)/);
  for(const field of ["next_attempt_at","error_code","error_message","subject","body_html","body_text"]){
    assert.doesNotMatch(repository,new RegExp(`${field}=case when email_queue\\.status in\\('FAILED','FAILED_RETRYABLE'\\) then null`));
  }
  assert.match(repository,/select id,status,attempt_count,next_attempt_at,error_code,error_message from email_queue where idempotency_key=\$1/);
  assert.match(repository,/TEACHER_BUNDLE_DELIVERY_FAILED/);
  assert.match(repository,/TEACHER_BUNDLE_RETRY_WAIT/);
});
