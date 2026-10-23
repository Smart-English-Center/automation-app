import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {receiveForm,importEvent} from '../../src/selc/imports.mjs';
import {approveRegistration} from '../../src/selc/registration.mjs';
import {queueReviewNotification} from '../../src/selc/decisions.mjs';
import {makeApp} from '../../src/selc/server.mjs';
import {csrf,isoDay,shiftDay} from '../../src/selc/core.mjs';
import {getGenerationInput,queuePlanningInvitation} from '../../src/selc/planning.mjs';
import {reserveAudioDriveId} from '../../src/selc/audioDriveReservation.mjs';
import {validateAssessment} from '../../src/selc/corrections.mjs';
import {chat} from '../../src/selc/providers.mjs';
let db,pool,server,origin,teacher,registration;
const regId='1QPK5G3PCJcrH72ClBCmYBuj-qzWv_xs33XPzeB9QqIk',assignmentId='14ttlbnV2CeI7r8G-8nLieOBcnp-Dzh6oCIRrKdtI11w';
function envelope(kind,answers,{uuid=crypto.randomUUID(),tab=kind==='REGISTRATION'?123:456}={}){const book=kind==='REGISTRATION'?regId:assignmentId,key=['SELC',kind,book,tab,uuid].join('|');return {schema_version:'selc.forms.v1',source_kind:kind,source_response_key:key,source_identity_key:key,response_id:uuid,spreadsheet:{id:book,name:'Test',timezone:'Etc/UTC'},sheet:{id:tab,name:kind==='REGISTRATION'?'Students':'Students Assignments',row_number:2},submitted_at:new Date().toISOString(),answers,raw_named_values:{}};}
const registrationAnswers={student_name:'Test Learner',student_email:'learner@example.invalid',student_phone:'+2250102030405',country:'Test',requested_teacher_email:'smartenglishlearningcenter@gmail.com'};
const assignmentAnswers={student_name:'Test Learner',student_email:'learner@example.invalid',assignment_title:'Practice one',writing_prompt:'Write.',writing_answer:'  My sister work.\nOriginal second line.  ',speaking_prompt:'Speak.',speaking_answer_source:'https://www.speakpipe.com/voice-recorder/msg/testcode',feedback_language:'fr'};
before(async()=>{
 process.env.REGISTRATION_PUBLIC_BASE_URL='https://selc.example.invalid';process.env.DOCUMENT_LINK_SECRET='test-document-key';process.env.WORKER_ADMIN_SECRET='test-admin';process.env.REGISTRATION_WEBHOOK_SECRET='test-registration';process.env.FORM_WEBHOOK_SECRET='test-assignment';process.env.BREVO_API_KEY='test-brevo-key';process.env.SELC_CONTENT_DIR='/nonexistent-approved-content-test';
 db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
 for(const file of ['001_foundation.sql','002_planning.sql','003_audio_reservations.sql','004_runtime.sql'])await db.exec(await fs.readFile(new URL('../../database/selc/'+file,import.meta.url),'utf8'));
 pool={query:(sql,args)=>db.query(sql,args),async connect(){return {query:(sql,args)=>db.query(sql,args),release(){}}}};
 teacher=(await db.query('select * from selc_teachers where is_main_teacher')).rows[0];
 const app=makeApp(pool);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));origin='http://127.0.0.1:'+server.address().port;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
test('all migrations install and source mappings are corrected, quiz sources remain disabled',async()=>{assert.deepEqual((await db.query('select version from selc_schema_version order by version')).rows.map(r=>r.version),[1,2,4]);assert.equal((await db.query("select source_kind from selc_google_sources where spreadsheet_id=$1",[regId])).rows[0].source_kind,'REGISTRATION');});
test('webhook secrets fail closed and requests are durably acknowledged',async()=>{
 const p=envelope('REGISTRATION',registrationAnswers);
 let r=await fetch(origin+'/api/registration/forms/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});assert.equal(r.status,401);
 r=await fetch(origin+'/api/registration/forms/submit',{method:'POST',headers:{'Content-Type':'application/json','x-registration-webhook-secret':'test-registration'},body:JSON.stringify(p)});assert.equal(r.status,202);const ack=await r.json();assert.equal(ack.receipt.source_response_key,p.source_response_key);assert.equal((await db.query('select status from selc_import_events where id=$1',[ack.receipt.import_event_id])).rows[0].status,'PENDING');
 const again=await receiveForm(pool,p,'REGISTRATION');assert.equal(again.status,'DUPLICATE');assert.equal(again.id,ack.receipt.import_event_id);
 const changed=structuredClone(p);changed.answers.student_name='Other learner';await assert.rejects(receiveForm(pool,changed,'REGISTRATION'),/CONTENT_CONFLICT/);
 await importEvent(pool,{eventId:ack.receipt.import_event_id});registration=(await db.query('select * from selc_registration_requests where import_event_id=$1',[ack.receipt.import_event_id])).rows[0];assert.equal(registration.status,'PENDING');assert.equal(registration.assigned_level_code,null);
});
test('tab rename retains identity but another numeric tab ID is rejected',async()=>{
 const p=envelope('REGISTRATION',{...registrationAnswers,student_email:'second@example.invalid'});p.sheet.name='Renamed tab';await receiveForm(pool,p,'REGISTRATION');const other=envelope('REGISTRATION',registrationAnswers,{tab:999});await assert.rejects(receiveForm(pool,other,'REGISTRATION'),/TAB_MISMATCH/);
});
test('review GET does not approve; POST requires CSRF; future dates stay scheduled',async()=>{
 await queueReviewNotification(pool,{kind:'REGISTRATION',id:registration.id});
 const job=(await db.query("select payload_json from selc_jobs where job_type='NOTICE' and payload_json->>'registrationId'=$1",[registration.id])).rows[0];const token=job.payload_json.review_url.split('/').at(-1);
 let r=await fetch(origin+'/review/'+token);assert.equal(r.status,200);assert.match(await r.text(),/Start date/);assert.equal((await db.query('select status from selc_registration_requests where id=$1',[registration.id])).rows[0].status,'PENDING');
 const values={csrf:'wrong',decision:'APPROVED',teacher_id:teacher.id,level:'A1',starts_on:shiftDay(isoDay(),3)};
 r=await fetch(origin+'/review/'+token,{method:'POST',headers:{Origin:'https://selc.example.invalid','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values),redirect:'manual'});assert.equal(r.status,403);
 values.csrf=csrf(token);r=await fetch(origin+'/review/'+token,{method:'POST',headers:{Origin:'https://selc.example.invalid','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(values),redirect:'manual'});assert.equal(r.status,303);
 const enrollment=(await db.query('select * from selc_enrollments')).rows[0];assert.equal(enrollment.status,'SCHEDULED');assert.equal((await db.query('select * from selc_active_enrollments')).rows.length,0);
 const before=(await db.query('select count(*)::integer as n from selc_enrollments')).rows[0].n;
 await approveRegistration(pool,{requestId:registration.id,actorTeacherId:teacher.id,assignedTeacherId:teacher.id,level:'A1',startDate:shiftDay(isoDay(),3)});assert.equal((await db.query('select count(*)::integer as n from selc_enrollments')).rows[0].n,before);
 r=await fetch(origin+'/review/'+token);assert.match(await r.text(),/already been APPROVED/);
});
test('prestart submissions remain durable and import after activation; exact answer is immutable',async()=>{
 const p=envelope('ASSIGNMENT',assignmentAnswers),ack=await receiveForm(pool,p,'ASSIGNMENT');
 await assert.rejects(importEvent(pool,{eventId:ack.id}),/WAITING_FOR_ACTIVE_ENROLLMENT/);assert.equal((await db.query('select status from selc_import_events where id=$1',[ack.id])).rows[0].status,'PENDING');
 await db.query('update selc_enrollments set starts_on=$1',[isoDay()]);await importEvent(pool,{eventId:ack.id});
 const s=(await db.query('select * from selc_submissions')).rows[0];assert.equal(s.writing_answer,assignmentAnswers.writing_answer);assert.equal(s.status,'AWAITING_APPROVAL');await assert.rejects(db.query("update selc_submissions set writing_answer='modified' where id=$1",[s.id]),/immutable/);
});
test('one assignment decision is final and rejecting it needs a reason',async()=>{
 const s=(await db.query('select * from selc_submissions')).rows[0];await assert.rejects(db.query("update selc_submissions set status='REJECTED',review_decision='REJECTED',decided_by_teacher_id=$2,decided_at=now() where id=$1",[s.id,teacher.id]));
 await db.query("update selc_submissions set status='APPROVED',review_decision='APPROVED',decided_by_teacher_id=$2,decided_at=now() where id=$1",[s.id,teacher.id]);await assert.rejects(db.query("update selc_submissions set review_decision='REJECTED',status='REJECTED',decision_reason='different' where id=$1",[s.id]),/final/);
});
test('audio reservation reuses the same Drive ID and public roles cannot read it',async()=>{
 const sourceHash='a'.repeat(64);let calls=0;
 const one=await reserveAudioDriveId(pool,{namespace:'SELC',sourceHash,generateId:async()=>{calls++;return 'reserved-audio-id';}});const two=await reserveAudioDriveId(pool,{namespace:'SELC',sourceHash,generateId:async()=>{throw Error('unexpected new ID');}});assert.equal(one,two);assert.equal(calls,1);
 await db.exec('set role anon');await assert.rejects(db.query('select * from audio_drive_reservations'));await db.exec('reset role');
});
test('planning invitation retry reuses its link, saved instructions are resolved, stale saves fail',async()=>{
 const monday=(()=>{let d=isoDay();while(new Date(d+'T00:00:00Z').getUTCDay()!==1)d=shiftDay(d,1);return d;})();
 const one=await queuePlanningInvitation(pool,{weekStart:monday,teacherId:teacher.id,baseUrl:'https://selc.example.invalid',subject:'Test subject'}),two=await queuePlanningInvitation(pool,{weekStart:monday,teacherId:teacher.id,baseUrl:'https://selc.example.invalid',subject:'Test subject'});assert.equal(one.planning_url,two.planning_url);
 const token=one.planning_url.split('/').at(-1),tokenHash=crypto.createHash('sha256').update(token).digest('hex');
 await db.query('select * from selc_save_weekly_plan($1,$2,$3,$4,$5)',[tokenHash,teacher.id,'A1','Practise introductions.',0]);await assert.rejects(db.query('select * from selc_save_weekly_plan($1,$2,$3,$4,$5)',[tokenHash,teacher.id,'A1','Stale form.',0]));
 const plan=await getGenerationInput(pool,{level:'A1',deliveryDate:monday});assert.equal(plan.instructions,'Practise introductions.');const later=await getGenerationInput(pool,{level:'A1',deliveryDate:shiftDay(monday,7)});assert.equal(later.source,'SAVED');
});
test('audio request carries WAV bytes through OpenRouter, no URL substituted',async()=>{
 process.env.OPENROUTER_API_KEY='test-key';let request;
 await chat({task:'audio',prompt:'Test',input:{speaking_prompt:'Speak'},audio:Buffer.from('RIFF-test'),fetchJson:async(url,options)=>{request={url,body:JSON.parse(options.body)};return {choices:[{message:{content:'{"speaking":{}}'}}]};}});
 assert.equal(request.body.model,'openai/gpt-audio-mini');assert.equal(request.body.messages[1].content[1].input_audio.data,Buffer.from('RIFF-test').toString('base64'));assert.equal(request.body.messages[1].content[1].type,'input_audio');
});
test('writing corrections cannot invent original phrases',async()=>{
 const data=JSON.parse(await fs.readFile(new URL('../../templates/selc/SELC_test_data.json',import.meta.url),'utf8'));
 validateAssessment('writing',data.writing,{writing_answer:data.assignment.writing_answer});const changed=structuredClone(data.writing);changed.corrections[0].original='Invented student answer';assert.throws(()=>validateAssessment('writing',changed,{writing_answer:data.assignment.writing_answer}),/NOT_IN_SOURCE/);
});
test('backend liveness works without testing remote accounts; admin status is protected',async()=>{assert.equal((await fetch(origin+'/health')).status,200);assert.equal((await fetch(origin+'/worker/status')).status,401);});
test('approved submission flows through audio, reviewed corrections and one final feedback record',async()=>{
 const {correctSubmission}=await import('../../src/selc/corrections.mjs');
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const dir=await mkdtemp(path.join(os.tmpdir(),'selc-content-test-')),previous=process.env.SELC_CONTENT_DIR;process.env.SELC_CONTENT_DIR=dir;
 for(const name of ['writing','writing-review','speaking','speaking-review'])await writeFile(path.join(dir,name+'.txt'),'Test-only prompt; not production approved content.');
 const sample=JSON.parse(await fs.readFile(new URL('../../templates/selc/SELC_test_data.json',import.meta.url),'utf8'));
 const writing={...sample.writing,corrections:[],focus:[],final_comment:'Test-only writing feedback.'};const speaking={...sample.speaking,pronunciation_corrections:[],focus:[],final_comment:'Test-only speaking feedback.'};
 let downloads=0,transcriptions=0,chats=0;
 const services={downloadAudio:async()=>{downloads++;return {drive_file_id:'stored-audio-file',mime_type:'audio/mpeg',file_size_bytes:100};},convertAudio:async()=>({wav_buffer:Buffer.from('RIFF-test')}),transcribe:async()=>{transcriptions++;return {text:'Verbatim test transcript.',model:'test-model'};},chat:async({input,audio})=>{chats++;const review=!!input.draft;const kind=review?(input.draft.writing?'writing':'speaking'):(input.writing_answer?'writing':'speaking');if(kind==='speaking'&&!review)assert.ok(Buffer.isBuffer(audio));return {model:'test-model',provider:'openrouter',output:review?{status:'ACCEPTED',[kind]:kind==='writing'?writing:speaking,review_notes:[]}:{[kind]:kind==='writing'?writing:speaking}};}};
 try{const s=(await db.query('select * from selc_submissions')).rows[0];await correctSubmission(pool,{submissionId:s.id},services);await correctSubmission(pool,{submissionId:s.id},services);assert.equal(downloads,1);assert.equal(transcriptions,1);assert.equal(chats,4);const final=(await db.query('select * from selc_final_feedback')).rows;assert.equal(final.length,1);assert.equal(final[0].feedback_json.labels.report_title,'Assignment feedback');assert.equal(final[0].feedback_json.assignment.speaking_audio_url,assignmentAnswers.speaking_answer_source);assert.equal(final[0].feedback_json.closing_motivation,'');assert.equal(JSON.stringify(final[0].feedback_json).includes('Verbatim test transcript.'),false);}finally{process.env.SELC_CONTENT_DIR=previous;await rm(dir,{recursive:true,force:true});}
});
test('feedback PDF creation is resumed, one student notice is queued and no teacher feedback-ready email exists',async()=>{
 const {generateDocument}=await import('../../src/selc/documents.mjs');process.env.PDFMONKEY_STUDENT_FEEDBACK_TEMPLATE_ID='test-template';process.env.GOOGLE_PDF_OUTPUT_FOLDER_ID='test-folder';
 const p=(await db.query("select payload_json from selc_jobs where job_type='DOCUMENT' and payload_json->>'kind'='STUDENT_FEEDBACK'")).rows[0].payload_json;let creates=0,stores=0;
 const services={create:async()=>{creates++;return {document_id:'test-pdfmonkey-id'};},wait:async()=>({download_url:'https://example.invalid/render.pdf'}),store:async()=>{stores++;return 'private-drive-pdf';}};
 await generateDocument(pool,p,services);await generateDocument(pool,p,services);assert.equal(creates,1);assert.equal(stores,1);assert.equal((await db.query("select count(*)::integer n from selc_jobs where job_type='NOTICE' and payload_json->>'kind'='feedback-ready'")).rows[0].n,1);assert.equal((await db.query("select count(*)::integer n from selc_jobs where job_type='NOTICE' and payload_json->>'kind'='teacher-feedback-ready'")).rows[0].n,0);
});
test('unknown email send is held instead of blindly resent',async()=>{
 const {deliverOne}=await import('../../src/selc/mail.mjs');await db.query("update selc_email_outbox set status='CANCELLED'");
 await db.query(`insert into selc_email_outbox(idempotency_key,email_kind,recipient_email,subject,payload_json) values('test-unknown','test','learner@example.invalid','Test',$1)`,[JSON.stringify({html:'<p>Test-only body.</p>'})]);
 let calls=0;await deliverOne(pool,{fetchImpl:async()=>{calls++;throw Error('lost reply after provider accepted');}});assert.equal((await db.query("select status from selc_email_outbox where idempotency_key='test-unknown'")).rows[0].status,'UNKNOWN');await deliverOne(pool,{fetchImpl:async()=>{calls++;throw Error('must not call');}});assert.equal(calls,1);
});
test('teacher digest uses existing message contract and does not expose suggested messages in its PDF payload',async()=>{
 const {teacherDigest}=await import('../../src/selc/digests.mjs');
 let requests=0;await teacherDigest(pool,{teacherId:teacher.id,cycleDate:isoDay()},{chatImpl:async({input,prompt})=>{requests++;assert.match(prompt,/Olivier Tehua/);assert.doesNotMatch(prompt,/Mr John/);return {output:{batch_id:input.batch_id,messages:input.students.map(s=>({request_id:s.request_id,message:`${s.language==='fr'?'Bonjour':'Hello'} ${s.student_name_for_message},\n${s.must_deliver.map(m=>m.assignment_name+' '+m.correction_url).join('\n')}\nContinuez vos efforts. 🙂\nOlivier Tehua`}))}};}});
 assert.equal(requests,1);const report=(await db.query("select * from selc_teacher_reports where report_kind='PROGRESS_DIGEST'")).rows[0];assert.equal(report.report_json.all_students.length,1);assert.equal(report.report_json.preview_mode,false);assert.equal(report.report_json.quizzes_enabled,false);assert.equal(report.report_json.all_students[0].suggested_whatsapp_message,undefined);assert.match(report.report_json.all_students[0].whatsapp_url,/wa\.me/);
});
test('two topics are shared per level, A1 defaults French, teacher reports split 27 recipients into 25 and 2',async()=>{
 const {generateTopics,topicReport}=await import('../../src/selc/topics.mjs');const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const dir=await mkdtemp(path.join(os.tmpdir(),'selc-topics-test-')),previous=process.env.SELC_CONTENT_DIR;process.env.SELC_CONTENT_DIR=dir;await writeFile(path.join(dir,'topics.txt'),'Test-only generation prompt, not approved production text.');
 let monday=isoDay();while(new Date(monday+'T00:00:00Z').getUTCDay()!==1)monday=shiftDay(monday,1);
 for(let i=0;i<26;i++){const s=(await db.query(`insert into selc_students(full_name,email,phone,active) values($1,$2,'2250102030405',true) returning id`,['Learner '+i,'learner'+i+'@example.invalid'])).rows[0];await db.query(`insert into selc_enrollments(student_id,teacher_id,level_code,status,starts_on) values($1,$2,'A1','ACTIVE',$3)`,[s.id,teacher.id,isoDay()]);}
 let calls=0;
 const options={chatImpl:async({input})=>{calls++;assert.equal(input.default_instruction_language,'fr');assert.equal(input.teacher_explicit_language_instruction_takes_precedence,true);return {model:'test-model',provider:'openrouter',output:{topics:[{title:'Topic one',instructions:'Répondez en anglais.',questions:['What is your name?'],role_play:null},{title:'Topic two',instructions:'Parlez de votre journée.',questions:['What do you do in the morning?'],role_play:null}]}};}};
 try{
  await generateTopics(pool,{deliveryDate:monday,level:'A1'},options);await generateTopics(pool,{deliveryDate:monday,level:'A1'},options);assert.equal(calls,1);
  const topic=(await db.query('select * from selc_speaking_topics')).rows[0],recipients=(await db.query('select * from selc_speaking_recipients')).rows;assert.equal(topic.content_json.topics.length,2);assert.equal(topic.content_json.topics[0].instruction_language,'fr');assert.equal(recipients.length,27);
  const p={cycleId:topic.cycle_id,topicId:topic.id,teacherId:teacher.id,level:'A1',deliveryDate:monday};await assert.rejects(topicReport(pool,p),/WAITING_FOR_TOPIC_EMAIL/);
  for(const r of recipients)await db.query(`insert into selc_email_outbox(idempotency_key,email_kind,recipient_email,subject,speaking_recipient_id,status,payload_json) values($1,'topics-delivery',$2,'Test',$3,'ACCEPTED','{}')`,['test-topic:'+r.id,r.student_email_snapshot,r.id]);
  await topicReport(pool,p);const reports=(await db.query("select report_json from selc_teacher_reports where report_kind='SPEAKING_RECIPIENTS' order by report_key")).rows;assert.deepEqual(reports.map(r=>r.report_json.recipients.length),[25,2]);assert.equal(new Set(reports.flatMap(r=>r.report_json.recipients.map(s=>s.student_id))).size,27);
 }finally{process.env.SELC_CONTENT_DIR=previous;await rm(dir,{recursive:true,force:true});}
});
test('email delivery continues while a long correction-style job is still running',async()=>{
 const {startWorker,handlers}=await import('../../src/selc/worker.mjs');
 const oldLoop=process.env.ENABLE_INTERNAL_WORKER_LOOP,oldEmail=process.env.SELC_EMAIL_DELIVERY_ENABLED,oldFetch=globalThis.fetch;
 process.env.ENABLE_INTERNAL_WORKER_LOOP='true';process.env.SELC_EMAIL_DELIVERY_ENABLED='true';
 let release,finish,signalSend,jobActive=false,claimed=false,emailClaimed=false;
 const waiting=new Promise(resolve=>{release=resolve}),finished=new Promise(resolve=>{finish=resolve}),sent=new Promise(resolve=>{signalSend=resolve});
 handlers.TEST_LONG=async()=>{jobActive=true;await waiting;jobActive=false;};
 const fake={async query(sql){
  if(sql.includes('selc_claim_job')&&!claimed){claimed=true;return {rows:[{id:crypto.randomUUID(),lease_token:crypto.randomUUID(),job_type:'TEST_LONG',payload_json:{},attempt_count:1,max_attempts:5}]};}
  if(sql.includes("select * from public.selc_email_outbox where status in")&&!emailClaimed){emailClaimed=true;return {rows:[{id:crypto.randomUUID(),email_kind:'test',recipient_email:'learner@example.invalid',recipient_name:'Test',subject:'Test',payload_json:{html:'<p>Test-only email.</p>'}}]};}
  if(sql.includes("set status='SUCCEEDED'"))finish();return {rows:[]};
 },async connect(){return {query:this.query.bind(this),release(){}}}};
 globalThis.fetch=async()=>{assert.equal(jobActive,true);signalSend();return {ok:true,json:async()=>({messageId:'test-accepted-message'})};};
 const stop=startWorker(fake);
 try{await Promise.race([sent,new Promise((_,reject)=>setTimeout(()=>reject(Error('Email blocked behind long job')),1000))]);assert.equal(jobActive,true);release();await finished;}finally{stop();release();globalThis.fetch=oldFetch;delete handlers.TEST_LONG;if(oldLoop===undefined)delete process.env.ENABLE_INTERNAL_WORKER_LOOP;else process.env.ENABLE_INTERNAL_WORKER_LOOP=oldLoop;if(oldEmail===undefined)delete process.env.SELC_EMAIL_DELIVERY_ENABLED;else process.env.SELC_EMAIL_DELIVERY_ENABLED=oldEmail;}
});
test('scheduler SQL runs with the real schema and pre-start catch-up is idempotent',async()=>{
 const {scheduleDue}=await import('../../src/selc/schedule.mjs');await scheduleDue(pool);await scheduleDue(pool);
 const jobs=(await db.query("select * from selc_jobs where idempotency_key like 'prestart:%'")).rows;assert.equal(jobs.length,1);assert.equal(jobs[0].payload_json.kind,'prestart-reminder');
});
test('French is the topic instruction default for A2 through C1 as well as A1',async()=>{
 const {generateTopics}=await import('../../src/selc/topics.mjs');
 const previous=process.env.SELC_CONTENT_DIR;process.env.SELC_CONTENT_DIR=new URL('../../content',import.meta.url).pathname;
 const period=(await db.query('select p.*,p.week_start::text as week from selc_planning_periods p where closed_at is null')).rows[0];
 const invitation=(await db.query("select payload_json from selc_email_outbox where email_kind='SELC_PLANNING_INVITATION' and payload_json->>'period_id'=$1",[period.id])).rows[0].payload_json;
 const tokenHash=crypto.createHash('sha256').update(invitation.planning_url.split('/').at(-1)).digest('hex');
 try{for(const level of ['A2','B1','B2','C1']){
  await db.query('select * from selc_save_weekly_plan($1,$2,$3,$4,0)',[tokenHash,teacher.id,level,'Practise daily routines.']);
  await generateTopics(pool,{deliveryDate:period.week,level},{chatImpl:async({input,prompt})=>{
   assert.equal(input.default_instruction_language,'fr');assert.match(prompt,/EVERY level/);
   return {model:'test-model',output:{topics:[{title:'Daily routines',instructions:'Répondez en anglais.',questions:['Que faites-vous le matin ?']},{title:'A different day',instructions:'Répondez en anglais.',questions:['Comment votre routine change-t-elle ?']}]}};
  }});
  const topic=(await db.query('select content_json from selc_speaking_topics where level_code=$1',[level])).rows[0];assert.equal(topic.content_json.topics[0].instruction_language,'fr');
 }}finally{process.env.SELC_CONTENT_DIR=previous;}
});
