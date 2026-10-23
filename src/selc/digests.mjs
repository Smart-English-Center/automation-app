import {isoDay,queue,shiftDay,step,tx,wa} from './core.mjs';
import {chat} from './providers.mjs';
import {buildTeacherDigestWindow,applyTeacherDigestCatchUpWindow} from './digestWindows.mjs';
import {buildDigestBatch,buildDigestStudentRequest} from './digestPayload.mjs';
import {calculateWeeklyMetric,hasThreeCompleteInactiveDays,isLastSundayOfMonth} from './digestPersonalisation.mjs';
import {LOCKED_TEACHER_DIGEST_PROMPT} from './digestPrompt.mjs';
import {validateDigestBatchResponse} from './digestValidator.mjs';
import {documentUrl} from './documents.mjs';
const asDate=v=>v instanceof Date?v.toISOString():String(v||'');
async function evidence(pool,teacherId,cycleDate){
 const snapshot=new Date().toISOString();
 const previous=(await pool.query(`select r.report_json,r.window_end_exclusive,o.accepted_at from public.selc_teacher_reports r join public.selc_documents d on d.teacher_report_id=r.id join public.selc_email_outbox o on o.document_id=d.id where r.teacher_id=$1 and r.report_kind='PROGRESS_DIGEST' and r.report_key<$2 and o.status in('ACCEPTED','DELIVERED') order by r.report_key desc`,[teacherId,cycleDate])).rows;
 const window=applyTeacherDigestCatchUpWindow(buildTeacherDigestWindow({cycleDate}),{previousActivityEnd:previous[0]?.window_end_exclusive,previousDigestSentAt:previous[0]?.accepted_at,snapshotAt:snapshot});
 const included=new Set(previous.flatMap(p=>(p.report_json.all_students||[]).flatMap(s=>(s.assignment_feedback_sent||[]).map(f=>f.document_id))));
 const students=(await pool.query(`select e.*,e.starts_on::text as start_date,s.full_name as student_name,s.email as student_email,s.phone as student_phone from public.selc_active_enrollments e join public.selc_students s on s.id=e.student_id where e.teacher_id=$1 order by s.full_name,e.student_id`,[teacherId])).rows;
 const rows=[];
 for(const student of students){
  const all=(await pool.query(`select *,assignment_title as assignment_key,speaking_answer_source as audio_link from public.selc_submissions where student_id=$1 and submitted_at<$2 order by submitted_at`,[student.student_id,window.activity_window_end_exclusive])).rows;
  student.level=student.level_code;
  const last=all.at(-1);
  const recent=all.filter(s=>asDate(s.submitted_at)>=shiftDay(cycleDate,-35)+'T00:00:00.000Z');
  const feedback=(await pool.query(`select d.id as document_id,s.assignment_title as assignment_key,s.id as submission_id,f.feedback_json,o.status as email_status,o.delivered_at,o.accepted_at from public.selc_documents d join public.selc_final_feedback f on f.id=d.feedback_id join public.selc_submissions s on s.id=f.submission_id left join public.selc_email_outbox o on o.document_id=d.id and o.email_kind='feedback-ready' where s.student_id=$1 and d.status='READY' and d.created_at<=$2 order by d.created_at`,[student.student_id,snapshot])).rows;
  const displayed=feedback.filter(f=>!included.has(f.document_id)).map(f=>({...f,feedback_link:documentUrl(f.document_id),pdf_url:documentUrl(f.document_id),writing_status:f.feedback_json.writing.status==='assessed'?'REVIEWED':'NOT_ASSESSED',speaking_status:f.feedback_json.speaking.status==='assessed'?'REVIEWED':'NOT_ASSESSED'}));
  const delivered=displayed.filter(f=>f.email_status==='DELIVERED'&&asDate(f.delivered_at)>=window.feedback_window_start&&asDate(f.delivered_at)<=snapshot);
  const period=recent.filter(s=>asDate(s.submitted_at)>=window.activity_window_start&&asDate(s.submitted_at)<window.activity_window_end_exclusive);
  let metrics=[];
  if(window.cycle_day==='SUNDAY')for(let n=3;n>=0;n--){const metric=calculateWeeklyMetric({student,weekStart:shiftDay(cycleDate,-7-n*7),submissions:recent,quizzes:[],feedback:displayed});if(metric)metrics.push(metric);}
  const facts={cycle_date:cycleDate,cycle_day:window.cycle_day,is_last_sunday_of_month:isLastSundayOfMonth(cycleDate),last_submission_at:last?asDate(last.submitted_at):'',last_assignment_at:last?asDate(last.submitted_at):'',last_writing_at:last?asDate(last.submitted_at):'',last_speaking_at:last?asDate(last.submitted_at):'',has_ever_submitted:!!last,window_submissions:period,window_quizzes:[],unseen_feedback:displayed,unseen_quizzes:[],feedback_deliveries:delivered,current_metric:metrics.at(-1)||null,previous_metric:metrics.at(-2)||null,four_week_metrics:metrics};
  const follow=hasThreeCompleteInactiveDays({cycleDate,lastActivityAt:facts.last_submission_at,enrollmentStart:student.start_date});
  rows.push({student,facts,follow,period,displayed,delivered});
 }
 return {window,snapshot,rows};
}
export async function teacherDigest(pool,{teacherId,cycleDate},{chatImpl=chat}={}){
 const teacher=(await pool.query('select * from public.selc_teachers where id=$1 and active',[teacherId])).rows[0];if(!teacher)return;
 const snapshot=await step(pool,'digest-evidence:'+teacherId+':'+cycleDate,()=>evidence(pool,teacherId,cycleDate));
 if(!snapshot.rows.length)return;
 const requests=snapshot.rows.map(r=>buildDigestStudentRequest({requestId:r.student.student_id,student:r.student,facts:r.facts,window:snapshot.window}));
 const messages=new Map();
 for(let i=0;i<requests.length;i+=10){
  const batch=buildDigestBatch({batch_id:'selc:'+teacherId+':'+cycleDate+':'+i,students:requests.slice(i,i+10)});
  const result=await step(pool,'digest-messages:'+batch.batch_id,async()=>{
   const generated=await chatImpl({task:'digest',prompt:LOCKED_TEACHER_DIGEST_PROMPT,input:batch});
   const validation=validateDigestBatchResponse({expectedBatch:batch,response:generated.output});if(!validation.ok)throw Error('DIGEST_MESSAGE_VALIDATION_FAILED');return generated.output;
  });
  for(const message of result.messages)messages.set(message.request_id,message.message||message.message_text);
 }
 const all=snapshot.rows.map(r=>({student_id:r.student.student_id,student_name:r.student.student_name,student_short_name:r.student.student_name,level:r.student.level_code,assignment_submission_count:r.period.length,feedback_email_count:r.delivered.length,quiz_submission_count:0,assignment_feedback_sent:r.displayed,feedback_link:r.displayed.at(-1)?.feedback_link||'',quiz_scores:[],needs_teacher_follow_up:r.follow,whatsapp_url:wa(r.student.student_phone,messages.get(r.student.student_id)||'')}));
 const summary={active_student_count:all.length,assignment_submission_count:all.reduce((n,s)=>n+s.assignment_submission_count,0),feedback_emails_sent_count:all.reduce((n,s)=>n+s.feedback_email_count,0),students_needing_follow_up_count:all.filter(s=>s.needs_teacher_follow_up).length};
 const parts=Math.ceil(all.length/25);
 for(let i=0;i<parts;i++){
  const selected=all.slice(i*25,(i+1)*25);
  const payload={preview_mode:false,quizzes_enabled:false,teacher:{teacher_name:teacher.full_name,teacher_email:teacher.email},summary,all_students:selected,document:{...snapshot.window,cycle_date:cycleDate,snapshot_at:snapshot.snapshot,part_number:i+1,total_parts:parts,student_range_label:`Students ${i*25+1}-${i*25+selected.length}`},sections:{needs_encouragement:selected.filter(s=>s.needs_teacher_follow_up),students_with_activity:selected.filter(s=>!s.needs_teacher_follow_up)}};
  await tx(pool,async db=>{
   const report=(await db.query(`insert into public.selc_teacher_reports(teacher_id,report_kind,report_key,window_start,window_end_exclusive,report_json,status) values($1,'PROGRESS_DIGEST',$2,$3,$4,$5,'READY') on conflict(teacher_id,report_kind,report_key) do update set report_key=excluded.report_key returning id`,[teacherId,cycleDate+':part'+(i+1),snapshot.window.activity_window_start,snapshot.window.activity_window_end_exclusive,JSON.stringify(payload)])).rows[0];
   await queue(db,'digest-pdf:'+report.id,'DOCUMENT',{kind:'TEACHER_DIGEST',key:'digest:'+report.id,reportId:report.id,payload});
  });
 }
}
