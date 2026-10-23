import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
export const LEVELS=['A1','A2','B1','B2','C1'];
export const hashToken=token=>createHash('sha256').update(token).digest('hex');
export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const csrf=token=>hashToken('SELC-planning-form:'+token);
export async function issuePlanningLink(db,{weekStart,teacherId,baseUrl}){
 const base=new URL(baseUrl);if(base.protocol!=='https:'||base.username||base.password)throw Error('HTTPS application URL required');
 const token=randomBytes(32).toString('base64url');
 const result=await db.query('select public.selc_open_planning_period($1,$2,$3) id',[weekStart,teacherId,hashToken(token)]);
 return {periodId:result.rows[0].id,url:new URL('/planning/'+token,base).href};
 // Retain the link in the protected email outbox. Reminders MUST reuse it.
 // Calling this again for the same week is rejected; do not rotate on reminder.
}
export async function getGenerationInput(db,{level,deliveryDate}){
 if(!LEVELS.includes(level)||!/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate))throw Error('Level and delivery date required');
 const day=new Date(deliveryDate+'T00:00:00Z');
 if(Number.isNaN(day.getTime())||day.toISOString().slice(0,10)!==deliveryDate||![1,4].includes(day.getUTCDay()))throw Error('Monday or Thursday delivery required');
 const {rows}=await db.query('select * from public.selc_resolve_speaking_plan($1,$2)',[level,deliveryDate]);
 if(!rows.length)return {status:'WAITING_FOR_PLAN',level,deliveryDate,topics:[],remindOlivier:true};
 return {status:'READY_TO_GENERATE',level,deliveryDate,topicsRequired:2,...rows[0]};
}
export function validatePack(pack){
 if(!pack||!Array.isArray(pack.topics)||pack.topics.length!==2)throw Error('Exactly two speaking topics required');
 for(const topic of pack.topics){
  if(!topic.title?.trim()||!topic.instructions?.trim()||!Array.isArray(topic.questions)||!topic.questions.length||topic.questions.some(q=>typeof q!=='string'||!q.trim()))throw Error('Incomplete speaking topic');
  if(topic.useful_language||topic.useful_expressions)throw Error('Useful-language section is excluded');
 }
 if(pack.topics[0].title.trim().toLowerCase()===pack.topics[1].title.trim().toLowerCase())throw Error('Distinct topic titles required');
 return pack;
 // There is no LLM review stage for topics; validate structure in code.
}
export async function missingPlanReminderCandidates(db,{deliveryDate,intervalHours,now=new Date()}){
 if(!Number.isFinite(intervalHours)||intervalHours<=0)throw Error('Choose a reminder interval before enabling reminders');
 const {rows}=await db.query('select * from public.selc_missing_plan_levels($1)',[deliveryDate]);
 if(!rows.length)return [];
 // One consolidated reminder, not five emails. Persist this key as outbox idempotency_key.
 const bucket=Math.floor(now.getTime()/(intervalHours*3600000));
 return [{idempotencyKey:`selc-planning-missing:${deliveryDate}:${bucket}`,recipient:'smartenglishlearningcenter@gmail.com',missingLevels:rows.map(r=>r.level_code),deliveryDate}];
}
function page(period,plans,token){
 const forms=LEVELS.map(level=>{
  const plan=plans.find(p=>p.level_code===level);
  return `<form method="post"><h2>${level}</h2><input type="hidden" name="level" value="${level}"><input type="hidden" name="revision" value="${plan?.revision??0}"><input type="hidden" name="csrf" value="${csrf(token)}"><label>What are you teaching? What should the LLM practise?<textarea name="instructions" required maxlength="12000" rows="7">${escapeHtml(plan?.instructions??'')}</textarea></label><p>${plan?'Saved this week.':'No plan saved this week. Last saved instructions will be used if available.'}</p><button>Save ${level} instructions</button></form>`;
 }).join('');
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>SELC weekly planning</title><style>body{font:16px/1.5 system-ui;margin:32px auto;max-width:850px;padding:0 20px;color:#0B1040}h1,h2{color:#060DBA}form{padding:20px;background:#ECEDFC;margin:20px 0;border-left:4px solid #DA0309}textarea{display:block;width:100%;box-sizing:border-box;padding:12px;font:inherit}button{background:#060DBA;color:white;border:0;border-radius:4px;padding:12px 20px;cursor:pointer}</style><h1>Weekly speaking planning</h1><p>Week starting ${escapeHtml(String(period.week_start).slice(0,10))}</p><p>Write instructions for the LLM: lesson content, priorities and anything to avoid. Each level receives two topics on Monday and two on Thursday at 06:00 GMT+0. These instructions remain editable until the next weekly link is issued.</p>${forms}</html>`;
}
// Mount before your server's 404 handler. db must be a server-only pg pool/client.
// HTTPS reverse proxy required. No GET request changes data or approves a plan.
export function planningHandler({db,baseUrl}){
 const origin=new URL(baseUrl).origin;
 return async(req,res)=>{
  const url=new URL(req.url,origin); const match=url.pathname.match(/^\/planning\/([A-Za-z0-9_-]{43})$/);
  if(!match)return false;
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Robots-Tag','noindex, nofollow');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('Content-Type','text/html; charset=utf-8');
  const token=match[1];
  const {rows}=await db.query(`select p.*,p.week_start::text as week_start from public.selc_planning_periods p join public.selc_teachers t on t.id=p.owner_teacher_id where p.token_hash=$1 and p.closed_at is null and t.active`,[hashToken(token)]);
  if(!rows.length){res.statusCode=410;res.end('This planning link is closed or unavailable. Use the latest planning email.');return true;}
  const period=rows[0];
  if(req.method==='POST'){
   if(req.headers.origin!==origin||!String(req.headers['content-type']??'').startsWith('application/x-www-form-urlencoded')){res.statusCode=403;res.end('Invalid form request.');return true;}
   const chunks=[];let size=0;for await(const chunk of req){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>65536){res.statusCode=413;res.end('Form too large.');return true;}chunks.push(bytes);}
   const form=new URLSearchParams(Buffer.concat(chunks).toString('utf8'));const supplied=form.get('csrf')??'';const expected=csrf(token);
   if(Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected))){res.statusCode=403;res.end('Invalid form request.');return true;}
   const level=form.get('level');const revision=Number(form.get('revision'));const instructions=form.get('instructions')??'';
   if(!LEVELS.includes(level)||!Number.isInteger(revision)||revision<0||!instructions.trim()||instructions.length>12000){res.statusCode=400;res.end('Check the level, instructions and revision.');return true;}
   try{await db.query('select * from public.selc_save_weekly_plan($1,$2,$3,$4,$5)',[hashToken(token),period.owner_teacher_id,level,instructions,revision]);}
   catch(error){if(/Plan changed|link is closed|invalid/i.test(error.message)){res.statusCode=409;res.end('This page changed or its link closed. Reload the latest planning link before saving.');return true;}throw error;}
   res.statusCode=303;res.setHeader('Location',url.pathname);res.end();return true;
  }
  if(req.method!=='GET'){res.statusCode=405;res.setHeader('Allow','GET, POST');res.end('Method not allowed.');return true;}
  const result=await db.query('select * from public.selc_weekly_plans where period_id=$1',[period.id]);res.end(page(period,result.rows,token));return true;
 };
}

// Atomic invitation creation: retrying this job reuses the SAME stored link.
// Only invoke after installing an approved SELC_PLANNING_INVITATION email template.
export async function queuePlanningInvitation(pool,{weekStart,teacherId,baseUrl,subject}){
 if(!subject?.trim())throw Error('Approved email subject required');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query('select pg_advisory_xact_lock(70261301)');
  const key='selc-planning-invitation:'+weekStart;
  const existing=(await db.query('select payload_json from public.selc_email_outbox where idempotency_key=$1',[key])).rows[0];
  if(existing){await db.query('COMMIT');return {reused:true,...existing.payload_json};}
  const teacher=(await db.query('select * from public.selc_teachers where id=$1 and active',[teacherId])).rows[0];
  if(!teacher)throw Error('Active teacher required');
  const link=await issuePlanningLink(db,{weekStart,teacherId,baseUrl});
  const payload={period_id:link.periodId,planning_url:link.url,week_start:weekStart,teacher_name:teacher.full_name};
  await db.query(`insert into public.selc_email_outbox(idempotency_key,email_kind,recipient_email,recipient_name,subject,payload_json) values($1,'SELC_PLANNING_INVITATION',$2,$3,$4,$5)`,[key,teacher.email,teacher.full_name,subject,JSON.stringify(payload)]);
  await db.query('COMMIT');return {reused:false,...payload};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
