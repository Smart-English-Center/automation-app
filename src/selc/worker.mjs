import {queue,isoDay} from './core.mjs';
import {importEvent} from './imports.mjs';
import {queueReviewNotification} from './decisions.mjs';
import {notice,deliverOne} from './mail.mjs';
import {correctSubmission} from './corrections.mjs';
import {generateDocument} from './documents.mjs';
import {generateTopics,topicReport} from './topics.mjs';
import {teacherDigest} from './digests.mjs';
import {scheduleDue,planningMail} from './schedule.mjs';
export const handlers={IMPORT:importEvent,REVIEW_NOTIFICATION:queueReviewNotification,NOTICE:notice,CORRECT:correctSubmission,DOCUMENT:generateDocument,TOPICS:generateTopics,TOPICS_REPORT:topicReport,DIGEST:teacherDigest,PLANNING_MAIL:async(pool,p)=>planningMail(pool,p.day)};
export async function runOne(pool,{workerId='selc-'+process.pid,handlersOverride=handlers}={}){
 const job=(await pool.query('select * from public.selc_claim_job($1,1200)',[workerId])).rows[0];if(!job)return false;
 let lost=false;
 const renew=setInterval(()=>{pool.query("update public.selc_jobs set locked_until=now()+interval '20 minutes' where id=$1 and status='RUNNING' and lease_token=$2 returning id",[job.id,job.lease_token]).then(r=>{if(!r.rows.length)lost=true;}).catch(()=>{lost=true;});},30000);renew.unref();
 try{
  const handler=handlersOverride[job.job_type];if(!handler)throw Error('UNKNOWN_JOB_TYPE');await handler(pool,job.payload_json);
  if(lost)throw Error('JOB_LEASE_LOST');
  await pool.query("update public.selc_jobs set status='SUCCEEDED',finished_at=now(),locked_by=null,locked_until=null,lease_token=null,last_error=null where id=$1 and status='RUNNING' and lease_token=$2",[job.id,job.lease_token]);
 }catch(error){
  const raw=String(error?.message||''),safe=/^[A-Z0-9_:-]+$/.test(raw)?raw:'JOB_FAILED';
  const waiting=error.retryAt||raw.startsWith('APPROVED_CONTENT_MISSING:')||raw==='CORRECTION_REQUIRES_APPROVED_ACTIVE_SUBMISSION';
  const retryAt=error.retryAt||new Date(Date.now()+(waiting?10:Math.min(360,2**job.attempt_count))*60000);
  const dead=!waiting&&job.attempt_count>=job.max_attempts;
  await pool.query(`update public.selc_jobs set status=$3,last_error=$4,available_at=$5,attempt_count=case when $6 then 0 else attempt_count end,finished_at=case when $3='DEAD' then now() else null end,locked_by=null,locked_until=null,lease_token=null where id=$1 and status='RUNNING' and lease_token=$2`,[job.id,job.lease_token,dead?'DEAD':'RETRY',safe,retryAt,!!waiting]);
  console.error(JSON.stringify({event:'SELC_JOB_ERROR',jobId:job.id,type:job.job_type,code:safe}));
 }finally{clearInterval(renew);}
 return true;
}
export function startWorker(pool){
 const timers=[];let stopped=false;
 function independentLoop(callback,ms){let busy=false;const run=async()=>{if(busy||stopped)return;busy=true;try{await callback();}catch(error){console.error(JSON.stringify({event:'SELC_LOOP_ERROR',code:String(error.message||'').startsWith('APPROVED_CONTENT_MISSING:')?error.message:'WORKER_LOOP_FAILED'}));}finally{busy=false;}};const timer=setInterval(run,ms);timer.unref();timers.push(timer);void run();}
 if(process.env.ENABLE_INTERNAL_WORKER_LOOP==='true'){
  independentLoop(()=>scheduleDue(pool),30000);
  independentLoop(()=>runOne(pool),5000);
  if(process.env.SELC_EMAIL_DELIVERY_ENABLED==='true')independentLoop(async()=>{for(let i=0;i<10;i++){if(!await deliverOne(pool))break;}},5000);
 }
 return ()=>{stopped=true;for(const timer of timers)clearInterval(timer);};
}
