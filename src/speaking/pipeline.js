import crypto from "node:crypto";
import { createPdfMonkeyDocument, waitForPdfMonkeyDocument } from "../pdfmonkeyClient.js";
import { uploadPdfUrlToGoogleDrive } from "../google/driveClient.js";
import { generateSpeakingTopics } from "./deepseekClient.js";
import { assertSpeakingCycleConfig, assertSpeakingRuntimeConfig, getSpeakingConfig, isSpeakingCycleDay, localParts, normaliseSpeakingCycleDate, speakingScheduledInstant, timeReached } from "./config.js";
import { assertTeacherPdfPayload, buildTeacherPdfPayload } from "./pdfPayload.js";
import { validateGeneratedIelts, validateGeneratedTarget } from "./prompt.js";
import { assignedTeacherDocumentReadiness } from "./readiness.js";
import * as defaultRepository from "../supabase/speakingTopicRepository.js";

function clean(value){return String(value??"").trim();}
function sha(value){return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");}
const SPEAKING_LEVELS=["A1","A2","B1","B2"];
function levelRank(level){const index=SPEAKING_LEVELS.indexOf(clean(level).toUpperCase());return index<0?99:index;}
function byName(a,b){return clean(a.full_name).localeCompare(clean(b.full_name),"en",{sensitivity:"base"});}
function normalisedTeacherEmail(value){return clean(value).toLowerCase();}
function sortedNames(rows){return [...rows].sort((a,b)=>levelRank(a.level)-levelRank(b.level)||byName(a,b)).map((row)=>clean(row.full_name)).filter(Boolean);}

export function planGroupTeacherDocuments(rows,config){
  const grouped=new Map();
  for(const row of [...rows].sort((a,b)=>levelRank(a.level)-levelRank(b.level)||byName(a,b))){
    const level=clean(row.level).toUpperCase();
    if(!grouped.has(level))grouped.set(level,[]);
    grouped.get(level).push(row);
  }
  const unroutedLevels=[...grouped.keys()]
    .filter((level)=>!(config.groupTeacherEmailsByLevel?.[level]||[]).length)
    .sort((a,b)=>levelRank(a)-levelRank(b));
  if(unroutedLevels.length)return{plans:[],unroutedLevels};
  const plans=[];
  for(const level of [...grouped.keys()].sort((a,b)=>levelRank(a)-levelRank(b))){
    const levelRows=grouped.get(level);
    const totalParts=Math.ceil(levelRows.length/config.studentsPerPdfPart);
    for(let index=0;index<totalParts;index+=1){
      const partRows=levelRows.slice(index*config.studentsPerPdfPart,(index+1)*config.studentsPerPdfPart);
      plans.push({
        level,
        partNumber:index+1,
        totalParts,
        rows:partRows,
        recipientEmails:[...config.groupTeacherEmailsByLevel[level]],
        rangeLabel:partRows.length===1?clean(partRows[0].full_name):`${clean(partRows[0].full_name)} — ${clean(partRows.at(-1).full_name)}`
      });
    }
  }
  return{plans,unroutedLevels:[]};
}

export function teacherDocumentFilename(job,cycleDate){
  if(job.document_scope==="group"){
    const level=clean(job.audience_snapshot?.group_level).toUpperCase();
    if(!SPEAKING_LEVELS.includes(level))throw new Error("Group speaking document is missing a supported level.");
    const base=`JEA_Speaking_Group_${level}_${cycleDate}`;
    return Number(job.total_parts)>1?`${base}_P${job.part_number}-of-${job.total_parts}.pdf`:`${base}.pdf`;
  }
  const hasPrivate=Boolean(job.audience_snapshot?.has_private);
  const hasIelts=Boolean(job.audience_snapshot?.has_ielts);
  const kind=hasPrivate&&hasIelts?"Private-IELTS":hasPrivate?"Private":"IELTS";
  return `JEA_Speaking_${kind}_${cycleDate}.pdf`;
}

function normaliseIeltsTopics(sets){return sets.map((set,index)=>({
  title:clean(set.title)||`IELTS Speaking Set ${index+1}`,
  learner_content:{heading:"Part 2 cue card",body:set.part_2.prompt,points_heading:"You should say:",points:set.part_2.points},
  teacher_sections:[...set.part_1.map((p)=>({heading:`Part 1 - ${p.subtopic}`,items:p.questions})),{heading:"Part 2 - Brief follow-up questions",items:set.part_2_follow_ups},{heading:"Part 3 - Discussion",items:set.part_3}],
  theme:"IELTS",fingerprint:clean(set.fingerprint)||`IELTS | set_${index+1} | DISCUSS`,history_metadata:{shared:true}
}));}

async function callGenerationWithOneWholeRetry(input,generate=generateSpeakingTopics){
  try{return await generate(input);}catch(firstError){
    if(firstError.status&&!firstError.retryable)throw firstError;
    return generate(input);
  }
}

async function processBatch(batch,config,repository=defaultRepository,generate=generateSpeakingTopics){
  if(!batch.targets.length)return{processed:0,succeeded:0,failed:0};
  const batchKey=repository.createBatchKey();
  await repository.beginGenerationAttempts({batchKey,targets:batch.targets,model:config.model});
  let grammarContext;
  try{grammarContext=await repository.loadGrammarCatalogue(batch.targets);}
  catch(error){
    for(const target of batch.targets)await repository.failGeneratedTarget({batchKey,targetId:target.id,retryMinutes:config.retryMinutes,code:"GRAMMAR_CONTEXT_FAILURE",summary:error.message});
    return{processed:batch.targets.length,succeeded:0,failed:batch.targets.length};
  }
  let failed=0;
  for(const target of grammarContext.unresolvedTargets){
    await repository.failGeneratedTarget({batchKey,targetId:target.id,retryMinutes:config.retryMinutes,code:"GRAMMAR_CONTEXT_MISSING",summary:"No active grammar boundary exists for the target level."});
    failed+=1;
  }
  const generationTargets=grammarContext.targets;
  if(!generationTargets.length)return{processed:batch.targets.length,succeeded:0,failed};
  const regular=generationTargets.filter((t)=>t.target_type!=="ielts_shared");
  const ielts=generationTargets.find((t)=>t.target_type==="ielts_shared");
  let response;
  try{
    response=await callGenerationWithOneWholeRetry({targets:regular,grammarCatalogue:grammarContext.grammarCatalogue,includeIelts:Boolean(ielts),ieltsFingerprints:ielts?.recent_fingerprints||[],model:config.model,thinkingMode:config.thinkingMode,reasoningEffort:config.reasoningEffort},generate);
  }catch(error){
    // A repeatedly malformed/failed ten-student request is split 5+5 so one bad
    // response cannot indefinitely block the whole group batch.
    if(batch.kind==="group"&&generationTargets.length>5){
      for(const target of generationTargets)await repository.failGeneratedTarget({batchKey,targetId:target.id,retryMinutes:config.retryMinutes,code:"BATCH_SPLIT_REQUIRED",summary:error.message});
      return{processed:batch.targets.length,succeeded:0,failed:failed+generationTargets.length,split_required:true};
    }
    for(const target of generationTargets)await repository.failGeneratedTarget({batchKey,targetId:target.id,retryMinutes:config.retryMinutes,code:"PROVIDER_FAILURE",summary:error.message});
    return{processed:batch.targets.length,succeeded:0,failed:failed+generationTargets.length};
  }
  const generatedTargets=new Map((Array.isArray(response.parsed?.targets)?response.parsed.targets:[]).map((item)=>[item.target_id,item]));
  let succeeded=0;
  for(const target of regular){
    const checked=validateGeneratedTarget(target,generatedTargets.get(target.id));
    if(!checked.ok){await repository.failGeneratedTarget({batchKey,targetId:target.id,retryMinutes:config.retryMinutes,code:"INVALID_RESPONSE",summary:checked.errors.join("; ")});failed+=1;continue;}
    try{await repository.saveGeneratedTarget({batchKey,target,topics:checked.topics,usage:response.usage});succeeded+=1;}
    catch(error){await repository.failGeneratedTarget({batchKey,targetId:target.id,retryMinutes:config.retryMinutes,code:"PERSISTENCE_FAILURE",summary:error.message});failed+=1;}
  }
  if(ielts){
    const checked=validateGeneratedIelts(response.parsed?.ielts_shared);
    if(!checked.ok){await repository.failGeneratedTarget({batchKey,targetId:ielts.id,retryMinutes:config.retryMinutes,code:"INVALID_RESPONSE",summary:checked.errors.join("; ")});failed+=1;}
    else{try{await repository.saveGeneratedTarget({batchKey,target:ielts,topics:normaliseIeltsTopics(checked.sets),usage:response.usage});succeeded+=1;}
      catch(error){await repository.failGeneratedTarget({batchKey,targetId:ielts.id,retryMinutes:config.retryMinutes,code:"PERSISTENCE_FAILURE",summary:error.message});failed+=1;}}
  }
  return{processed:batch.targets.length,succeeded,failed};
}

async function createGroupDocumentJobs(cycle,config,repository=defaultRepository){
  if(!(await repository.groupEmailsComplete(cycle.id)))return{blocked:"WAITING_FOR_ALL_GROUP_EMAILS"};
  const rows=await repository.loadDocumentCandidates({cycleId:cycle.id,scope:"group"});
  const planned=planGroupTeacherDocuments(rows,config);
  if(planned.unroutedLevels.length){
    await repository.markCycleRoutingError(cycle.id,planned.unroutedLevels);
    return{blocked:"UNROUTED_GROUP_LEVELS",unrouted_levels:planned.unroutedLevels,created:0};
  }
  await repository.clearCycleRoutingError(cycle.id);
  let created=0;
  for(const plan of planned.plans){
    const totalLevelStudents=rows.filter((row)=>clean(row.level).toUpperCase()===plan.level).length;
    const job=await repository.createDocumentJob({
      cycleId:cycle.id,
      scope:"group",
      audience:{
        recipient_label:`Group speaking teachers — ${plan.level}`,
        group_level:plan.level,
        recipient_emails:plan.recipientEmails,
        student_count:plan.rows.length,
        total_level_students:totalLevelStudents,
        alphabetical_start:clean(plan.rows[0]?.full_name),
        alphabetical_end:clean(plan.rows.at(-1)?.full_name),
        summary_cards:[{number:plan.rows.length,label:`${plan.level} students`}]
      },
      recipientCount:plan.recipientEmails.length,
      partNumber:plan.partNumber,
      totalParts:plan.totalParts,
      rangeLabel:plan.rangeLabel,
      targetIds:plan.rows.map((row)=>row.id)
    });
    if(job)created+=1;
  }
  return{created,planned:planned.plans.length};
}

async function createAssignedTeacherJobs(cycle,config,repository=defaultRepository){
  const teachers=await repository.listAssignedTeachersForCycle(cycle.id);let created=0;const waiting=[];
  for(const teacher of teachers){
    if(!normalisedTeacherEmail(teacher.email)){waiting.push({teacher_id:teacher.id,reason:"MISSING_TEACHER_EMAIL"});continue;}
    const state=await repository.documentJobState({cycleId:cycle.id,teacherId:teacher.id,scope:"assigned_teacher"});
    if(state.count>0)continue;
    const data=await repository.loadDocumentCandidates({cycleId:cycle.id,scope:"assigned_teacher",teacherId:teacher.id});
    const readiness=assignedTeacherDocumentReadiness(data);
    if(!readiness.ready){waiting.push({teacher_id:teacher.id,...readiness});continue;}
    const includeIelts=data.ieltsStudents.length>0;
    const targetIds=[...data.privateRows.map((row)=>row.id),...(includeIelts?[data.ielts.id]:[])];
    if(!targetIds.length)continue;
    const job=await repository.createDocumentJob({
      cycleId:cycle.id,
      scope:"assigned_teacher",
      teacherId:teacher.id,
      audience:{
        recipient_label:`Teacher: ${clean(teacher.full_name)}`,
        teacher_name:clean(teacher.full_name),
        teacher_email:normalisedTeacherEmail(teacher.email),
        has_private:data.privateRows.length>0,
        has_ielts:includeIelts,
        private_student_names:sortedNames(data.privateRows),
        ielts_student_names:sortedNames(data.ieltsStudents),
        summary_cards:[{number:data.privateRows.length,label:"Private students"},{number:data.ieltsStudents.length,label:"IELTS students"}]
      },
      recipientCount:1,
      partNumber:1,
      totalParts:1,
      rangeLabel:"Weekly materials",
      targetIds
    });
    if(job)created+=1;
  }
  return{created,waiting};
}

async function renderPendingDocuments(config,repository=defaultRepository,services={}){
  const jobs=await repository.listPendingDocumentJobs({retryMinutes:config.retryMinutes});const results=[];
  for(const job of jobs){
    try{
      const bundle=await repository.loadDocumentJobBundle(job.id);
      const cycleDate=normaliseSpeakingCycleDate(bundle.cycle.cycle_date,config.timezone);
      const normalisedBundle={...bundle,cycle:{...bundle.cycle,cycle_date:cycleDate}};
      const payload=buildTeacherPdfPayload({...normalisedBundle,config});
      assertTeacherPdfPayload(payload,{expectedTargetCount:bundle.rows.length,expectedTopicCount:bundle.topics.length});
      const filename=teacherDocumentFilename(bundle.job,cycleDate);
      const requested=await (services.createPdfMonkeyDocument||createPdfMonkeyDocument)(payload,{templateId:config.pdfMonkeyTemplateId,requireExplicitTemplateId:true,filename,meta:{source:"JEA Speaking Practice"}});
      await repository.updateDocumentJob(job.id,{status:"RENDERING",payloadSha:sha(payload),filename,documentId:requested.document_id,pdfStatus:"pending",renderRequestedAt:new Date()});
      const pdf=await (services.waitForPdfMonkeyDocument||waitForPdfMonkeyDocument)(requested.document_id);
      const drive=await (services.uploadPdfUrlToGoogleDrive||uploadPdfUrlToGoogleDrive)(pdf.download_url,{folderId:config.driveFolderId,filename,requireContentfulPdf:true,minPdfBytes:2048});
      const ready=await repository.updateDocumentJob(job.id,{status:"PDF_READY",pdfStatus:pdf.status,downloadUrl:pdf.download_url,driveFileId:drive.drive_file_id,driveUrl:drive.drive_url,renderedAt:new Date()});
      results.push({job_id:ready.id,status:"PDF_READY",filename});
    }catch(error){await repository.updateDocumentJob(job.id,{status:"RETRY_WAIT",errorCode:"DOCUMENT_BUILD_FAILED",errorSummary:error.message});results.push({job_id:job.id,status:"RETRY_WAIT",error:error.message});}
  }
  return results;
}

export async function runSpeakingPipelineOnce({now=new Date(),force=false,dependencies={}}={}){
  const config=dependencies.config||getSpeakingConfig();
  const repository=dependencies.repository||defaultRepository;
  if(!force&&!config.enabled)return{ok:true,status:"DISABLED"};
  assertSpeakingCycleConfig(config);
  const local=localParts(now,config.timezone);const result={ok:true,local,cycles:[],documents:[]};
  if(isSpeakingCycleDay(local.weekday)&&timeReached(local.time,config.cycleCutoffTime))await repository.ensureSpeakingCycle({cycleDate:local.date,cycleDay:local.weekday});
  assertSpeakingRuntimeConfig(config);
  const cycles=await repository.listOpenCycles();
  for(const cycle of cycles){
    if(["CYCLE_INITIALIZATION_PENDING","CYCLE_INITIALIZATION_FAILED"].includes(cycle.last_error_code))await repository.ensureSpeakingCycle({cycleDate:normaliseSpeakingCycleDate(cycle.cycle_date,config.timezone),cycleDay:cycle.cycle_day});
    const recovery=await repository.recoverStaleGenerationAttempts({cycleId:cycle.id,staleMinutes:30});
    const batch=await repository.claimGenerationBatch({cycleId:cycle.id,groupLimit:config.groupBatchSize});
    const generation=await processBatch(batch,config,repository,dependencies.generateSpeakingTopics);
    let emailQueue=null;let groupDocuments=null;let assignedDocuments=null;
    const cycleDate=normaliseSpeakingCycleDate(cycle.cycle_date,config.timezone);
    const currentCycle=cycleDate===local.date;
    if(!currentCycle||timeReached(local.time,config.studentEmailTime))emailQueue=await repository.queueDueGroupEmails({cycleId:cycle.id,scheduledFor:speakingScheduledInstant(cycleDate,config.studentEmailTime,config.timezone)});
    groupDocuments=await createGroupDocumentJobs(cycle,config,repository);
    if(!groupDocuments.blocked&&cycle.cycle_day==="MONDAY")assignedDocuments=await createAssignedTeacherJobs(cycle,config,repository);
    await repository.markCycleCompletedIfDone(cycle.id);
    result.cycles.push({cycle_id:cycle.id,recovery,generation,email_queue:emailQueue,group_documents:groupDocuments,assigned_documents:assignedDocuments});
  }
  result.documents=await renderPendingDocuments(config,repository,dependencies);
  for(const cycleResult of result.cycles){
    if(cycleResult.group_documents?.blocked||cycleResult.assigned_documents?.waiting?.length){
      cycleResult.teacher_bundles={queued:0,status:"WAITING_FOR_COMPLETE_DOCUMENT_SET"};
      continue;
    }
    cycleResult.teacher_bundles=await repository.queueReadyTeacherDocumentBundles({cycleId:cycleResult.cycle_id});
    await repository.markCycleCompletedIfDone(cycleResult.cycle_id);
  }
  return result;
}
