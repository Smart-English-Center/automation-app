import { reminderWhatsAppMessage, topicWhatsAppMessage, whatsappUrl } from "./emailRenderer.js";

function clean(value){return String(value??"").trim();}
function phone(row){return clean(row.whatsapp_number||row.phone);}
function levelRank(level){return({A1:1,A2:2,B1:3,B2:4})[clean(level).toUpperCase()]||9;}
function topicMap(topics){return topics.reduce((m,t)=>{(m[t.target_id]||=[]).push(t);return m;},{});}
function byLevelAndName(a,b){return levelRank(a.level)-levelRank(b.level)||clean(a.full_name).localeCompare(clean(b.full_name),"en",{sensitivity:"base"});}

export function assertTeacherPdfPayload(payload,{expectedTargetCount,expectedTopicCount}={}){
  if(!payload||typeof payload!=="object"||Array.isArray(payload))throw new Error("Teacher PDF payload must be an object.");
  if(!clean(payload.document?.title))throw new Error("Teacher PDF payload is missing its document title.");
  if(!Array.isArray(payload.sections)||payload.sections.length===0)throw new Error("Teacher PDF payload contains no sections.");

  const entries=payload.sections.flatMap((section)=>Array.isArray(section?.entries)?section.entries:[]);
  const topics=entries.flatMap((entry)=>Array.isArray(entry?.topics)?entry.topics:[]);
  const expectedEntries=Number(expectedTargetCount);
  const expectedTopics=Number(expectedTopicCount);

  if(entries.length===0)throw new Error("Teacher PDF payload contains no visible entries.");
  if(Number.isInteger(expectedEntries)&&expectedEntries>=0&&entries.length!==expectedEntries){
    throw new Error(`Teacher PDF payload entry count mismatch: expected ${expectedEntries}, received ${entries.length}.`);
  }
  if(Number.isInteger(expectedTopics)&&expectedTopics>=0&&topics.length!==expectedTopics){
    throw new Error(`Teacher PDF payload topic count mismatch: expected ${expectedTopics}, received ${topics.length}.`);
  }

  for(const entry of entries){
    if(!clean(entry?.name))throw new Error("Teacher PDF payload contains an entry without a name.");
    const entryTopics=Array.isArray(entry?.topics)?entry.topics:[];
    const entryActions=Array.isArray(entry?.whatsapp_actions)?entry.whatsapp_actions:[];
    if(entryTopics.length===0&&entryActions.length===0){
      throw new Error(`Teacher PDF entry ${clean(entry.name)} contains neither topics nor a WhatsApp action.`);
    }
  }

  for(const topic of topics){
    if(!clean(topic?.title)||!clean(topic?.learner_content?.heading)||!clean(topic?.learner_content?.body)){
      throw new Error("Teacher PDF payload contains an incomplete learner topic.");
    }
  }

  return{sectionCount:payload.sections.length,entryCount:entries.length,topicCount:topics.length};
}

function normalTopic(topic,row){
  const curriculum=row.curriculum_snapshot||{};
  return{position:topic.position,label:"Topic",title:topic.title,learner_content:topic.learner_content,teacher_sections:topic.teacher_sections,whatsapp_actions:[{url:whatsappUrl({phone:phone(row),message:topicWhatsAppMessage({topic,curriculum})}),label:`Send Topic ${topic.position} to ${row.full_name||row.student_name_snapshot} on WhatsApp`,helper_text:phone(row)?"":"WhatsApp will ask you to choose the recipient."}]};
}

function groupEntry(row,topics,config){
  const missing=row.status==="PROFILE_MISSING";
  return{name:row.full_name,meta:row.curriculum_snapshot?.first_week_basis?`First week of ${row.level}`:`${row.level} - Module ${row.curriculum_snapshot?.module||1} - Unit ${row.curriculum_snapshot?.unit||1} - Day ${row.curriculum_snapshot?.day||1}`,badges:missing?[{tone:"yellow",label:"PROFILE MISSING"},{tone:"green",label:"REMINDER DELIVERED"}]:[{tone:"green",label:"TOPICS DELIVERED"}],notice:missing?{tone:"yellow",title:"Speaking profile not completed",body:"The student received the missing-profile email instead of topics."}:{tone:"blue",title:"",body:""},topics:missing?[]:(topics[row.id]||[]).map((t)=>normalTopic(t,row)),whatsapp_actions:missing?[{url:whatsappUrl({phone:phone(row),message:reminderWhatsAppMessage({studentName:row.full_name,formUrl:config.profileFormUrl,curriculum:row.curriculum_snapshot})}),label:`Send the profile reminder to ${row.full_name} on WhatsApp`,helper_text:phone(row)?"":"WhatsApp will ask you to choose the recipient."}]:[]};
}

function privateEntry(row,topics){
  const missing=row.generation_basis==="temporary_level";
  return{name:row.full_name,meta:`${row.level} - Module ${row.curriculum_snapshot?.module||1} - Unit ${row.curriculum_snapshot?.unit||1} - Day ${row.curriculum_snapshot?.day||1}`,badges:missing?[{tone:"yellow",label:"PROFILE MISSING"},{tone:"blue",label:"TEMPORARY LEVEL-BASED TOPICS"}]:[{tone:"green",label:"PERSONALISED TOPICS"}],notice:missing?{tone:"yellow",title:"Speaking profile not completed",body:"These temporary topics and this notice are provided to the assigned teacher only. No email is sent directly to the private student."}:{tone:"blue",title:"",body:""},topics:row.status==="READY"?(topics[row.id]||[]).map((t)=>normalTopic(t,row)):[],whatsapp_actions:[],pending:row.status!=="READY"};
}

function ieltsTopic(topic,students){
  const learner=topic.learner_content||{};
  return{position:topic.position,label:"IELTS set",title:topic.title,learner_content:learner,teacher_sections:topic.teacher_sections,whatsapp_actions:students.map((student)=>({url:whatsappUrl({phone:phone(student),message:`${learner.body}\n${(learner.points||[]).map((p)=>`• ${p}`).join("\n")}\n\n*The John’s English Academy Team*`}),label:`Send this cue card to ${student.full_name} on WhatsApp`,helper_text:phone(student)?"":"WhatsApp will ask you to choose the recipient."}))};
}

export function buildTeacherPdfPayload({job,cycle,rows=[],topics=[],ielts=null,ieltsStudents=[],config}){
  const byTarget=topicMap(topics);const scope=job.document_scope;const privateRows=rows.filter((r)=>r.target_type==="private");
  const sections=[];
  if(scope==="group"){
    const level=clean(job.audience_snapshot?.group_level||rows[0]?.level).toUpperCase();
    const entries=[...rows].sort(byLevelAndName).map((row)=>groupEntry(row,byTarget,config));
    if(entries.length)sections.push({title:`GROUP STUDENTS — ${level}`,count_label:`${entries.length} students`,start_new_page:false,entries});
  }else{
    const grouped=new Map();
    for(const row of [...privateRows].sort(byLevelAndName)){const level=clean(row.level).toUpperCase();if(!grouped.has(level))grouped.set(level,[]);grouped.get(level).push(row);}
    for(const [level,levelRows] of [...grouped].sort(([left],[right])=>levelRank(left)-levelRank(right))){
      sections.push({title:`PRIVATE STUDENTS — ${level}`,count_label:`${levelRows.length} students`,start_new_page:sections.length>0,entries:levelRows.map((row)=>privateEntry(row,byTarget))});
    }
    const orderedIelts=[...ieltsStudents].sort((a,b)=>clean(a.full_name).localeCompare(clean(b.full_name),"en",{sensitivity:"base"}));
    if(ielts&&ielts.status==="READY"&&orderedIelts.length)sections.push({title:"IELTS STUDENTS",count_label:`10 weekly sets shared by ${orderedIelts.length} IELTS students`,start_new_page:sections.length>0,entries:[{name:"Shared IELTS material",meta:`Assigned students: ${orderedIelts.map((s)=>s.full_name).join(", ")}`,badges:[{tone:"blue",label:"IELTS"},{tone:"green",label:"SHARED WEEKLY SETS"}],notice:{tone:"blue",title:"WhatsApp content restriction",body:"Each student button contains only the corresponding Part 2 cue card. Parts 1 and 3 and the brief follow-up questions remain exclusive to this teacher document."},topics:(byTarget[ielts.id]||[]).map((t)=>ieltsTopic(t,orderedIelts)),whatsapp_actions:[]}]});
  }
  const title=scope==="group"
    ? `Group ${clean(job.audience_snapshot?.group_level||rows[0]?.level).toUpperCase()} Speaking Practice Topics`
    : privateRows.length&&ielts?"Private and IELTS Speaking Practice Topics":privateRows.length?"Private Speaking Practice Topics":"IELTS Speaking Practice Topics";
  return{academy:{name:"John's English Academy"},document:{title,recipient_label:job.audience_snapshot?.recipient_label||"Teacher materials",cycle_label:cycle.cycle_date,generated_at_label:new Date().toISOString(),part_number:job.part_number,total_parts:job.total_parts,entry_range_label:job.entry_range_label||"",footer_text:"Generated by John's English Academy automation system. Teacher-only document - do not forward."},summary:{cards:job.audience_snapshot?.summary_cards||[]},notices:[{tone:"blue",title:"Teacher-only document:",body:"Teacher questions must not be forwarded. WhatsApp buttons contain only learner-facing topics or IELTS Part 2 cue cards."}],sections};
}
