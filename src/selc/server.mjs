import express from 'express';
import crypto from 'node:crypto';
import {getSupabasePool} from '../supabase/client.js';
import {baseUrl,contentStatus,environmentStatus,equal,hash,need,queue,setPrivateHeaders,tx} from './core.mjs';
import {registerImportRoutes} from './imports.mjs';
import {registerDecisionRoutes} from './decisions.mjs';
import {registerDocumentRoutes} from './documents.mjs';
import {planningHandler} from './planning.mjs';
import {runOne,startWorker} from './worker.mjs';
import {scheduleDue} from './schedule.mjs';
export function makeApp(pool){
 const app=express();app.disable('x-powered-by');
 const origin=baseUrl(),planning=planningHandler({db:pool,baseUrl:origin});
 app.get(['/health','/live'],(_req,res)=>res.json({ok:true,service:'selc-worker'}));
 // Planning reads its bounded raw form stream; mount before Express body parsers.
 app.use(async(req,res,next)=>{try{if(await planning(req,res))return;next();}catch(error){next(error);}});
 app.use(express.json({limit:'2mb'}));app.use(express.urlencoded({extended:false,limit:'64kb'}));
 app.get('/',(_req,res)=>res.json({service:'Smart English Learning Center',health:'/health'}));
 function admin(req,res,next){if(!equal(req.get('x-worker-admin-secret'),need('WORKER_ADMIN_SECRET')))return res.sendStatus(401);setPrivateHeaders(res);next();}
 app.get('/ready',admin,async(_req,res)=>{const versions=(await pool.query('select version from public.selc_schema_version order by version')).rows.map(r=>r.version),files=await contentStatus();const env=environmentStatus(),ready=versions.includes(4)&&files.every(f=>f.present)&&env.every(v=>v.present);res.status(ready?200:503).json({ok:ready,schemaVersions:versions,approvedContent:files,environment:env,quizImportEnabled:false});});
 app.get('/worker/status',admin,async(_req,res)=>res.json({jobs:(await pool.query('select job_type,status,count(*)::integer from public.selc_jobs group by job_type,status')).rows,email:(await pool.query('select status,count(*)::integer from public.selc_email_outbox group by status')).rows,content:await contentStatus()}));
 app.post('/worker/run-once',admin,async(_req,res)=>{await scheduleDue(pool);res.json({ok:true,processed:await runOne(pool)});});
 app.post('/worker/jobs/:id/retry',admin,async(req,res)=>{const result=await pool.query("update public.selc_jobs set status='RETRY',available_at=now(),attempt_count=0,last_error=null,finished_at=null where id=$1 and status in('DEAD','RETRY') returning id",[req.params.id]);res.json({ok:true,requeued:result.rows.length});});
 app.post('/worker/teachers',admin,async(req,res)=>{const name=String(req.body.full_name||'').trim(),email=String(req.body.email||'').trim().toLowerCase();if(!name||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({ok:false,status:'NAME_AND_EMAIL_REQUIRED'});const row=(await pool.query('insert into public.selc_teachers(full_name,email) values($1,$2) on conflict(email) do update set full_name=excluded.full_name returning id,full_name,email',[name,email])).rows[0];res.json({ok:true,teacher:row});});
 app.post('/worker/reviews/:kind/:id/renew',admin,async(req,res)=>{
  const kind=req.params.kind;if(!['REGISTRATION','ASSIGNMENT'].includes(kind))return res.sendStatus(400);
  const epoch=crypto.randomUUID();await queue(pool,'renew-review:'+epoch,'REVIEW_NOTIFICATION',{kind,id:req.params.id,epoch});res.json({ok:true});
 });
 app.post('/worker/email/:id/resolve',admin,async(req,res)=>{
  if(!['CONFIRMED_NOT_SENT','CONFIRMED_ACCEPTED'].includes(req.body.outcome))return res.sendStatus(400);
  if(req.body.outcome==='CONFIRMED_ACCEPTED'&&!String(req.body.message_id||'').trim())return res.status(400).json({ok:false,status:'PROVIDER_MESSAGE_ID_REQUIRED'});
  await tx(pool,async db=>{
   const state=req.body.outcome==='CONFIRMED_NOT_SENT'?'FAILED':'ACCEPTED';
   const r=await db.query(`update public.selc_email_outbox set status=$2,provider_message_id=case when $2='ACCEPTED' then $3 else provider_message_id end,accepted_at=case when $2='ACCEPTED' then now() else accepted_at end,available_at=now(),attempt_count=case when $2='FAILED' then 0 else attempt_count end,last_error=null where id=$1 and status='UNKNOWN' returning id`,[req.params.id,state,req.body.message_id||null]);
   if(r.rows.length)await db.query(`insert into public.selc_audit_events(entity_type,entity_id,action,details) values('email',$1,'ADMIN_RECONCILED',$2)`,[req.params.id,JSON.stringify({outcome:req.body.outcome})]);
  });res.json({ok:true});
 });
 registerImportRoutes(app,pool);registerDecisionRoutes(app,pool);registerDocumentRoutes(app,pool);
 app.post('/hooks/brevo',async(req,res)=>{
  if(!equal(req.get('x-selc-webhook-secret'),need('BREVO_WEBHOOK_SECRET')))return res.sendStatus(401);
  const event=req.body,messageId=event['message-id']||event.messageId||'',tags=Array.isArray(event.tags)?event.tags:String(event.tags||event.tag||'').split(',');
  const tag=tags.find(t=>/^selc-[0-9a-f-]{36}$/i.test(t));
  await tx(pool,async db=>{
   const outbox=(await db.query('select * from public.selc_email_outbox where provider_message_id=$1 or id::text=$2 limit 1 for update',[messageId||null,tag?.slice(5)||null])).rows[0];if(!outbox)return;
   const occurred=event.ts_event?new Date(Number(event.ts_event)*1000):new Date();
   await db.query('insert into public.selc_email_events(outbox_id,provider_event_key,event_type,occurred_at,payload_json) values($1,$2,$3,$4,$5) on conflict(provider_event_key) do nothing',[outbox.id,hash(JSON.stringify(event)),String(event.event||'UNKNOWN'),occurred,JSON.stringify(event)]);
   const state=event.event==='delivered'?'DELIVERED':['hard_bounce','soft_bounce','blocked','invalid'].includes(event.event)?'BOUNCED':event.event==='request'?'ACCEPTED':null;
   if(state)await db.query(`update public.selc_email_outbox set status=$2,provider_message_id=coalesce(provider_message_id,$3),accepted_at=coalesce(accepted_at,now()),delivered_at=case when $2='DELIVERED' then coalesce(delivered_at,$4) else delivered_at end where id=$1 and (status<>'DELIVERED' or $2='DELIVERED')`,[outbox.id,state,messageId||null,occurred]);
  });res.json({ok:true});
 });
 app.use((_req,res)=>res.sendStatus(404));
 app.use((error,req,res,_next)=>{if(res.headersSent)return;const status=error.httpStatus||500;console.error(JSON.stringify({event:'SELC_REQUEST_ERROR',code:status<500?error.message:'REQUEST_FAILED'}));res.status(status).json({ok:false,status:status<500?error.message:'REQUEST_FAILED'});});
 return app;
}
export function start(){
 for(const name of ['TZ','SCHEDULER_TIMEZONE','APP_TIMEZONE'])if(process.env[name]&&!['UTC','Etc/UTC'].includes(process.env[name]))throw Error('SELC_REQUIRES_UTC:'+name);
 const pool=getSupabasePool(),app=makeApp(pool);const stop=startWorker(pool),server=app.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log('SELC worker listening'));
 async function close(){stop();server.close();await pool.end();}
 process.once('SIGTERM',close);process.once('SIGINT',close);return {app,pool,server};
}
if(process.argv[1]&&new URL(import.meta.url).pathname===process.argv[1])start();
