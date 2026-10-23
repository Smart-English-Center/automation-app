import crypto from 'node:crypto';
import {baseUrl,csrf,e,equal,hash,page,queue,setPrivateHeaders,tx} from './core.mjs';
import {approveRegistration} from './registration.mjs';
export async function queueReviewNotification(pool,{kind,id,epoch='initial'}){
 await tx(pool,async db=>{
  const isRegistration=kind==='REGISTRATION',table=isRegistration?'selc_registration_requests':'selc_submissions';
  const item=(await db.query(`select * from public.${table} where id=$1`,[id])).rows[0];if(!item)return;
  const teachers=(await db.query(`select distinct * from public.selc_teachers where active and (is_main_teacher or ${isRegistration?'email=$1':'id=$1'})`,[isRegistration?item.requested_teacher_email:item.teacher_id])).rows;
  for(const teacher of teachers){
   const key='review-notice:'+kind+':'+id+':'+teacher.id+':'+epoch;
   if((await db.query('select id from public.selc_jobs where idempotency_key=$1',[key])).rows.length)continue;
   const token=crypto.randomBytes(32).toString('base64url'),url=baseUrl()+'/review/'+token;
   await db.query(`insert into public.selc_decision_tokens(registration_request_id,submission_id,recipient_teacher_id,token_hash,expires_at) values($1,$2,$3,$4,now()+interval '30 days')`,[isRegistration?id:null,isRegistration?null:id,teacher.id,hash(token)]);
   await queue(db,key,'NOTICE',{kind:isRegistration?'registration-review':'assignment-review',registrationId:isRegistration?id:null,submissionId:isRegistration?null:id,teacherId:teacher.id,review_url:url});
  }
 });
}
async function loadToken(db,token){
 const row=(await db.query(`select d.*,t.active,t.is_main_teacher,t.email from public.selc_decision_tokens d join public.selc_teachers t on t.id=d.recipient_teacher_id where token_hash=$1`,[hash(token)])).rows[0];
 if(!row||!row.active||row.revoked_at)throw Object.assign(Error('REVIEW_LINK_UNAVAILABLE'),{httpStatus:410});return row;
}
function originals(item,reg){if(reg)return `<p>${e(item.student_name)} - ${e(item.student_email)}</p><p>Requested teacher: ${e(item.requested_teacher_email)}</p>`;return [['Assignment',item.assignment_title],['Writing prompt',item.writing_prompt],['Writing answer',item.writing_answer],['Speaking prompt',item.speaking_prompt],['Audio link',item.speaking_answer_source],['Feedback language',item.feedback_language]].map(([name,v])=>`<h3>${name}</h3><pre>${e(v)}</pre>`).join('');}
export function registerDecisionRoutes(app,pool){
 app.get('/review/:token',async(req,res)=>{
  setPrivateHeaders(res);const token=await loadToken(pool,req.params.token),reg=!!token.registration_request_id;
  const item=(await pool.query(`select * from public.selc_registration_requests where id=$1`,[token.registration_request_id]).catch(()=>({rows:[]}))).rows[0];
  const record=reg?item:(await pool.query('select * from public.selc_submissions where id=$1',[token.submission_id])).rows[0];
  if(!record)throw Error('REVIEW_RECORD_MISSING');
  const pending=reg?record.status==='PENDING':!record.review_decision;
  if(!pending)return res.send(page('Final decision',`<p>This ${reg?'registration':'assignment'} has already been ${e(reg?record.status:record.review_decision)}.</p>`));
  if(new Date(token.expires_at)<new Date())return res.status(410).send(page('Link expired','<p>This review link has expired.</p>'));
  const teachers=(await pool.query('select * from public.selc_teachers where active order by full_name')).rows;
  const fields=reg?`<label>Assigned teacher<select name="teacher_id" required>${teachers.map(t=>`<option value="${t.id}"${t.email===record.requested_teacher_email?' selected':''}>${e(t.full_name)} - ${e(t.email)}</option>`).join('')}</select></label><label>Level<select name="level" required>${['A1','A2','B1','B2','C1'].map(l=>`<option>${l}</option>`).join('')}</select></label><label>Start date (GMT+0)<input name="starts_on" type="date" required></label>`:'';
  res.send(page(reg?'Registration review':'Assignment review',originals(record,reg)+`<form method="post"><input type="hidden" name="csrf" value="${csrf(req.params.token)}">${fields}<label>Reason for rejection<textarea name="reason" maxlength="5000"></textarea></label><button name="decision" value="APPROVED">Approve</button><button name="decision" value="REJECTED" formnovalidate>Reject</button></form>`));
 });
 app.post('/review/:token',async(req,res)=>{
  setPrivateHeaders(res);
  if(req.get('origin')!==baseUrl()||!equal(req.body.csrf,csrf(req.params.token)))return res.status(403).send('Invalid form request.');
  const token=await loadToken(pool,req.params.token),decision=req.body.decision;
  if(!['APPROVED','REJECTED'].includes(decision))throw Object.assign(Error('INVALID_DECISION'),{httpStatus:400});
  if(new Date(token.expires_at)<new Date())return res.status(410).send('Review link expired.');
  if(token.registration_request_id&&decision==='APPROVED'){
   await approveRegistration(pool,{requestId:token.registration_request_id,actorTeacherId:token.recipient_teacher_id,assignedTeacherId:req.body.teacher_id,level:req.body.level,startDate:req.body.starts_on});
  }else await tx(pool,async db=>{
   const reg=!!token.registration_request_id,id=token.registration_request_id||token.submission_id,table=reg?'selc_registration_requests':'selc_submissions';
   const row=(await db.query(`select * from public.${table} where id=$1 for update`,[id])).rows[0];if(!row)throw Error('REVIEW_RECORD_MISSING');
   if((reg&&row.status!=='PENDING')||(!reg&&row.review_decision))return;
   if(!token.is_main_teacher&&(reg?token.email!==row.requested_teacher_email:token.recipient_teacher_id!==row.teacher_id))throw Object.assign(Error('REVIEW_NOT_AUTHORISED'),{httpStatus:403});
   const reason=String(req.body.reason||'').trim();if(decision==='REJECTED'&&(!reason||reason.length>5000))throw Object.assign(Error('REJECTION_REASON_REQUIRED'),{httpStatus:400});
   await db.query(`update public.${table} set status=$2,${reg?'':'review_decision=$2,'}decision_reason=$3,decided_by_teacher_id=$4,decided_at=now() where id=$1`,[id,decision,reason||null,token.recipient_teacher_id]);
   await db.query('update public.selc_decision_tokens set used_at=now() where id=$1',[token.id]);
   if(decision==='REJECTED')await queue(db,'decision:'+table+':'+id,'NOTICE',{kind:reg?'registration-rejected':decision==='REJECTED'?'assignment-rejected':'assignment-approved',registrationId:reg?id:null,submissionId:reg?null:id});
   if(!reg&&decision==='APPROVED')await queue(db,'correct:'+id,'CORRECT',{submissionId:id});
   await db.query(`insert into public.selc_audit_events(actor_teacher_id,entity_type,entity_id,action,details) values($1,$2,$3,$4,$5)`,[token.recipient_teacher_id,table,id,decision,JSON.stringify({reason:reason||null})]);
  });
  res.redirect(303,req.path);
 });
}
