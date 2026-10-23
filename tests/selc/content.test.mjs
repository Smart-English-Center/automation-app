import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {CONTENT_NAMES,contentStatus,fillPlain} from '../../src/selc/core.mjs';
import {renderMail} from '../../src/selc/mail.mjs';
import fs from 'node:fs/promises';
process.env.SELC_CONTENT_DIR=fileURLToPath(new URL('../../content',import.meta.url));
const values={student_name:'A <script>alert(1)</script>',student_email:'student@example.invalid',student_phone:'Unavailable',country:'Test',teacher_name:'Olivier Tehua',level:'B2',start_date:'2026-11-02',reason:'Please revise <b>this</b>.',assignment_title:'Test assignment',writing_prompt:'Write about a day.',writing_answer:'I work.\nThis is the original.',speaking_prompt:'Describe it.',speaking_answer_source:'https://www.speakpipe.com/voice-recorder/msg/testcode',feedback_language:'fr',review_url:'https://example.invalid/review/token',feedback_url:'https://example.invalid/documents/token',document_url:'https://example.invalid/documents/token',whatsapp_url:'',prestart_introduction:'Please contact the student today.',planning_url:'https://example.invalid/planning/token',week_start:'2026-11-02',missing_levels:'B2',delivery_date:'2026-11-02',practice_date:'2026-11-02',practice_url:'https://example.invalid/practice/token',topics_html:'<section><h2>Topic 1</h2><p>Safe application-generated topic.</p></section>'};
test('production content bundle is complete',async()=>{const files=await contentStatus();assert.equal(files.length,CONTENT_NAMES.length);assert.deepEqual(files.filter(f=>!f.present),[]);});
test('every production email renders without missing values and escapes student material',async()=>{
 for(const kind of ['registration-approved','registration-approved-late','registration-rejected','registration-review','assignment-received','assignment-review','assignment-rejected','feedback-ready','prestart-reminder','planning-invitation','planning-reminder','topics-delivery','teacher-report']){
  const result=await renderMail(kind,values);assert.ok(result.subject.trim(),kind);assert.doesNotMatch(result.html,/\{\{|<script>/,kind);assert.doesNotMatch(result.subject,/\{\{/);if(kind==='topics-delivery')assert.match(result.html,/<section><h2>Topic 1/);
 }
 const reminder=await renderMail('prestart-reminder',values);assert.doesNotMatch(reminder.html,/href=""/);
 const withPhone=await renderMail('prestart-reminder',{...values,whatsapp_url:'https://wa.me/2250102030405?text=Hello'});assert.match(withPhone.html,/href="https:\/\/wa.me/);
});
test('prestart messages do not promise two days for late approvals; plain WhatsApp fills',async()=>{
 const late=await renderMail('registration-approved-late',values);assert.doesNotMatch(late.html,/contact you two days/);
 const message=fillPlain(await fs.readFile(new URL('../../content/prestart-whatsapp.txt',import.meta.url),'utf8'),values);assert.doesNotMatch(message,/\{\{/);assert.match(message,/2026-11-02/);
});
