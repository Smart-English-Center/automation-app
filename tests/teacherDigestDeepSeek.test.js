import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

import { buildDeepSeekDigestRequestBody } from "../src/deepseek/digestClient.js";
import {
  buildDigestBatch,
  buildDigestStudentRequest,
  digestLanguageForStudent,
  partitionDigestItems
} from "../src/teacherDigest/deepseekPayload.js";
import {
  LOCKED_TEACHER_DIGEST_PROMPT,
  LOCKED_TEACHER_DIGEST_PROMPT_SHA256,
  TEACHER_DIGEST_PROMPT_VERSION,
  teacherDigestPromptSha256
} from "../src/teacherDigest/deepseekPrompt.js";
import { validateDigestBatchResponse } from "../src/teacherDigest/deepseekValidator.js";

const fixtureUrl=new URL("./fixtures/teacher-digest-deepseek-input.json",import.meta.url);
const fixture=JSON.parse(await readFile(fixtureUrl,"utf8"));

function greetingFor(student){return `${student.language==="fr"?"Bonjour":"Hello"} ${student.student_name_for_message},`;}

function validMessage(student){
  const correction=(student.must_deliver||[]).map((item)=>`${item.assignment_name}: ${item.correction_url}`).join("; ");
  const lastAssignmentDate=student.evidence?.most_recent_assignment_date_for_message||"";
  const required=[correction,lastAssignmentDate].filter(Boolean).join(" ");
  return `${greetingFor(student)} I hope you are doing well. 🙂\n\n${required||"I have reviewed the available evidence with care."}\n\nMr John`;
}

function responseFor(batch,overrides={}){
  return JSON.stringify({
    batch_id:overrides.batch_id??batch.batch_id,
    messages:overrides.messages??batch.students.map((student)=>({request_id:student.request_id,message:validMessage(student)}))
  });
}

test("the locked production prompt is byte-stable and the approved input fixture is retained without sample outputs",async()=>{
  assert.equal(teacherDigestPromptSha256(),LOCKED_TEACHER_DIGEST_PROMPT_SHA256);
  assert.equal(LOCKED_TEACHER_DIGEST_PROMPT_SHA256,"4b06d0696959de4fa8a7f3028c5922a199e4272c9397ce46ad0279d1e6363aa9");
  assert.equal(TEACHER_DIGEST_PROMPT_VERSION,"JEA_STUDENT_DIGEST_DEEPSEEK_V5");
  assert.equal((LOCKED_TEACHER_DIGEST_PROMPT.match(/LAST SUNDAY OF THE MONTH/g)||[]).length,1);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/Every assessed result supplied in assessed_results is important and must appear/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/The number of days worked is the measure of participation and consistency/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/assignment_participation as the only authority/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/work on at least that many different days next week/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/regular writing practice helps the student apply grammar and vocabulary/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/regular speaking practice develops fluency, pronunciation and confidence/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/complete importance reminder belongs in the Sunday review/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/most_recent_assignment_date_for_message is supplied/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/Begin exactly with “Hello \[student_name_for_message\],”/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/Include one, two or three tasteful emojis/);
  assert.match(LOCKED_TEACHER_DIGEST_PROMPT,/Use no more than three question marks/);
  const fixtureText=await readFile(fixtureUrl,"utf8");
  assert.equal(crypto.createHash("sha256").update(fixtureText).digest("hex"),"929ca7a1ca156e49d5ac8ec4ccb050c25c82065a3b5cd8c98d4b053368dddf6c");
  assert.equal("messages" in fixture,false);
});

test("the approved fixture retains ten representative digest examples",()=>{
  assert.deepEqual(fixture.students.map((student)=>student.request_id),[
    "WEDNESDAY-TEST-001","WEDNESDAY-TEST-002","FRIDAY-TEST-001","FRIDAY-TEST-002",
    "SUNDAY-TEST-001","SUNDAY-TEST-002","LAST-SUNDAY-TEST-001","LAST-SUNDAY-TEST-002",
    "NEVER-SUBMITTED-TEST-001","NEVER-SUBMITTED-TEST-002"
  ]);
  assert.deepEqual(fixture.students.map((student)=>student.context.digest_day),["WEDNESDAY","WEDNESDAY","FRIDAY","FRIDAY","SUNDAY","SUNDAY","SUNDAY","SUNDAY","SUNDAY","FRIDAY"]);
  assert.equal(fixture.students[0].evidence.assessed_results.length,4);
  assert.equal(fixture.students[1].evidence.assignment_participation.writing_submitted,false);
  assert.equal(fixture.students[2].evidence.assessed_results.length,6);
  assert.equal(fixture.students[3].evidence.assessed_results.length,0);
  assert.equal(fixture.students[4].evidence.assessed_results.some((result)=>result.result_type==="WEEKLY_AVERAGE"),true);
  assert.equal(fixture.students[5].evidence.assignment_participation.speaking_submitted,false);
  assert.equal(fixture.students[6].evidence.recent_complete_periods.length,4);
  assert.equal(fixture.students[7].evidence.recent_complete_periods.length,4);
  assert.equal(fixture.students[8].context.has_ever_submitted,false);
  assert.equal(fixture.students[9].context.has_ever_submitted,false);
});

test("all ten representative inputs cross the payload boundary and deterministic validator",()=>{
  const batch=buildDigestBatch(fixture);
  assert.deepEqual(batch,fixture);
  for(const student of batch.students){
    assert.deepEqual(Object.keys(student),["request_id","student_name_for_message","language","context","evidence","must_deliver"]);
  }
  const result=validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch)});
  assert.equal(result.ok,true);
  assert.equal(result.valid_messages.length,10);
});

test("DeepSeek receives only the locked prompt and the six approved student fields",()=>{
  const withInternal={...fixture.students[0],internal_rule:"never send",previous_messages:["old"]};
  const batch=buildDigestBatch({batch_id:"test",students:[withInternal]});
  assert.deepEqual(Object.keys(batch.students[0]),["request_id","student_name_for_message","language","context","evidence","must_deliver"]);
  const body=buildDeepSeekDigestRequestBody({batch,model:"deepseek-v4-pro"});
  assert.equal(body.messages[0].content,LOCKED_TEACHER_DIGEST_PROMPT);
  assert.deepEqual(JSON.parse(body.messages[1].content),batch);
  assert.equal(body.messages.length,2);
  assert.equal("max_tokens" in body,false);
});

test("A1 through Module 3 selects French while later A1 and A2–B2 select English",()=>{
  assert.equal(digestLanguageForStudent({level:"A1",current_module:3}),"fr");
  assert.equal(digestLanguageForStudent({level:"A1",current_module:4}),"en");
  for(const level of ["A2","B1","B2"])assert.equal(digestLanguageForStudent({level,current_module:1}),"en");
});

test("Wednesday and Friday inputs remain explicitly incomplete and exclude pending assessments",()=>{
  const request=buildDigestStudentRequest({
    requestId:"request-1",
    student:{student_id:"student-1",student_name:"SURNAME Sarah Michelle",level:"B1",current_module:2,start_date:"2026-01-01"},
    window:{cycle_day:"WEDNESDAY",cycle_date:"2026-09-09"},
    facts:{
      has_ever_submitted:true,
      window_submissions:[{submitted_at:"2026-09-07T08:00:00Z"}],
      window_quizzes:[{submitted_at:"2026-09-08T08:00:00Z"}],
      unseen_quizzes:[{quiz_key:"Quiz 1",percentage:88,submitted_at:"2026-09-08T08:00:00Z"}],
      unseen_feedback:[
        {assignment_key:"Pending writing",writing_status:"PENDING",writing_score:91,speaking_status:"PENDING",speaking_score:90},
        {assignment_key:"Reviewed writing",writing_status:"REVIEWED",writing_score:76,speaking_status:"NOT_ASSESSED",speaking_score:null}
      ],
      feedback_deliveries:[]
    }
  });
  assert.equal(request.context.reporting_period_complete,false);
  assert.equal(request.context.reporting_period_description,"Since the Sunday digest");
  assert.equal(request.evidence.days_available_current_period,3);
  assert.equal(request.evidence.days_worked_current_period,2);
  assert.equal("submitted_items_count" in request.evidence,false);
  assert.equal("active_days_current_period" in request.evidence,false);
  assert.equal(request.evidence.assessed_results.some((result)=>result.assignment_name==="Pending writing"),false);
  assert.equal(request.evidence.assessed_results.some((result)=>result.assignment_name==="Reviewed writing"),true);
  const fridayFixture=fixture.students.find((student)=>student.request_id==="FRIDAY-TEST-001");
  assert.equal(fridayFixture.context.reporting_period_complete,false);
  assert.equal(fridayFixture.context.digest_day,"FRIDAY");
});

test("only the last Sunday receives a natural four-period overview payload",()=>{
  const student={student_id:"student-1",student_name:"SURNAME Sarah Michelle",level:"B1",current_module:2,start_date:"2026-01-01"};
  const fourWeekMetrics=[
    {week_start:"2026-08-23",week_end:"2026-08-29",active_days:2,is_partial_enrollment_week:true,quiz_assessed_count:1,quiz_average:65},
    {week_start:"2026-08-30",week_end:"2026-09-05",active_days:3,is_partial_enrollment_week:false,quiz_assessed_count:2,quiz_average:72},
    {week_start:"2026-09-06",week_end:"2026-09-12",active_days:4,is_partial_enrollment_week:false,writing_assessed_count:1,writing_average:76},
    {week_start:"2026-09-13",week_end:"2026-09-19",active_days:5,is_partial_enrollment_week:false,speaking_assessed_count:2,speaking_average:82},
    {week_start:"2026-09-20",week_end:"2026-09-26",active_days:6,is_partial_enrollment_week:false,quiz_assessed_count:3,quiz_average:88,writing_pending_count:1}
  ];
  const currentMetric=fourWeekMetrics.at(-1);
  const previousMetric=fourWeekMetrics.at(-2);
  const ordinary=buildDigestStudentRequest({
    requestId:"ordinary",
    student,
    window:{cycle_day:"SUNDAY",cycle_date:"2026-09-20"},
    facts:{has_ever_submitted:true,current_metric:currentMetric,previous_metric:previousMetric,four_week_metrics:fourWeekMetrics,is_last_sunday_of_month:false}
  });
  assert.equal("is_last_sunday_of_month" in ordinary.context,false);
  assert.equal("recent_complete_periods" in ordinary.evidence,false);

  const monthly=buildDigestStudentRequest({
    requestId:"monthly",
    student,
    window:{cycle_day:"SUNDAY",cycle_date:"2026-09-27"},
    facts:{has_ever_submitted:true,current_metric:currentMetric,previous_metric:previousMetric,four_week_metrics:fourWeekMetrics,is_last_sunday_of_month:true}
  });
  assert.equal(monthly.context.is_last_sunday_of_month,true);
  assert.equal(monthly.evidence.recent_complete_periods.length,4);
  assert.deepEqual(monthly.evidence.recent_complete_periods.map((period)=>period.period_start),[
    "2026-08-30","2026-09-06","2026-09-13","2026-09-20"
  ]);
  assert.deepEqual(monthly.evidence.recent_complete_periods.map((period)=>period.days_worked),[3,4,5,6]);
  assert.equal(monthly.evidence.recent_complete_periods.at(-1).quiz_average_percent,88);
  assert.equal("writing_pending_count" in monthly.evidence.recent_complete_periods.at(-1),false);
});

test("partial-enrolment periods are not used for ordinary Sunday comparisons",()=>{
  const request=buildDigestStudentRequest({
    requestId:"partial-period",
    student:{student_id:"student-1",student_name:"SURNAME Sarah Michelle",level:"B1",start_date:"2026-09-16"},
    window:{cycle_day:"SUNDAY",cycle_date:"2026-09-20"},
    facts:{
      has_ever_submitted:true,
      current_metric:{active_days:3,is_partial_enrollment_week:false},
      previous_metric:{active_days:1,is_partial_enrollment_week:true}
    }
  });
  assert.equal("days_worked_previous_complete_period" in request.evidence,false);
});

test("a partial current week receives gentle routine guidance without a four-day target",()=>{
  const request=buildDigestStudentRequest({
    requestId:"partial-current-week",
    student:{student_id:"student-1",student_name:"SURNAME Sarah Michelle",level:"B1",start_date:"2026-09-23"},
    window:{cycle_day:"SUNDAY",cycle_date:"2026-09-27"},
    facts:{
      has_ever_submitted:true,
      current_metric:{active_days:2,eligible_days:4,is_partial_enrollment_week:true},
      four_week_metrics:[{week_start:"2026-09-20",active_days:2,is_partial_enrollment_week:true}]
    }
  });
  assert.equal(request.evidence.participation_pattern.pattern,"PARTIAL_ENROLMENT_WEEK");
  assert.equal(request.evidence.participation_pattern.consistency_priority_next_week,"BUILD_ROUTINE_GENTLY");
  assert.equal("suggested_active_days_next_week" in request.evidence.participation_pattern,false);
});

test("Sunday payload distinguishes weekly averages from named assessed assignments and working days",()=>{
  const request=buildDigestStudentRequest({
    requestId:"sunday-coverage",
    student:{student_id:"student-1",student_name:"SURNAME Esther Marie",level:"B1",start_date:"2026-01-01"},
    window:{cycle_day:"SUNDAY",cycle_date:"2026-09-20"},
    facts:{
      has_ever_submitted:true,
      current_metric:{active_days:5,eligible_days:7,quiz_assessed_count:3,quiz_average:88,writing_activity_count:1,speaking_activity_count:1,writing_assessed_count:1,writing_average:72},
      previous_metric:{active_days:3,is_partial_enrollment_week:false},
      window_submissions:[{submitted_at:"2026-09-16T08:00:00Z"}],
      unseen_feedback:[{assignment_key:"B1 Module 2 – Unit 3 – Integrated Assignment",writing_status:"REVIEWED",writing_score:64,speaking_status:"REVIEWED",speaking_score:82}],
      feedback_deliveries:[]
    }
  });
  assert.deepEqual(request.evidence.assessed_results,[
    {skill:"QUIZ",result_type:"WEEKLY_AVERAGE",score_percent:88},
    {skill:"WRITING",result_type:"WEEKLY_AVERAGE",score_percent:72},
    {skill:"WRITING",assignment_name:"B1 Module 2 – Unit 3 – Integrated Assignment",result_type:"ASSESSED_ASSIGNMENT",score_percent:64},
    {skill:"SPEAKING",assignment_name:"B1 Module 2 – Unit 3 – Integrated Assignment",result_type:"ASSESSED_ASSIGNMENT",score_percent:82}
  ]);
  assert.equal(request.evidence.days_worked_current_period,5);
  assert.equal(request.evidence.days_available_current_period,7);
  assert.equal(request.evidence.days_worked_previous_complete_period,3);
  assert.deepEqual(request.evidence.assignment_participation,{
    period_scope:"COMPLETE_WEEK",
    writing_submitted:true,
    speaking_submitted:true,
    writing_assignment_count:1,
    speaking_assignment_count:1
  });
  assert.equal("no_assignment_submitted_current_period" in request.evidence,false);
});

test("Sunday assignment evidence always uses the complete week instead of the Friday-Saturday window",()=>{
  const combinations=[
    {writing:0,speaking:0},
    {writing:2,speaking:0},
    {writing:0,speaking:1},
    {writing:2,speaking:1}
  ];
  for(const combination of combinations){
    const request=buildDigestStudentRequest({
      requestId:`sunday-${combination.writing}-${combination.speaking}`,
      student:{student_id:"student-1",student_name:"SURNAME Esther Marie",level:"B1",start_date:"2026-01-01"},
      window:{cycle_day:"SUNDAY",cycle_date:"2026-09-27",activity_window_start:"2026-09-25T00:00:00+01:00",activity_window_end_exclusive:"2026-09-27T00:00:00+01:00"},
      facts:{
        has_ever_submitted:true,
        window_submissions:[],
        current_metric:{
          week_start:"2026-09-20",active_days:3,eligible_days:7,
          writing_activity_count:combination.writing,
          speaking_activity_count:combination.speaking
        },
        previous_metric:{active_days:4,is_partial_enrollment_week:false},
        four_week_metrics:[
          {week_start:"2026-09-06",active_days:5,is_partial_enrollment_week:false},
          {week_start:"2026-09-13",active_days:4,is_partial_enrollment_week:false},
          {week_start:"2026-09-20",active_days:3,is_partial_enrollment_week:false}
        ]
      }
    });
    assert.equal(request.evidence.assignment_participation.period_scope,"COMPLETE_WEEK");
    assert.equal(request.evidence.assignment_participation.writing_submitted,combination.writing>0);
    assert.equal(request.evidence.assignment_participation.speaking_submitted,combination.speaking>0);
    assert.equal("no_assignment_submitted_current_period" in request.evidence,false);
    assert.equal(request.evidence.participation_pattern.pattern,"DECLINING");
    assert.equal(request.evidence.participation_pattern.consecutive_weeks_below_four_days,1);
    assert.equal(request.evidence.participation_pattern.consistency_priority_next_week,"STRONGER");
    assert.equal(request.evidence.participation_pattern.suggested_active_days_next_week,4);
  }
});

test("Sunday inactivity payload supplies the last assignment date in the student's language",()=>{
  const request=buildDigestStudentRequest({
    requestId:"sunday-last-assignment",
    student:{student_id:"student-1",student_name:"SURNAME Nadia Prisca",level:"A1",current_module:2,start_date:"2026-01-01"},
    window:{cycle_day:"SUNDAY",cycle_date:"2026-09-20"},
    facts:{
      has_ever_submitted:true,
      last_assignment_at:new Date("2026-09-12T23:30:00.000Z"),
      current_metric:{active_days:0,eligible_days:7,writing_activity_count:0,speaking_activity_count:0},
      previous_metric:{active_days:2,is_partial_enrollment_week:false},
      four_week_metrics:[{week_start:"2026-09-13",active_days:0,is_partial_enrollment_week:false}]
    }
  });

  assert.equal(request.evidence.most_recent_assignment_date,"2026-09-13");
  assert.equal(request.evidence.most_recent_assignment_date_for_message,"13 septembre 2026");
});

test("Sunday messages with no assignment must include the supplied last assignment date",()=>{
  const student={
    request_id:"sunday-last-assignment",
    student_name_for_message:"Nadia Prisca",
    language:"fr",
    context:{digest_day:"SUNDAY",reporting_period_complete:true,has_ever_submitted:true},
    evidence:{
      assessed_results:[],
      assignment_participation:{period_scope:"COMPLETE_WEEK",writing_submitted:false,speaking_submitted:false},
      most_recent_assignment_date:"2026-09-13",
      most_recent_assignment_date_for_message:"13 septembre 2026"
    },
    must_deliver:[]
  };
  const batch=buildDigestBatch({batch_id:"last-assignment-date",students:[student]});
  const missing=validateDigestBatchResponse({
    expectedBatch:batch,
    response:JSON.stringify({batch_id:"last-assignment-date",messages:[{
      request_id:student.request_id,
      message:"Bonjour Nadia Prisca, j’espère que vous allez bien. 🙂\n\nJe n’ai reçu aucun devoir cette semaine.\n\nMr John"
    }]})
  });
  assert.equal(missing.ok,false);
  assert.match(missing.invalid_messages[0].errors.join(" "),/LAST_ASSIGNMENT_DATE_MISSING:13 septembre 2026/);

  const included=validateDigestBatchResponse({
    expectedBatch:batch,
    response:JSON.stringify({batch_id:"last-assignment-date",messages:[{
      request_id:student.request_id,
      message:"Bonjour Nadia Prisca, j’espère que vous allez bien. 🙂\n\nVotre dernier devoir remonte au 13 septembre 2026.\n\nMr John"
    }]})
  });
  assert.equal(included.ok,true);
});

test("Friday payload uses the two-day interim window and marks a missing assignment without submission counts",()=>{
  const request=buildDigestStudentRequest({
    requestId:"friday-no-assignment",
    student:{student_id:"student-1",student_name:"SURNAME Patrick Junior",level:"A2",start_date:"2026-01-01"},
    window:{cycle_day:"FRIDAY",cycle_date:"2026-09-18"},
    facts:{
      has_ever_submitted:true,
      window_submissions:[],
      window_quizzes:[],
      unseen_quizzes:[],
      unseen_feedback:[],
      feedback_deliveries:[]
    }
  });
  assert.equal(request.evidence.days_available_current_period,2);
  assert.equal(request.evidence.days_worked_current_period,0);
  assert.deepEqual(request.evidence.assignment_participation,{
    period_scope:"INTERIM_WINDOW",
    writing_submitted:false,
    speaking_submitted:false,
    writing_assignment_count:0,
    speaking_assignment_count:0
  });
  assert.equal("submitted_items_count" in request.evidence,false);
});

test("batch_id is the only accepted batch identity field",()=>{
  assert.equal(buildDigestBatch({batch_id:"canonical",students:fixture.students.slice(0,1)}).batch_id,"canonical");
  assert.throws(
    ()=>buildDigestBatch({batchId:"legacy",students:fixture.students.slice(0,1)}),
    /batch_id is required/
  );
});

test("seventy-seven students are preserved across all default DeepSeek batches",()=>{
  const students=Array.from({length:77},(_,index)=>({
    ...fixture.students[index%fixture.students.length],
    request_id:`request-${String(index+1).padStart(3,"0")}`
  }));
  const partitions=partitionDigestItems(students);
  assert.deepEqual(partitions.map((items)=>items.length),[10,10,10,10,10,10,10,7]);
  const processed=[];
  for(const [index,items] of partitions.entries()){
    const batch=buildDigestBatch({batch_id:`batch-${index+1}`,students:items});
    const result=validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch)});
    assert.equal(result.ok,true);
    processed.push(...result.valid_messages.map((message)=>message.request_id));
  }
  assert.deepEqual(processed,students.map((student)=>student.request_id));
});

test("malformed DeepSeek JSON is rejected for every expected request",()=>{
  const batch=buildDigestBatch({batch_id:"batch",students:fixture.students.slice(0,2)});
  const result=validateDigestBatchResponse({expectedBatch:batch,response:"not json"});
  assert.equal(result.ok,false);
  assert.deepEqual(result.missing_request_ids,batch.students.map((student)=>student.request_id));
  assert.equal(result.invalid_messages.length,2);
});

test("a mismatched batch_id is rejected without accepting any output",()=>{
  const batch=buildDigestBatch({batch_id:"batch",students:fixture.students.slice(0,2)});
  const result=validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch,{batch_id:"another-batch"})});
  assert.equal(result.ok,false);
  assert.deepEqual(result.batch_errors,["BATCH_ID_MISMATCH"]);
  assert.equal(result.valid_messages.length,0);
});

test("missing and duplicate request IDs are isolated while valid outputs remain reusable",()=>{
  const batch=buildDigestBatch({batch_id:"batch",students:fixture.students.slice(0,3)});
  const first=batch.students[0];const second=batch.students[1];
  const result=validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch,{messages:[
    {request_id:first.request_id,message:validMessage(first)},
    {request_id:second.request_id,message:validMessage(second)},
    {request_id:second.request_id,message:validMessage(second)}
  ]})});
  assert.equal(result.ok,false);
  assert.deepEqual(result.valid_messages.map((item)=>item.request_id),[first.request_id]);
  assert.deepEqual(result.duplicate_request_ids,[second.request_id]);
  assert.deepEqual(result.missing_request_ids,[batch.students[2].request_id]);
});

test("an unexpected output invalidates the response instead of publishing a partial batch",()=>{
  const batch=buildDigestBatch({batch_id:"batch",students:fixture.students.slice(0,2)});
  const messages=batch.students.map((student)=>({request_id:student.request_id,message:validMessage(student)}));
  messages.push({request_id:"UNEXPECTED",message:"Unexpected Student, hello. 🙂\n\nText.\n\nMr John"});
  const result=validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch,{messages})});
  assert.equal(result.ok,false);
  assert.deepEqual(result.unexpected_request_ids,["UNEXPECTED"]);
  assert.equal(result.valid_messages.length,0);
});

test("a response that changes the requested student order is rejected",()=>{
  const batch=buildDigestBatch({batch_id:"batch",students:fixture.students.slice(0,2)});
  const messages=batch.students.map((student)=>({request_id:student.request_id,message:validMessage(student)})).reverse();
  const result=validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch,{messages})});
  assert.equal(result.ok,false);
  assert.deepEqual(result.batch_errors,["ORDER_MISMATCH"]);
  assert.equal(result.valid_messages.length,0);
});

test("missing correction names or URLs are rejected exactly",()=>{
  const student=fixture.students.find((candidate)=>candidate.must_deliver.length>0);const batch=buildDigestBatch({batch_id:"batch",students:[student]});
  for(const message of [
    `${greetingFor(student)} hello. 🙂\n\n${student.must_deliver[0].correction_url}\n\nMr John`,
    `${greetingFor(student)} hello. 🙂\n\n${student.must_deliver[0].assignment_name}\n\nMr John`
  ])assert.equal(validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch,{messages:[{request_id:student.request_id,message}]})}).ok,false);
});

test("Markdown, asterisks, excessive questions and a missing final signature are rejected",()=>{
  const student=fixture.students[0];const batch=buildDigestBatch({batch_id:"batch",students:[student]});
  const invalid=[
    `${greetingFor(student)} hello. 🙂\n\n# Heading\n\nMr John`,
    `${greetingFor(student)} hello. 🙂\n\n*emphasis*\n\nMr John`,
    `${greetingFor(student)} how are you? 🙂\n\nCan I help? What happened? Shall we work together?\n\nMr John`,
    `${greetingFor(student)} hello. 🙂\n\nNo signature`,
    `${greetingFor(student)} hello. 🙂\n\nMr John\n\nContent after the signature.\n\nMr John`
  ];
  for(const message of invalid)assert.equal(validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch,{messages:[{request_id:student.request_id,message}]})}).ok,false);
});

test("the exact student-facing name and one to three emojis are mandatory",()=>{
  const student=fixture.students.find((candidate)=>candidate.must_deliver.length===0);const batch=buildDigestBatch({batch_id:"batch",students:[student]});
  const invalid=[
    `Hello Another Student, hello. 🙂\n\nI reviewed the evidence.\n\nMr John`,
    `${greetingFor(student)} hello.\n\nI reviewed the evidence.\n\nMr John`,
    `${greetingFor(student)} hello. 🙂 😊 🌟 👍\n\nI reviewed the evidence.\n\nMr John`
  ];
  for(const message of invalid)assert.equal(validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch,{messages:[{request_id:student.request_id,message}]})}).ok,false);
  for(const message of [
    `${greetingFor(student)} how are you? 🙂\n\nDo you need help? Shall we continue?\n\nMr John`,
    `${greetingFor(student)} hello. 🙂 😊 🌟\n\nI reviewed the evidence.\n\nMr John`
  ])assert.equal(validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch,{messages:[{request_id:student.request_id,message}]})}).ok,true);
});

test("English and French messages must begin with the required localised greeting",()=>{
  for(const language of ["en","fr"]){
    const student=fixture.students.find((candidate)=>candidate.language===language&&candidate.must_deliver.length===0);
    const batch=buildDigestBatch({batch_id:`greeting-${language}`,students:[student]});
    const requiredDate=student.evidence?.most_recent_assignment_date_for_message||"";
    const wrong=`${student.student_name_for_message}, I hope you are well. 🙂\n\nI reviewed the evidence. ${requiredDate}\n\nMr John`;
    const result=validateDigestBatchResponse({expectedBatch:batch,response:responseFor(batch,{messages:[{request_id:student.request_id,message:wrong}]})});
    assert.equal(result.ok,false);
    assert.deepEqual(result.invalid_messages[0].errors,["REQUIRED_GREETING_MISSING"]);
  }
});

test("behavioural evidence keeps learning, assignment, writing and speaking recency distinct",async()=>{
  const repository=await readFile(new URL("../src/supabase/teacherDigestPersonalisationRepository.js",import.meta.url),"utf8");
  assert.match(repository,/max\(submitted_at\) as last_submission_at/);
  assert.match(repository,/filter \(where is_assignment\) as last_assignment_at/);
  assert.match(repository,/filter \(where has_writing\) as last_writing_at/);
  assert.match(repository,/filter \(where has_speaking\) as last_speaking_at/);
});

test("digest persistence is idempotent and retries only non-validated request IDs",async()=>{
  const repository=await readFile(new URL("../src/supabase/teacherDigestDeepSeekRepository.js",import.meta.url),"utf8");
  const digest=await readFile(new URL("../src/supabase/teacherDigestRepository.js",import.meta.url),"utf8");
  assert.match(repository,/on conflict\(run_id,student_id\) do nothing/);
  assert.doesNotMatch(repository,/on conflict\(run_id,student_id\) do update/);
  assert.doesNotMatch(repository,/delete from teacher_digest_deepseek_evidence_items/);
  assert.match(repository,/for \(const item of isNewRun \? evidenceItems : \[\]\)/);
  assert.match(repository,/status not in\('VALIDATED','INCLUDED'\)/);
  assert.match(repository,/remaining = remaining\.filter/);
  assert.match(repository,/partitionDigestItems\(due,batchSize\)/);
  assert.match(repository,/reasoning_tokens=\$8/);
  assert.match(repository,/completion_tokens_details/);
  assert.match(repository,/where run_id=\$1::uuid and status='RETRY_WAIT' and attempt_count>=\$2/);
  assert.match(digest,/WAITING_FOR_VALID_DIGEST_MESSAGES/);
  assert.match(digest,/deepseek_generation_run_id/);
});

test("A1 language selection uses the latest valid submitted module even outside the evidence window",async()=>{
  const digest=await readFile(new URL("../src/supabase/teacherDigestRepository.js",import.meta.url),"utf8");
  assert.match(digest,/left join lateral \([\s\S]*select si\.module as current_module[\s\S]*order by si\.submitted_at desc, si\.id desc[\s\S]*limit 1[\s\S]*\) latest_progress on true/);
  assert.match(digest,/latest_progress\.current_module/);
  assert.equal(digestLanguageForStudent({level:"A1",current_module:4}),"en");
});

test("retired fragment tables are absent from executable source and Monday encouragement remains registered",async()=>{
  const files=[
    "../src/supabase/teacherDigestRepository.js",
    "../src/supabase/teacherDigestPersonalisationRepository.js",
    "../src/supabase/emailQueueRepository.js",
    "../src/supabase/diagnostics.js"
  ];
  for(const file of files){const source=await readFile(new URL(file,import.meta.url),"utf8");assert.doesNotMatch(source,/teacher_digest_(?:whatsapp_components|student_messages|message_feedback_items|message_quiz_items)/);}
  const personalisation=await readFile(new URL("../src/teacherDigest/personalisation.js",import.meta.url),"utf8");
  assert.doesNotMatch(personalisation,/composeStudentDigestMessage|chooseDigestComponent|situation_code/);
  await assert.rejects(
    readFile(new URL("../src/teacherDigest/messageCatalogue.js",import.meta.url),"utf8"),
    (error)=>error?.code==="ENOENT"
  );
  const scheduler=await readFile(new URL("../src/scheduler.js",import.meta.url),"utf8");
  assert.match(scheduler,/JEA Weekly Encouragement Queue/);
});

test("the test-generation route is dry-run by default and never queues delivery",async()=>{
  const routes=await readFile(new URL("../src/routes/teacherDigestRoutes.js",import.meta.url),"utf8");
  assert.match(routes,/\/worker\/teacher-digest\/test-generation/);
  assert.match(routes,/DEEPSEEK_TEST_GENERATION_DRY_RUN/);
  assert.match(routes,/call-deepseek-test-generation/);
  assert.match(routes,/persisted:\s*false/);
  assert.match(routes,/delivery_queued:\s*false/);
});
