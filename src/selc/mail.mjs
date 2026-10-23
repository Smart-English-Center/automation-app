import {baseUrl,content,e,enqueueMail,need,fill,fillPlain,isoDay,queue,shiftDay,tx,wa} from './core.mjs';
import {documentUrl,practiceUrl,topicHtml} from './documents.mjs';
const dateValue=v=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
export async function renderMail(kind,values){
 const [html,subject]=await Promise.all([content(kind+'.html'),content(kind+'-subject.txt')]);
 const template=kind==='prestart-reminder'&&!values.whatsapp_url?html.replace(/<p><a class="button" href="\{\{whatsapp_url\}\}">[^<]*<\/a><\/p>/g,''):html;
 let body=fill(template,{...values,topics_html:'__SELC_SAFE_TOPIC_HTML__'});
 body=body.replaceAll('__SELC_SAFE_TOPIC_HTML__',values.topics_html||'');
 return {html:body,subject:fillPlain(subject.trim(),values)};
}
export async function notice(pool,p){
 let kind=p.kind,student,teacher,registration,submission,enrollment,values={},email,name;
 if(p.registrationId){registration=(await pool.query('select * from public.selc_registration_requests where id=$1',[p.registrationId])).rows[0];if(!registration)return;values={...registration,student_name:registration.student_name,student_email:registration.student_email};email=registration.student_email;name=registration.student_name;
  if(registration.enrollment_id){enrollment=(await pool.query('select *,starts_on::text as start_date from public.selc_enrollments where id=$1',[registration.enrollment_id])).rows[0];values.start_date=enrollment.start_date;values.level=enrollment.level_code;teacher=(await pool.query('select * from public.selc_teachers where id=$1',[enrollment.teacher_id])).rows[0];values.teacher_name=teacher.full_name;values.teacher_email=teacher.email;}
  if(kind==='registration-approved')kind=shiftDay(values.start_date,-2)<isoDay()?'registration-approved-late':'registration-approved';
 }
 if(p.submissionId){submission=(await pool.query('select * from public.selc_submissions where id=$1',[p.submissionId])).rows[0];if(!submission)return;values={...submission,student_name:submission.student_name_snapshot,student_email:submission.student_email_snapshot};email=submission.student_email_snapshot;name=submission.student_name_snapshot;}
 if(p.teacherId){teacher=(await pool.query('select * from public.selc_teachers where id=$1 and active',[p.teacherId])).rows[0];if(!teacher)return;email=teacher.email;name=teacher.full_name;values.teacher_name=teacher.full_name;values.review_url=p.review_url||'';}
 if(p.documentId){const doc=(await pool.query("select * from public.selc_documents where id=$1 and status='READY'",[p.documentId])).rows[0];if(!doc)throw Error('DOCUMENT_NOT_READY');values.document_url=documentUrl(doc.id);values.feedback_url=values.document_url;
  if(p.reportId){const report=(await pool.query('select * from public.selc_teacher_reports where id=$1',[p.reportId])).rows[0];teacher=(await pool.query('select * from public.selc_teachers where id=$1 and active',[report.teacher_id])).rows[0];if(!teacher)return;email=teacher.email;name=teacher.full_name;values.teacher_name=teacher.full_name;values.report_date=report.report_key;}
 }
 if(p.recipientId){const row=(await pool.query(`select r.*,s.phone,s.feedback_language,t.content_json,t.id as topic_id,c.scheduled_on::text as practice_date from public.selc_speaking_recipients r join public.selc_active_enrollments e on e.id=r.enrollment_id join public.selc_students s on s.id=r.student_id join public.selc_speaking_topics t on t.id=r.topic_id join public.selc_speaking_cycles c on c.id=r.cycle_id where r.id=$1`,[p.recipientId])).rows[0];if(!row)return;email=row.student_email_snapshot;name=row.student_name_snapshot;values={student_name:name,level:row.level_code,practice_date:row.practice_date,practice_url:practiceUrl(row.topic_id),topics_html:topicHtml(row.content_json)};}
 if(kind==='prestart-reminder'){
  const row=(await pool.query(`select e.*,e.starts_on::text as start_date,s.full_name,s.phone,s.email,t.full_name as teacher_name,t.email as teacher_email from public.selc_enrollments e join public.selc_students s on s.id=e.student_id join public.selc_teachers t on t.id=e.teacher_id where e.id=$1 and e.status in('SCHEDULED','ACTIVE') and t.active`,[p.enrollmentId])).rows[0];if(!row)return;email=row.teacher_email;name=row.teacher_name;values={student_name:row.full_name,student_email:row.email,start_date:row.start_date,level:row.level_code,teacher_name:row.teacher_name,student_phone:row.phone||'Unavailable'};
  values.prestart_introduction=shiftDay(row.start_date,-2)===isoDay()?row.full_name+' is scheduled to start with Smart English Learning Center in two days. Please contact the student today.':row.full_name+'’s start date is '+row.start_date+'. Their registration has been approved; please contact the student as soon as possible to help them get started.';
  const message=await content('prestart-whatsapp.txt');values.whatsapp_url=wa(row.phone,fillPlain(message,values));
 }
 values.reason=values.decision_reason||'';values.rejection_reason=values.decision_reason||'';
 if(!email)throw Error('NOTICE_RECIPIENT_MISSING');
 const rendered=await renderMail(kind,values);
 await enqueueMail(pool,{key:'notice:'+kind+':'+(p.registrationId||p.submissionId||p.recipientId||p.enrollmentId||p.reportId||p.documentId)+':'+(p.teacherId||email),kind,email,name,subject:rendered.subject,payload:{...p,...values,html:rendered.html},registrationId:p.registrationId,submissionId:p.submissionId,documentId:p.documentId,recipientId:p.recipientId,reportId:p.reportId});
}
async function eligible(pool,row){
 if(row.speaking_recipient_id)return !!(await pool.query('select r.id from public.selc_speaking_recipients r join public.selc_active_enrollments e on e.id=r.enrollment_id where r.id=$1',[row.speaking_recipient_id])).rows.length;
 if(row.email_kind==='feedback-ready')return !!(await pool.query('select s.id from public.selc_submissions s join public.selc_active_enrollments e on e.id=s.enrollment_id where s.id=$1',[row.submission_id])).rows.length;
 if(['planning-reminder','SELC_PLANNING_REMINDER'].includes(row.email_kind))return (await pool.query('select * from public.selc_missing_plan_levels($1)',[row.payload_json.delivery_date])).rows.length>0;
 if(row.email_kind==='prestart-reminder')return !!(await pool.query("select id from public.selc_enrollments where id=$1 and status in('ACTIVE','SCHEDULED')",[row.payload_json.enrollmentId])).rows.length;
 return true;
}
export async function deliverOne(pool,{fetchImpl=fetch}={}){
 const apiKey=need('BREVO_API_KEY');
 const row=await tx(pool,async db=>{
  const result=(await db.query(`select * from public.selc_email_outbox where status in('PENDING','FAILED') and available_at<=now() and attempt_count<5 order by available_at,created_at for update skip locked limit 1`)).rows[0];
  if(!result)return null;
  // Render planning messages before marking SENDING, so missing approved text cannot lose email.
  if(!result.payload_json.html){const kind=result.email_kind==='SELC_PLANNING_INVITATION'?'planning-invitation':'planning-reminder';const rendered=await renderMail(kind,result.payload_json);result.payload_json.html=rendered.html;result.subject=rendered.subject;await db.query('update public.selc_email_outbox set subject=$2,payload_json=$3 where id=$1',[result.id,result.subject,JSON.stringify(result.payload_json)]);}
  if(!await eligible(db,result)){await db.query("update public.selc_email_outbox set status='CANCELLED' where id=$1",[result.id]);return null;}
  await db.query("update public.selc_email_outbox set status='SENDING',send_started_at=now(),attempt_count=attempt_count+1 where id=$1",[result.id]);return result;
 });
 if(!row)return false;
 let response;
 try{response=await fetchImpl('https://api.brevo.com/v3/smtp/email',{method:'POST',headers:{'api-key':apiKey,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({sender:{email:process.env.BREVO_SENDER_EMAIL||'olivier@smartenglishlearningcenter.com',name:process.env.BREVO_SENDER_NAME||'Smart English Learning Center'},to:[{email:row.recipient_email,name:row.recipient_name||''}],subject:row.subject,htmlContent:row.payload_json.html,headers:{idempotencyKey:row.id},tags:['selc-'+row.id]}),signal:AbortSignal.timeout(45000)});}catch{await pool.query("update public.selc_email_outbox set status='UNKNOWN',last_error='BREVO_RESPONSE_UNKNOWN' where id=$1 and status='SENDING'",[row.id]);return false;}
 if(!response.ok){const knownRejection=response.status>=400&&response.status<500;await pool.query(`update public.selc_email_outbox set status=$2,last_error=$3,available_at=now()+interval '10 minutes' where id=$1 and status='SENDING'`,[row.id,knownRejection?'FAILED':'UNKNOWN','BREVO_HTTP_'+response.status]);return false;}
 let data;try{data=await response.json();}catch{}
 if(!data?.messageId){await pool.query("update public.selc_email_outbox set status='UNKNOWN',last_error='BREVO_RECEIPT_MISSING' where id=$1 and status='SENDING'",[row.id]);return false;}
 await pool.query("update public.selc_email_outbox set status='ACCEPTED',provider_message_id=$2,accepted_at=now(),last_error=null where id=$1 and status in('SENDING','UNKNOWN')",[row.id,data.messageId]);return true;
}
