import crypto from 'node:crypto';
import {baseUrl,e,equal,need,page,queue,step,tx} from './core.mjs';
import {createPdfMonkeyDocument,waitForPdfMonkeyDocument} from '../pdfmonkeyClient.js';
import {getGoogleDriveAccessToken} from '../google/driveClient.js';
import {generateDriveId,requestJson} from './providers.mjs';
import {validateDigest,validateTopics} from './validatePdfPayload.mjs';
const signature=(kind,id)=>crypto.createHmac('sha256',need('DOCUMENT_LINK_SECRET')).update(kind+':'+id).digest('base64url');
export const documentUrl=id=>baseUrl()+'/documents/'+id+'/'+signature('document',id);
export const practiceUrl=id=>baseUrl()+'/practice/'+id+'/'+signature('practice',id);
export async function ensurePrivatePdf(pool,doc,downloadUrl,folderId){
 const id=(await step(pool,'pdf-drive-id:'+doc.id,async()=>({id:await generateDriveId()}))).id;
 const token=await getGoogleDriveAccessToken(),headers={Authorization:'Bearer '+token};
 const lookup=await fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(id)+'?fields=id,mimeType,parents,properties,trashed',{headers,signal:AbortSignal.timeout(30000)});
 if(lookup.ok){const f=await lookup.json();if(f.trashed||f.mimeType!=='application/pdf'||f.properties?.selc_document_id!==doc.id||!f.parents?.includes(folderId))throw Error('PDF_IDENTITY_MISMATCH');return id;}
 if(lookup.status!==404)throw Error('DRIVE_LOOKUP_HTTP:'+lookup.status);
 const remote=await fetch(downloadUrl,{signal:AbortSignal.timeout(60000)});if(!remote.ok)throw Error('PDF_DOWNLOAD_FAILED');const bytes=Buffer.from(await remote.arrayBuffer());if(bytes.subarray(0,5).toString()!=='%PDF-'||bytes.length<2048)throw Error('INVALID_PDF_CONTENT');
 const start=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({id,name:'SELC_'+doc.id+'.pdf',mimeType:'application/pdf',parents:[folderId],properties:{selc_document_id:doc.id}}),signal:AbortSignal.timeout(30000)});
 if(start.status===409)throw Error('PDF_UPLOAD_PENDING_RETRY');if(!start.ok)throw Error('PDF_UPLOAD_START_FAILED');const location=start.headers.get('location');if(!location?.startsWith('https://www.googleapis.com/'))throw Error('PDF_UPLOAD_LOCATION_INVALID');
 const result=await requestJson(location,{method:'PUT',headers:{...headers,'Content-Type':'application/pdf'},body:bytes},60000);if(result.id!==id)throw Error('PDF_UPLOAD_ID_MISMATCH');return id;
}
export async function generateDocument(pool,{kind,key,payload,feedbackId=null,reportId=null},services={create:createPdfMonkeyDocument,wait:waitForPdfMonkeyDocument,store:ensurePrivatePdf}){
 const templates={STUDENT_FEEDBACK:'PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID',TEACHER_DIGEST:'PDFMONKEY_TEACHER_DIGEST_TEMPLATE_ID',TEACHER_SPEAKING_TOPICS:'PDFMONKEY_SPEAKING_TEACHER_TEMPLATE_ID'};
 const folders={STUDENT_FEEDBACK:'GOOGLE_PDF_OUTPUT_FOLDER_ID',TEACHER_DIGEST:'GOOGLE_TEACHER_DIGEST_PDF_FOLDER_ID',TEACHER_SPEAKING_TOPICS:'SPEAKING_TEACHER_DRIVE_FOLDER_ID'};
 if(!templates[kind])throw Error('UNKNOWN_DOCUMENT_KIND');
 if(kind==='TEACHER_DIGEST')validateDigest(payload);if(kind==='TEACHER_SPEAKING_TOPICS')validateTopics(payload);
 const templateId=need(templates[kind]),folderId=need(folders[kind]);
 const doc=(await pool.query(`insert into public.selc_documents(document_key,document_kind,feedback_id,teacher_report_id,template_id,payload_json,drive_folder_id) values($1,$2,$3,$4,$5,$6,$7) on conflict(document_key) do update set document_key=excluded.document_key returning *`,[key,kind,feedbackId,reportId,templateId,JSON.stringify(payload),folderId])).rows[0];
 if(doc.status!=='READY'){
  if(!doc.pdfmonkey_document_id){const created=await services.create(doc.payload_json,{templateId,filename:'SELC_'+doc.id+'.pdf',meta:{source:'Smart English Learning Center'}});doc.pdfmonkey_document_id=created.document_id;await pool.query("update public.selc_documents set pdfmonkey_document_id=$2,status='RENDERING' where id=$1",[doc.id,created.document_id]);}
  const ready=await services.wait(doc.pdfmonkey_document_id,{timeoutMs:45000,intervalMs:2000});
  const card=ready.document_card||ready.document||ready;const downloadUrl=card.download_url||ready.download_url;
  if(!downloadUrl)throw Error('PDFMONKEY_NOT_READY');
  const id=await services.store(pool,doc,downloadUrl,folderId);
  await pool.query("update public.selc_documents set drive_file_id=$2,status='READY',error_message=null where id=$1",[doc.id,id]);
 }
 await tx(pool,async db=>{
  if(kind==='STUDENT_FEEDBACK'){
   const feedback=(await db.query('select submission_id from public.selc_final_feedback where id=$1',[feedbackId])).rows[0];
   await db.query("update public.selc_submissions set status='COMPLETED' where id=$1",[feedback.submission_id]);
   await queue(db,'feedback-notice:'+doc.id,'NOTICE',{kind:'feedback-ready',submissionId:feedback.submission_id,documentId:doc.id});
  }else await queue(db,'report-notice:'+doc.id,'NOTICE',{kind:'teacher-report',reportId,documentId:doc.id});
 });
 return doc.id;
}
export function topicHtml(pack){return pack.topics.map((topic,i)=>`<section><h2>Topic ${i+1}: ${e(topic.title)}</h2><p>${e(topic.description||'')}</p><h3>Instructions</h3><p style="white-space:pre-wrap">${e(topic.instructions)}</p><h3>Speaking questions</h3><ol>${topic.questions.map(q=>`<li>${e(q)}</li>`).join('')}</ol>${topic.role_play?`<h3>Role play</h3><p>${e(topic.role_play.scenario)}</p><p><strong>Role A - ${e(topic.role_play.role_a.name)}:</strong> ${e(topic.role_play.role_a.instructions)}</p><p><strong>Role B - ${e(topic.role_play.role_b.name)}:</strong> ${e(topic.role_play.role_b.instructions)}</p>`:''}</section>`).join('');}
export function registerDocumentRoutes(app,pool){
 app.get('/documents/:id/:signature',async(req,res)=>{
  if(!equal(req.params.signature,signature('document',req.params.id)))return res.sendStatus(403);
  const doc=(await pool.query("select * from public.selc_documents where id=$1 and status='READY'",[req.params.id])).rows[0];if(!doc)return res.sendStatus(404);
  const token=await getGoogleDriveAccessToken();const upstream=await fetch('https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(doc.drive_file_id)+'?alt=media',{headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(60000)});
  if(!upstream.ok)throw Error('DOCUMENT_DOWNLOAD_UNAVAILABLE');res.set({'Content-Type':'application/pdf','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','Content-Disposition':'inline; filename="SELC.pdf"'}).send(Buffer.from(await upstream.arrayBuffer()));
 });
 app.get('/practice/:id/:signature',async(req,res)=>{
  if(!equal(req.params.signature,signature('practice',req.params.id)))return res.sendStatus(403);
  const topic=(await pool.query("select t.*,c.scheduled_on::text as practice_date from public.selc_speaking_topics t join public.selc_speaking_cycles c on c.id=t.cycle_id where t.id=$1 and t.status='READY' and t.content_version='SELC_SPEAKING_PACK_V2'",[req.params.id])).rows[0];if(!topic)return res.sendStatus(404);
  res.set({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow'}).send(page('Speaking Practice',`<p>${e(topic.level_code)} - ${e(topic.practice_date)}</p>`+topicHtml(topic.content_json)));
 });
}
