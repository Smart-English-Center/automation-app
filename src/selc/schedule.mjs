import {content,enqueueMail,isoDay,queue,shiftDay,dayOf,tx,baseUrl} from './core.mjs';
import {queuePlanningInvitation} from './planning.mjs';
import {renderMail} from './mail.mjs';
export function nextMonday(day){const weekday=dayOf(day);return shiftDay(day,weekday===0?1:8-weekday);}
export function nextTopicDay(day){let value=day;while(![1,4].includes(dayOf(value)))value=shiftDay(value,1);return value;}
async function planningMail(pool,day){
 const main=(await pool.query('select * from public.selc_teachers where active and is_main_teacher')).rows[0];if(!main)throw Error('MAIN_TEACHER_NOT_CONFIGURED');
 const weekly=[5,0].includes(dayOf(day)),deliveryDate=nextTopicDay(day),weekStart=weekly?nextMonday(day):shiftDay(day,(dayOf(day)+6)%7*-1);
 const missing=(await pool.query('select * from public.selc_missing_plan_levels($1)',[deliveryDate])).rows.map(r=>r.level_code);
 let invitation=(await pool.query("select payload_json from public.selc_email_outbox where idempotency_key=$1",['selc-planning-invitation:'+weekStart])).rows[0]?.payload_json;
 if(weekly){
  // Missing approved content must not rotate and close an existing editable link.
  await content('planning-invitation.html');await content('planning-invitation-subject.txt');
  invitation=await queuePlanningInvitation(pool,{weekStart,teacherId:main.id,baseUrl:baseUrl(),subject:(await content('planning-invitation-subject.txt')).trim()});
  // Friday's invitation is also that day's missing-plan reminder. Sunday reuses its link.
  if(dayOf(day)===5)return;
 }
 if(!missing.length&&!weekly)return;
 if(!invitation){
  // Bootstrap a current-week link when the service first starts on another day.
  await content('planning-invitation.html');await content('planning-invitation-subject.txt');
  invitation=await queuePlanningInvitation(pool,{weekStart,teacherId:main.id,baseUrl:baseUrl(),subject:(await content('planning-invitation-subject.txt')).trim()});
  return;
 }
 const values={...invitation,teacher_name:main.full_name,missing_levels:missing.join(', '),delivery_date:deliveryDate};
 const rendered=await renderMail(weekly?'planning-invitation':'planning-reminder',values);
 await enqueueMail(pool,{key:'planning-mail:'+day,kind:weekly?'planning-invitation':'planning-reminder',email:main.email,name:main.full_name,subject:rendered.subject,payload:{...values,html:rendered.html}});
}
export async function scheduleDue(pool,now=new Date()){
 const day=isoDay(now),hour=now.getUTCHours();
 await tx(pool,async db=>{
  await db.query('select public.selc_activate_due_enrollments()');
  // Catch up durable import events retained before registration/start-date activation.
  await db.query(`update public.selc_jobs set status='RETRY',available_at=now(),attempt_count=0,finished_at=null where job_type='IMPORT' and status='DEAD' and last_error='IMPORT_WAITING_FOR_ACTIVE_ENROLLMENT' and exists(select 1 from public.selc_import_events i join public.selc_students s on s.email=lower(btrim(i.payload->'answers'->>'student_email')) join public.selc_active_enrollments e on e.student_id=s.id where i.id=(payload_json->>'eventId')::uuid)`);
  if(hour>=6&&[1,4].includes(dayOf(day))){const levels=(await db.query('select distinct level_code from public.selc_active_enrollments')).rows;for(const row of levels)await queue(db,'topics:'+day+':'+row.level_code,'TOPICS',{deliveryDate:day,level:row.level_code});}
  if(hour>=7){
   await queue(db,'planning-schedule:'+day,'PLANNING_MAIL',{day});
   if([3,5,0].includes(dayOf(day))){const teachers=(await db.query('select distinct teacher_id from public.selc_active_enrollments')).rows;for(const row of teachers)await queue(db,'digest:'+day+':'+row.teacher_id,'DIGEST',{cycleDate:day,teacherId:row.teacher_id});}
  }
  const starts=(await db.query(`select e.id,e.starts_on::text as start_date from public.selc_enrollments e join public.selc_registration_requests r on r.enrollment_id=e.id where e.status in('SCHEDULED','ACTIVE') and r.status='APPROVED' and ((e.starts_on=current_date+2 and $1::integer>=7) or (e.starts_on>=current_date and e.starts_on<current_date+2) or (e.starts_on<current_date and r.decided_at>=((e.starts_on-2)::timestamp at time zone 'UTC')))` ,[hour])).rows;
  for(const row of starts)await queue(db,'prestart:'+row.id+':'+row.start_date,'NOTICE',{kind:'prestart-reminder',enrollmentId:row.id});
  await db.query("update public.selc_email_outbox set status='UNKNOWN',last_error='SEND_RESULT_NOT_CONFIRMED' where status='SENDING' and send_started_at<now()-interval '10 minutes'");
 });
}
export {planningMail};
