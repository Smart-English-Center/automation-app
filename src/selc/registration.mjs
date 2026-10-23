import {queue} from './core.mjs';
// The existing approval-link handler must verify its decision token first.
// actorTeacherId must come from that verified token, never a browser field.
export const startDateField='<label for="starts_on">Start date (GMT+0)</label><input type="date" id="starts_on" name="starts_on" required>';
export async function approveRegistration(pool,{requestId,actorTeacherId,assignedTeacherId,level,startDate}){
 if(!['A1','A2','B1','B2','C1'].includes(level)||!/^\d{4}-\d{2}-\d{2}$/.test(startDate??''))throw Error('Level and start date required');
 const parsed=new Date(startDate+'T00:00:00Z');if(Number.isNaN(parsed.getTime())||parsed.toISOString().slice(0,10)!==startDate)throw Error('Invalid start date');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const request=(await db.query('select * from public.selc_registration_requests where id=$1 for update',[requestId])).rows[0];
  if(!request)throw Error('Registration unavailable');
  const actor=(await db.query('select * from public.selc_teachers where id=$1 and active',[actorTeacherId])).rows[0];
  if(!actor||(!actor.is_main_teacher&&actor.email!==request.requested_teacher_email?.trim().toLowerCase()))throw Error('Teacher cannot approve this registration');
  if(request.status!=='PENDING'){await db.query('COMMIT');return {alreadyDecided:true,status:request.status};}
  if(!(await db.query('select id from public.selc_teachers where id=$1 and active',[assignedTeacherId])).rows.length)throw Error('Assigned teacher is unavailable');
  // Serialise all approvals for the same email, including distinct form responses.
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[request.student_email]);
  await db.query('insert into public.selc_students(full_name,email,phone,country,feedback_language) values($1,$2,$3,$4,$5) on conflict(email) do nothing',[request.student_name,request.student_email,request.student_phone,request.country,request.feedback_language]);
  const student=(await db.query('select * from public.selc_students where email=$1 for update',[request.student_email])).rows[0];
  if((await db.query("select id from public.selc_enrollments where student_id=$1 and status in('SCHEDULED','ACTIVE','PAUSED')",[student.id])).rows.length)throw Error('Student already has a current enrollment');
  const enrollment=(await db.query(`insert into public.selc_enrollments(student_id,teacher_id,level_code,starts_on,status) values($1,$2,$3,$4,case when $4::date>(clock_timestamp() at time zone 'UTC')::date then 'SCHEDULED' else 'ACTIVE' end) returning *`,[student.id,assignedTeacherId,level,startDate])).rows[0];
  await db.query('update public.selc_students set active=$2 where id=$1',[student.id,enrollment.status==='ACTIVE']);
  await db.query(`update public.selc_registration_requests set status='APPROVED',assigned_teacher_id=$2,assigned_level_code=$3,student_id=$4,enrollment_id=$5,decided_by_teacher_id=$6,decided_at=clock_timestamp() where id=$1`,[requestId,assignedTeacherId,level,student.id,enrollment.id,actorTeacherId]);
  await db.query('update public.selc_decision_tokens set used_at=now() where registration_request_id=$1 and recipient_teacher_id=$2',[requestId,actorTeacherId]);
  await db.query(`insert into public.selc_audit_events(actor_teacher_id,entity_type,entity_id,action,details) values($1,'registration',$2,'APPROVED',$3)`,[actorTeacherId,requestId,JSON.stringify({level,startDate,assignedTeacherId})]);
  await queue(db,'registration-approved:'+requestId,'NOTICE',{kind:'registration-approved',registrationId:requestId});
  await db.query('COMMIT');
  return {studentId:student.id,enrollmentId:enrollment.id,status:enrollment.status,startDate};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
