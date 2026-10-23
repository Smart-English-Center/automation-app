import {hash,tx,queue,equal,need} from './core.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const required={REGISTRATION:['student_name','student_email','student_phone','country','requested_teacher_email'],ASSIGNMENT:['student_name','student_email','assignment_title','writing_prompt','writing_answer','speaking_prompt','speaking_answer_source','feedback_language']};
const stable=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.keys(v).sort().reduce((o,k)=>(o[k]=v[k],o),{}):v);
function bad(message,status=400){const error=Error(message);error.httpStatus=status;throw error;}
export function validateEnvelope(p,kind){
 if(p.schema_version!=='selc.forms.v1'||p.source_kind!==kind||!required[kind])bad('INVALID_ENVELOPE');
 if(!p.answers||Array.isArray(p.answers)||required[kind].some(k=>typeof p.answers[k]!=='string'||!p.answers[k].trim()))bad('MISSING_ANSWERS');
 if(!UUID.test(p.response_id)||!Number.isInteger(p.sheet?.id)||p.sheet.id<0||!Number.isInteger(p.sheet.row_number)||p.sheet.row_number<2||typeof p.spreadsheet?.id!=='string')bad('INVALID_SOURCE_IDENTITY');
 const key=['SELC',kind,p.spreadsheet.id,p.sheet.id,p.response_id].join('|');if(p.source_response_key!==key||p.source_identity_key!==key)bad('INVALID_RESPONSE_KEY');
 if(!/^\d{4}-\d{2}-\d{2}T.*Z$/.test(p.submitted_at)||!Number.isFinite(Date.parse(p.submitted_at)))bad('INVALID_TIMESTAMP');
 for(const name of kind==='REGISTRATION'?['student_email','requested_teacher_email']:['student_email'])if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.answers[name].trim()))bad('INVALID_EMAIL');
 return p;
}
export async function receiveForm(pool,p,kind){
 validateEnvelope(p,kind);
 return tx(pool,async db=>{
  const source=(await db.query('select * from public.selc_google_sources where spreadsheet_id=$1 and source_kind=$2 and enabled for update',[p.spreadsheet.id,kind])).rows[0];
  if(!source)bad('SOURCE_NOT_CONFIGURED',409);
  if(source.tab_id===null){if(source.tab_name!==p.sheet.name)bad('SOURCE_TAB_MISMATCH',409);await db.query('update public.selc_google_sources set tab_id=$2 where id=$1',[source.id,p.sheet.id]);}
  else if(String(source.tab_id)!==String(p.sheet.id))bad('SOURCE_TAB_MISMATCH',409);
  const existing=(await db.query('select * from public.selc_import_events where source_id=$1 and source_response_key=$2',[source.id,p.source_response_key])).rows[0];
  if(existing){if(stable(existing.payload.answers)!==stable(p.answers)||existing.payload.submitted_at!==p.submitted_at)bad('RESPONSE_CONTENT_CONFLICT',409);return {id:existing.id,status:'DUPLICATE',key:p.source_response_key};}
  const event=(await db.query(`insert into public.selc_import_events(source_id,source_response_key,source_row_number,submitted_at,payload) values($1,$2,$3,$4,$5) returning id`,[source.id,p.source_response_key,p.sheet.row_number,p.submitted_at,JSON.stringify(p)])).rows[0];
  await queue(db,'import:'+event.id,'IMPORT',{eventId:event.id});
  return {id:event.id,status:'ACCEPTED',key:p.source_response_key};
 });
}
export function registerImportRoutes(app,pool){
 for(const [kind,path,header,secret] of [['REGISTRATION','/api/registration/forms/submit','x-registration-webhook-secret','REGISTRATION_WEBHOOK_SECRET'],['ASSIGNMENT','/worker/forms/import-submission','x-form-webhook-secret','FORM_WEBHOOK_SECRET']]){
  app.post(path,async(req,res)=>{if(!equal(req.get(header),need(secret)))return res.status(401).json({ok:false,status:'UNAUTHORIZED'});const r=await receiveForm(pool,req.body,kind);res.status(r.status==='ACCEPTED'?202:200).json({ok:true,receipt:{source_response_key:r.key,import_event_id:r.id,status:r.status}});});
 }
}
export async function importEvent(pool,{eventId}){
 return tx(pool,async db=>{
  await db.query('select public.selc_activate_due_enrollments()');
  const event=(await db.query('select * from public.selc_import_events where id=$1 for update',[eventId])).rows[0];if(!event||event.status==='IMPORTED')return;
  const p=event.payload,a=p.answers;
  if(p.source_kind==='REGISTRATION'){
   const r=(await db.query(`insert into public.selc_registration_requests(import_event_id,student_name,student_email,student_phone,country,requested_teacher_email,submitted_payload) values($1,$2,$3,$4,$5,$6,$7) on conflict(import_event_id) do update set import_event_id=excluded.import_event_id returning id`,[event.id,a.student_name,a.student_email.trim().toLowerCase(),a.student_phone,a.country,a.requested_teacher_email.trim().toLowerCase(),JSON.stringify(p)])).rows[0];
   await queue(db,'notify-registration:'+r.id,'REVIEW_NOTIFICATION',{kind:'REGISTRATION',id:r.id});
  }else{
   const enrollment=(await db.query(`select e.*,s.full_name,s.email from public.selc_enrollments e join public.selc_students s on s.id=e.student_id where s.email=$1 and e.status in('SCHEDULED','ACTIVE','PAUSED') order by e.created_at desc limit 1`,[a.student_email.trim().toLowerCase()])).rows[0];
   if(!enrollment||enrollment.status!=='ACTIVE'||(enrollment.starts_on instanceof Date?enrollment.starts_on.toISOString().slice(0,10):String(enrollment.starts_on))>new Date().toISOString().slice(0,10)){
    const error=Error('IMPORT_WAITING_FOR_ACTIVE_ENROLLMENT');if(enrollment?.status==='SCHEDULED')error.retryAt=new Date((enrollment.starts_on instanceof Date?enrollment.starts_on.toISOString().slice(0,10):String(enrollment.starts_on).slice(0,10))+'T00:00:01Z');throw error;
   }
   const r=(await db.query(`insert into public.selc_submissions(import_event_id,student_id,enrollment_id,teacher_id,level_code_snapshot,student_name_snapshot,student_email_snapshot,assignment_title,writing_prompt,writing_answer,speaking_prompt,speaking_answer_source,feedback_language,submitted_at,original_payload) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict(import_event_id) do update set import_event_id=excluded.import_event_id returning id`,[event.id,enrollment.student_id,enrollment.id,enrollment.teacher_id,enrollment.level_code,a.student_name,a.student_email.trim().toLowerCase(),a.assignment_title,a.writing_prompt,a.writing_answer,a.speaking_prompt,a.speaking_answer_source,a.feedback_language,p.submitted_at,JSON.stringify(p)])).rows[0];
   await queue(db,'notify-assignment:'+r.id,'REVIEW_NOTIFICATION',{kind:'ASSIGNMENT',id:r.id});
   await queue(db,'ack-assignment:'+r.id,'NOTICE',{kind:'assignment-received',submissionId:r.id});
  }
  await db.query("update public.selc_import_events set status='IMPORTED',imported_at=now(),error_message=null where id=$1",[event.id]);
 });
}
