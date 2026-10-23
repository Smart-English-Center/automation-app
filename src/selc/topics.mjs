import {content,isoDay,queue,step,tx,wa} from './core.mjs';
import {chat} from './providers.mjs';
import {getGenerationInput,validatePack} from './planning.mjs';
import {practiceUrl} from './documents.mjs';
export async function generateTopics(pool,{deliveryDate,level},{chatImpl=chat}={}){
 // Do not replay an old delivery on a different calendar day.
 if(isoDay()>deliveryDate)return;
 const input=await getGenerationInput(pool,{level,deliveryDate});
 if(input.status==='WAITING_FOR_PLAN')throw Object.assign(Error('WAITING_FOR_PLAN'),{retryAt:new Date(Date.now()+5*60000)});
 const cycle=(await pool.query(`insert into public.selc_speaking_cycles(scheduled_on) values($1) on conflict(scheduled_on) do update set scheduled_on=excluded.scheduled_on returning *`,[deliveryDate])).rows[0];
 let topic=(await pool.query("select * from public.selc_speaking_topics where cycle_id=$1 and level_code=$2 and status='READY'",[cycle.id,level])).rows[0];
 if(!topic){
  const generated=await step(pool,'topic:'+cycle.id+':'+level+':'+input.revision_id,async()=>chatImpl({task:'topics',prompt:await content('topics.txt'),input:{...input,default_instruction_language:'fr',teacher_explicit_language_instruction_takes_precedence:true,topics_required:2}}));
  const pack=validatePack(generated.output);
  for(const t of pack.topics)if(t.role_play&&(!t.role_play.scenario||!t.role_play.role_a?.name||!t.role_play.role_a?.instructions||!t.role_play.role_b?.name||!t.role_play.role_b?.instructions))throw Error('INCOMPLETE_ROLE_PLAY');
  for(const t of pack.topics){t.instruction_language=t.instruction_language||('fr');if(t.role_play===undefined)t.role_play=null;}
  topic=await tx(pool,async db=>{
   await db.query('select pg_advisory_xact_lock(70261301)');
   const latest=await getGenerationInput(db,{level,deliveryDate});if(latest.revision_id!==input.revision_id)throw Error('PLANNING_CHANGED_DURING_GENERATION');
   // Insert DRAFT, then publish. This honours v2's READY-content trigger.
   const row=(await db.query(`insert into public.selc_speaking_topics(cycle_id,level_code,title,instructions,content_version,content_json,plan_revision_id,provider,model,prompt_version,status) values($1,$2,$3,$4,'SELC_SPEAKING_PACK_V2',$5,$6,'openrouter',$7,'SELC_APPROVED_CONTENT_V1','DRAFT') on conflict(cycle_id,level_code) do update set title=excluded.title,instructions=excluded.instructions,content_json=excluded.content_json,plan_revision_id=excluded.plan_revision_id,model=excluded.model where selc_speaking_topics.status<>'READY' returning *`,[cycle.id,level,pack.topics.map(t=>t.title).join(' / '),input.instructions,JSON.stringify(pack),input.revision_id,generated.model])).rows[0];
   if(!row)throw Error('TOPIC_PUBLISHED_CONCURRENTLY');await db.query("update public.selc_speaking_topics set status='READY' where id=$1",[row.id]);return row;
  });
 }
 await tx(pool,async db=>{
  await db.query('select public.selc_activate_due_enrollments()');
  const students=(await db.query(`select e.*,s.full_name,s.email from public.selc_active_enrollments e join public.selc_students s on s.id=e.student_id where e.level_code=$1`,[level])).rows;
  const teachers=new Set();
  for(const student of students){
   const r=(await db.query(`insert into public.selc_speaking_recipients(cycle_id,topic_id,level_code,student_id,enrollment_id,teacher_id,student_name_snapshot,student_email_snapshot) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(cycle_id,student_id) do nothing returning id`,[cycle.id,topic.id,level,student.student_id,student.id,student.teacher_id,student.full_name,student.email])).rows[0];
   if(r)await queue(db,'topic-notice:'+r.id,'NOTICE',{kind:'topics-delivery',recipientId:r.id});teachers.add(student.teacher_id);
  }
  for(const teacherId of teachers)await queue(db,'topics-report:'+cycle.id+':'+level+':'+teacherId,'TOPICS_REPORT',{cycleId:cycle.id,topicId:topic.id,teacherId,level,deliveryDate});
 });
}
export async function topicReport(pool,p){
 const {cycleId,topicId,teacherId,level,deliveryDate}=p;
 const teacher=(await pool.query('select * from public.selc_teachers where id=$1 and active',[teacherId])).rows[0];if(!teacher)return;
 const topic=(await pool.query("select * from public.selc_speaking_topics where id=$1 and status='READY'",[topicId])).rows[0];if(!topic)throw Error('TOPIC_NOT_READY');
 const recipients=(await pool.query(`select r.*,s.phone,o.status as delivery_status,o.id as email_id from public.selc_speaking_recipients r join public.selc_students s on s.id=r.student_id join public.selc_active_enrollments e on e.id=r.enrollment_id left join public.selc_email_outbox o on o.speaking_recipient_id=r.id where r.cycle_id=$1 and r.teacher_id=$2 and r.level_code=$3 order by r.student_name_snapshot,r.id`,[cycleId,teacherId,level])).rows;
 if(recipients.some(r=>!r.email_id||['PENDING','SENDING'].includes(r.delivery_status)))throw Object.assign(Error('WAITING_FOR_TOPIC_EMAIL_ATTEMPTS'),{retryAt:new Date(Date.now()+5*60000)});
 const parts=Math.ceil(recipients.length/25);
 for(let n=0;n<parts;n++){
  const students=recipients.slice(n*25,(n+1)*25).map(r=>({student_id:r.student_id,student_name:r.student_name_snapshot,level:r.level_code,email_delivery_status:r.delivery_status||'Unknown',whatsapp_url:wa(r.phone,practiceUrl(topicId))}));
  const payload={preview_mode:false,teacher:{teacher_name:teacher.full_name,teacher_email:teacher.email},document:{practice_date:deliveryDate,level,part_number:n+1,total_parts:parts},topics:topic.content_json.topics,recipients:students};
  await tx(pool,async db=>{
   const key=deliveryDate+':'+level+':part'+(n+1);
   const report=(await db.query(`insert into public.selc_teacher_reports(teacher_id,report_kind,report_key,speaking_cycle_id,report_json,status) values($1,'SPEAKING_RECIPIENTS',$2,$3,$4,'READY') on conflict(teacher_id,report_kind,report_key) do update set report_key=excluded.report_key returning id`,[teacherId,key,cycleId,JSON.stringify(payload)])).rows[0];
   await queue(db,'topic-report-pdf:'+report.id,'DOCUMENT',{kind:'TEACHER_SPEAKING_TOPICS',key:'topic-report:'+report.id,reportId:report.id,payload});
  });
 }
}
