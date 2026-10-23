import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
export const e=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
export const isoDay=(date=new Date())=>date.toISOString().slice(0,10);
export const shiftDay=(day,n)=>isoDay(new Date(Date.parse(day+'T00:00:00Z')+n*86400000));
export const dayOf=day=>new Date(day+'T00:00:00Z').getUTCDay();
export const need=name=>{const v=process.env[name]?.trim();if(!v)throw new Error('MISSING_CONFIG:'+name);return v;};
export const baseUrl=()=>{const u=new URL(need('REGISTRATION_PUBLIC_BASE_URL'));if(u.protocol!=='https:'||u.username||u.password)throw Error('HTTPS_BASE_REQUIRED');return u.origin;};
export const csrf=token=>hash('SELC-decision:'+token);
export function equal(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
export async function tx(pool,callback){const db=await pool.connect();try{await db.query('begin');const result=await callback(db);await db.query('commit');return result;}catch(error){await db.query('rollback');throw error;}finally{db.release();}}
export async function queue(db,key,kind,payload={}){await db.query(`insert into public.selc_jobs(idempotency_key,job_type,payload_json) values($1,$2,$3) on conflict(idempotency_key) do nothing`,[key,kind,JSON.stringify(payload)]);}
export async function enqueueMail(db,{key,kind,email,name,subject,payload,registrationId=null,submissionId=null,documentId=null,recipientId=null,reportId=null}){
 await db.query(`insert into public.selc_email_outbox(idempotency_key,email_kind,recipient_email,recipient_name,subject,payload_json,registration_request_id,submission_id,document_id,speaking_recipient_id,teacher_report_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(idempotency_key) do nothing`,[key,kind,email.toLowerCase().trim(),name,subject,JSON.stringify(payload),registrationId,submissionId,documentId,recipientId,reportId]);
}
export async function step(db,key,callback){const found=(await db.query('select result_json from public.selc_runtime_steps where step_key=$1',[key])).rows[0];if(found)return found.result_json;const result=await callback();await db.query(`insert into public.selc_runtime_steps(step_key,result_json) values($1,$2) on conflict(step_key) do nothing`,[key,JSON.stringify(result)]);return (await db.query('select result_json from public.selc_runtime_steps where step_key=$1',[key])).rows[0].result_json;}
export async function content(name){
 if(!/^[a-z0-9_-]+\.(txt|html)$/.test(name))throw Error('INVALID_CONTENT_NAME');
 try{const text=await fs.readFile(path.join(process.env.SELC_CONTENT_DIR||'content',name),'utf8');if(!text.trim())throw Error();return text;}catch{throw Error('APPROVED_CONTENT_MISSING:'+name);}
}
export const EMAIL_KINDS=['registration-approved','registration-approved-late','registration-rejected','registration-review','assignment-received','assignment-review','assignment-rejected','feedback-ready','prestart-reminder','planning-invitation','planning-reminder','topics-delivery','teacher-report'];
export const CONTENT_NAMES=['writing.txt','writing-review.txt','speaking.txt','speaking-review.txt','topics.txt','prestart-whatsapp.txt',...EMAIL_KINDS.flatMap(k=>[k+'.html',k+'-subject.txt'])];
export async function contentStatus(){return Promise.all(CONTENT_NAMES.map(async name=>{try{const text=await content(name);return {name,present:true,sha256:hash(text)};}catch{return {name,present:false};}}));}
export function fillPlain(template,values){return template.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g,(_,name)=>{if(!Object.hasOwn(values,name))throw Error('EMAIL_VALUE_MISSING:'+name);return String(values[name]??'');});}
export function fill(template,values){return template.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g,(_,name)=>{if(!Object.hasOwn(values,name))throw Error('EMAIL_VALUE_MISSING:'+name);return e(values[name]);});}
export function wa(phone,message){const digits=String(phone||'').replace(/\D/g,'');return /^[1-9]\d{6,14}$/.test(digits)?'https://wa.me/'+digits+'?text='+encodeURIComponent(message):'';}
export function page(title,body){return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(title)}</title><style>body{font:16px/1.5 system-ui;color:#0B1040;max-width:850px;margin:30px auto;padding:20px}h1,h2{color:#060DBA}fieldset,section{border:1px solid #dce1ef;padding:20px;margin:16px 0;background:#ECEDFC}label{display:block;margin:12px 0}input,select,textarea{display:block;padding:10px;max-width:100%;font:inherit;box-sizing:border-box}textarea{width:100%}button{background:#060DBA;color:#fff;padding:12px 20px;border:0;margin:12px 8px 0 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#060DBA}</style><h1>Smart English Learning Center</h1><h2>${e(title)}</h2>${body}</html>`;}
export function setPrivateHeaders(res){res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"});}

export const REQUIRED_ENV=['DATABASE_URL','REGISTRATION_PUBLIC_BASE_URL','WORKER_ADMIN_SECRET','REGISTRATION_WEBHOOK_SECRET','FORM_WEBHOOK_SECRET','DOCUMENT_LINK_SECRET','BREVO_WEBHOOK_SECRET','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REFRESH_TOKEN','GOOGLE_PDF_OUTPUT_FOLDER_ID','GOOGLE_TEACHER_DIGEST_PDF_FOLDER_ID','SPEAKING_TEACHER_DRIVE_FOLDER_ID','APPS_SCRIPT_AUDIO_DOWNLOADER_URL','APPS_SCRIPT_AUDIO_DOWNLOADER_SECRET','OPENROUTER_API_KEY','BREVO_API_KEY','PDFMONKEY_API_KEY','PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID','PDFMONKEY_TEACHER_DIGEST_TEMPLATE_ID','PDFMONKEY_SPEAKING_TEACHER_TEMPLATE_ID'];
export const environmentStatus=()=>REQUIRED_ENV.map(name=>({name,present:!!process.env[name]?.trim()}));
