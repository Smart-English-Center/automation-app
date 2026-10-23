import {normaliseSpeakPipeLink} from '../submissionPolicy.js';
import fs from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {content,queue,step,tx} from './core.mjs';
import {chat,downloadAudio,transcribe} from './providers.mjs';
import {downloadAndConvertAudioToWavBuffer} from '../utils/audioProcessing.js';
const schema=JSON.parse(await fs.readFile(new URL('../../templates/selc/SELC_payload.schema.json',import.meta.url)));
const ajv=new Ajv2020({strict:false,allErrors:true});
const validators=Object.fromEntries(['writing','speaking'].map(k=>[k,ajv.compile(schema.properties[k])]));
export function validateAssessment(kind,assessment,submission){
 if(!validators[kind](assessment))throw Error('INVALID_'+kind.toUpperCase()+'_SCHEMA');
 if(kind==='writing')for(const correction of assessment.corrections)if(!correction.original||!submission.writing_answer.includes(correction.original))throw Error('WRITING_ORIGINAL_NOT_IN_SOURCE');
 return assessment;
}
async function assetFor(pool,submission){
 return tx(pool,async db=>{
  const source=normaliseSpeakPipeLink(submission.speaking_answer_source);
  await db.query(`insert into public.selc_audio_assets(student_id,assignment_title,canonical_source_url) values($1,$2,$3) on conflict(canonical_source_url) do nothing`,[submission.student_id,submission.assignment_title,source]);
  const asset=(await db.query('select * from public.selc_audio_assets where canonical_source_url=$1 for update',[source])).rows[0];
  if(asset.student_id!==submission.student_id||asset.assignment_title!==submission.assignment_title)throw Error('AUDIO_LINK_OWNED_BY_OTHER_ASSIGNMENT');
  await db.query('insert into public.selc_submission_audio(submission_id,audio_asset_id) values($1,$2) on conflict(submission_id) do nothing',[submission.id,asset.id]);return asset;
 });
}
async function generateReviewed(pool,submission,kind,input,audio,transcriptId,services){
 const task=kind.toUpperCase();
 const accepted=(await pool.query(`select r.* from public.selc_correction_reviews r join public.selc_correction_drafts d on d.id=r.draft_id where d.submission_id=$1 and d.task_type=$2 and r.status in('ACCEPTED','REVISED') order by r.created_at desc limit 1`,[submission.id,task])).rows[0];
 if(accepted)return {reviewId:accepted.id,assessment:accepted.reviewed_json[kind]};
 for(let run=0;run<3;run++){
  let draft=(await pool.query(`select d.* from public.selc_correction_drafts d where d.submission_id=$1 and d.task_type=$2 and d.status in('READY','CANNOT_ASSESS') and not exists(select 1 from public.selc_correction_reviews r where r.draft_id=d.id and r.status in('ACCEPTED','REVISED','REJECTED')) order by d.attempt_number desc limit 1`,[submission.id,task])).rows[0];
  if(!draft){
   const attempt=(await pool.query('select coalesce(max(attempt_number),0)+1 n from public.selc_correction_drafts where submission_id=$1 and task_type=$2',[submission.id,task])).rows[0].n;
   const generated=await step(pool,`correction:${submission.id}:${kind}:${attempt}`,async()=>services.chat({task:kind==='writing'?'writing':'audio',prompt:await content(kind+'.txt'),input,audio}));
   let validationError=null;try{validateAssessment(kind,generated.output?.[kind],submission);}catch(error){validationError=error.message;}
   const output=generated.output&&typeof generated.output==='object'&&!Array.isArray(generated.output)?generated.output:null;
   draft=(await pool.query(`insert into public.selc_correction_drafts(submission_id,task_type,attempt_number,transcript_id,provider,model,prompt_version,input_snapshot,output_json,status,error_message) values($1,$2,$3,$4,$5,$6,'SELC_APPROVED_CONTENT_V1',$7,$8,$9,$10) returning *`,[submission.id,task,attempt,transcriptId,generated.provider,generated.model,JSON.stringify(input),output?JSON.stringify(output):null,validationError?'FAILED':output[kind].status==='cannot_assess'?'CANNOT_ASSESS':'READY',validationError])).rows[0];
   if(validationError)continue;
  }
  const reviewed=await step(pool,'review:'+draft.id,async()=>services.chat({task:'review',prompt:await content(kind+'-review.txt'),input:{...input,draft:draft.output_json,review_scope:kind==='speaking'?'TEXT_AND_INTERNAL_CONSISTENCY_ONLY':'WRITING_SOURCE_CHECK'}}));
  if(!Array.isArray(reviewed.output.review_notes||[]))throw Error('REVIEW_NOTES_SCHEMA_INVALID');
  if(reviewed.output.status==='ACCEPTED'&&reviewed.output[kind]){
   let assessment=validateAssessment(kind,reviewed.output[kind],submission);
   // A text reviewer must not add new audible observations. Recheck with audio instead.
   if(kind==='speaking'){
    const original=new Set(draft.output_json.speaking.pronunciation_corrections.map(c=>JSON.stringify([c.word_or_expression,c.observed_difficulty])));
    if(assessment.pronunciation_corrections.some(c=>!original.has(JSON.stringify([c.word_or_expression,c.observed_difficulty])))){
     const rechecked=await step(pool,'audio-recheck:'+draft.id,async()=>services.chat({task:'audio',prompt:await content('speaking.txt'),input:{...input,proposed_text_review:reviewed.output},audio}));
     assessment=validateAssessment('speaking',rechecked.output.speaking,submission);reviewed.output.speaking=assessment;
     reviewed.output.review_notes=[...(reviewed.output.review_notes||[]),'AUDIO_RECHECK_COMPLETED'];
    }
   }
   const review=(await pool.query(`insert into public.selc_correction_reviews(draft_id,attempt_number,provider,model,prompt_version,status,reviewed_json,evidence_notes) values($1,1,'openrouter',$2,'SELC_APPROVED_CONTENT_V1','ACCEPTED',$3,$4) returning id`,[draft.id,reviewed.model,JSON.stringify(reviewed.output),JSON.stringify(reviewed.output.review_notes||[])])).rows[0];
   return {reviewId:review.id,assessment};
  }
  await pool.query(`insert into public.selc_correction_reviews(draft_id,attempt_number,provider,model,prompt_version,status,reviewed_json,evidence_notes) values($1,1,'openrouter',$2,'SELC_APPROVED_CONTENT_V1','REJECTED',$3,$4)`,[draft.id,reviewed.model,JSON.stringify(reviewed.output),JSON.stringify(reviewed.output.review_notes||[])]);
 }
 throw Error('CORRECTION_REVIEW_REJECTED');
}
export async function correctSubmission(pool,{submissionId},services={chat,downloadAudio,transcribe,convertAudio:downloadAndConvertAudioToWavBuffer}){
 const s=(await pool.query(`select s.*,t.full_name as coach_name from public.selc_submissions s join public.selc_teachers t on t.id=s.teacher_id join public.selc_active_enrollments e on e.id=s.enrollment_id where s.id=$1 and s.review_decision='APPROVED'`,[submissionId])).rows[0];if(!s)throw Error('CORRECTION_REQUIRES_APPROVED_ACTIVE_SUBMISSION');
 if(s.status==='COMPLETED')return;
 const input={submission_id:s.id,student_name:s.student_name_snapshot,assignment_title:s.assignment_title,feedback_language:s.feedback_language,level:s.level_code_snapshot,writing_prompt:s.writing_prompt,writing_answer:s.writing_answer};
 // Validate required approved content before downloading audio or billing a provider.
 for(const file of ['writing.txt','writing-review.txt','speaking.txt','speaking-review.txt'])await content(file);
 const asset=await assetFor(pool,s);
 if(!asset.drive_file_id){const stored=await services.downloadAudio(pool,{asset,submission:s});await pool.query(`update public.selc_audio_assets set drive_file_id=$2,mime_type=$3,byte_size=$4,status='STORED',error_message=null where id=$1`,[asset.id,stored.drive_file_id,stored.mime_type,stored.file_size_bytes]);asset.drive_file_id=stored.drive_file_id;}
 const audio=await services.convertAudio({sourceUrl:'google-drive-file://'+asset.drive_file_id,studentName:s.student_name_snapshot,referenceName:s.assignment_title});
 let transcript=(await pool.query(`select * from public.selc_transcripts where audio_asset_id=$1 and status='READY' order by attempt_number desc limit 1`,[asset.id])).rows[0];
 if(!transcript){const result=await step(pool,'transcript:'+asset.id,()=>services.transcribe(audio.wav_buffer));transcript=(await pool.query(`insert into public.selc_transcripts(audio_asset_id,attempt_number,provider,model,transcript_verbatim,status) values($1,1,'openrouter',$2,$3,'READY') returning *`,[asset.id,result.model,result.text])).rows[0];}
 const writing=await generateReviewed(pool,s,'writing',input,null,null,services);
 const speakingInput={submission_id:s.id,student_name:s.student_name_snapshot,assignment_title:s.assignment_title,feedback_language:s.feedback_language,level:s.level_code_snapshot,speaking_prompt:s.speaking_prompt,transcript_verbatim:transcript.transcript_verbatim};
 const speaking=await generateReviewed(pool,s,'speaking',speakingInput,audio.wav_buffer,transcript.id,services);
 const labels=JSON.parse(await fs.readFile(new URL('../../templates/selc/SELC_labels_en.json',import.meta.url)));
 const payload={meta:{student_name:s.student_name_snapshot,assignment_title:s.assignment_title,coach_name:s.coach_name,delivery_date:new Date().toLocaleDateString('en-GB',{timeZone:'UTC'}),feedback_language:/^(fr|fran)/i.test(s.feedback_language)?'fr':'en',level:s.level_code_snapshot,is_sample:false},labels,assignment:{writing_prompt:s.writing_prompt,writing_answer:s.writing_answer,speaking_prompt:s.speaking_prompt,speaking_audio_url:s.speaking_answer_source},writing:writing.assessment,speaking:speaking.assessment,closing_motivation:''};
 await tx(pool,async db=>{
  const feedback=(await db.query(`insert into public.selc_final_feedback(submission_id,revision_number,writing_review_id,speaking_review_id,feedback_json,status) values($1,1,$2,$3,$4,'READY') on conflict(submission_id,revision_number) do update set submission_id=excluded.submission_id returning id`,[s.id,writing.reviewId,speaking.reviewId,JSON.stringify(payload)])).rows[0];
  await queue(db,'feedback-pdf:'+s.id,'DOCUMENT',{kind:'STUDENT_FEEDBACK',feedbackId:feedback.id,payload,key:'feedback:'+s.id});
 });
}
