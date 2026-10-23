import { studentFacingName } from "../studentFacingName.js";

function clean(value){return String(value??"").trim();}
function escapeHtml(value){return clean(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function earlyFrench(curriculum={}){return String(curriculum.level).toUpperCase()==="A1"&&Number(curriculum.module||1)<=3;}

function learnerText(topic){
  const learner=topic.learner_content||{};
  return [topic.title,learner.body,...(Array.isArray(learner.points)?learner.points.map((p)=>`• ${p}`):[])].filter(Boolean).join("\n");
}

export function whatsappUrl({phone,message}){
  const number=clean(phone).replace(/\D/g,"");
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`;
}

export function topicWhatsAppMessage({topic,curriculum={}}){
  const french=earlyFrench(curriculum);
  const signature=french?"*L’équipe de John’s English Academy*":"*The John’s English Academy Team*";
  return `${learnerText(topic)}\n\n${signature}`;
}

export function reminderWhatsAppMessage({studentName,formUrl,curriculum={}}){
  const french=earlyFrench(curriculum);
  const displayName=studentFacingName(studentName,french?"cher apprenant":"there");
  if(french)return `Bonjour ${displayName},\n\nVos sujets de pratique orale ne sont pas encore disponibles parce que votre profil n’a pas été rempli. Complétez ce formulaire : ${formUrl}\n\n*L’équipe de John’s English Academy*`;
  return `Hello ${displayName},\n\nYour speaking-practice topics are not ready because your speaking profile has not been completed. Please complete this form: ${formUrl}\n\n*The John’s English Academy Team*`;
}

function shell({title,preheader,content}){return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,sans-serif;background:#f4f6f8;color:#172033;margin:0;padding:24px"><div style="display:none">${escapeHtml(preheader)}</div><main style="max-width:680px;margin:auto;background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px"><div style="font-weight:bold;color:#344054">John's English Academy</div>${content}</main></body></html>`;}

export function renderGroupTopicsEmail(target){
  const curriculum=target.curriculum_snapshot||{};const french=earlyFrench(curriculum);
  const subject=french?"Vos sujets de pratique orale":"Your speaking-practice topics";
  const displayName=studentFacingName(target.student_name,french?"cher apprenant":"there");
  const responseUrl=clean(target.topic_response_url);
  if(!responseUrl)throw new Error("The group speaking-topic email is missing its response URL.");
  const introParagraphs=french
    ? [
        `Bonjour ${displayName},`,
        "Voici vos trois sujets personnalisés de pratique orale. Pendant la séance, vous devrez parler en anglais.",
        "Pour vous préparer, choisissez un ou deux sujets et réfléchissez à ce que vous aimeriez dire. Vous pouvez noter quelques mots-clés ou les principales idées que vous souhaitez mentionner, mais n’écrivez pas de réponses complètes ni tout ce que vous prévoyez de dire. Pendant la conversation, utilisez vos notes seulement comme guide. Le but est de vous aider à parler naturellement en anglais, et non à lire un texte préparé."
      ]
    : [
        `Hello ${displayName},`,
        "Here are your three personalised speaking-practice topics.",
        "To prepare, choose one or two topics and think about what you would like to say. You may write down a few keywords or the main ideas you want to mention, but do not write complete answers or everything you plan to say. During the conversation, use your notes only as a guide. The goal is to help you speak naturally, not read a prepared text."
      ];
  const lessonNote=curriculum.first_week_basis?(french?"Commencez aussi vos leçons afin de vous sentir progressivement plus à l’aise pendant la pratique orale.":"Please also start your lessons so that you can feel increasingly comfortable during speaking practice."):"";
  const responseInstruction=french
    ? "Après avoir discuté d’un sujet avec votre professeur, marquez-le comme discuté à l’aide du bouton ci-dessous. Vous devez répondre pour les trois sujets. Les sujets non discutés vous seront envoyés de nouveau la prochaine fois."
    : "After discussing a topic with your teacher, mark it as discussed using the button below. You must answer for all three topics. Topics that have not been discussed will be sent to you again next time.";
  const responseLabel=french?"Mettre à jour mes sujets":"Update my speaking topics";
  const blocks=target.topics.map((topic,index)=>{const l=topic.learner_content||{};return `<section style="border:1px solid #e5e7eb;border-radius:10px;padding:15px;margin:16px 0"><h2 style="font-size:17px">${index+1}. ${escapeHtml(topic.title)}</h2><p>${escapeHtml(l.body)}</p>${Array.isArray(l.points)?`<ul>${l.points.map((p)=>`<li>${escapeHtml(p)}</li>`).join("")}</ul>`:""}</section>`;}).join("");
  const html=shell({title:subject,preheader:subject,content:`<h1 style="font-size:22px">${escapeHtml(subject)}</h1>${introParagraphs.map((paragraph)=>`<p>${escapeHtml(paragraph)}</p>`).join("")}${blocks}${lessonNote?`<p>${escapeHtml(lessonNote)}</p>`:""}<p>${escapeHtml(responseInstruction)}</p><p><a href="${escapeHtml(responseUrl)}" style="display:inline-block;background:#2563eb;color:white;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:9px">${escapeHtml(responseLabel)}</a></p><p><strong>${french?"L’équipe de John’s English Academy":"The John’s English Academy Team"}</strong></p>`});
  const text=[...introParagraphs,...target.topics.map((t,i)=>`${i+1}. ${learnerText(t)}`),lessonNote,responseInstruction,`${responseLabel}: ${responseUrl}`,french?"L’équipe de John’s English Academy":"The John’s English Academy Team"].filter(Boolean).join("\n\n");
  return{subject,html,text};
}

export function renderProfileReminderEmail(target,{formUrl}){
  const curriculum=target.curriculum_snapshot||{};const french=earlyFrench(curriculum);
  const subject=french?"Complétez votre profil de pratique orale":"Complete your speaking-practice profile";
  const displayName=studentFacingName(target.student_name,french?"cher apprenant":"there");
  const body=french?`Bonjour ${displayName}, vos sujets personnalisés n’ont pas été créés parce que votre profil de pratique orale n’a pas encore été rempli. Utilisez le bouton ci-dessous pour compléter le formulaire.`:`Hello ${displayName}, your personalised topics have not been created because your speaking-practice profile has not been completed. Use the button below to complete the form.`;
  const html=shell({title:subject,preheader:subject,content:`<h1 style="font-size:22px">${escapeHtml(subject)}</h1><p>${escapeHtml(body)}</p><p><a href="${escapeHtml(formUrl)}" style="display:inline-block;background:#2563eb;color:white;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:9px">${french?"Remplir le formulaire":"Complete the form"}</a></p><p><strong>${french?"L’équipe de John’s English Academy":"The John’s English Academy Team"}</strong></p>`});
  return{subject,html,text:`${body}\n\n${formUrl}\n\n${french?"L’équipe de John’s English Academy":"The John’s English Academy Team"}`};
}

const SPEAKING_LEVELS=["A1","A2","B1","B2"];

function naturalList(values){const items=[...new Set(values.filter(Boolean))];if(items.length<2)return items[0]||"";if(items.length===2)return `${items[0]} and ${items[1]}`;return `${items.slice(0,-1).join(", ")} and ${items.at(-1)}`;}
function formattedSpeakingDate(value){const date=new Date(`${clean(value).slice(0,10)}T12:00:00Z`);if(Number.isNaN(date.getTime()))throw new Error("Speaking teacher bundle has an invalid cycle date.");const parts=new Intl.DateTimeFormat("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric",timeZone:"UTC"}).formatToParts(date);const get=(type)=>parts.find((part)=>part.type===type)?.value||"";return `${get("weekday")} ${get("day")} ${get("month")} ${get("year")}`;}
function teacherGreeting(name){const display=studentFacingName(name,"");return display?`Hello ${display},`:"Hello,";}
function teacherButton(url,label){return `<p style="margin:16px 0"><a href="${escapeHtml(url)}" style="display:inline-block;background:#166534;color:white;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:9px">${escapeHtml(label)}</a></p>`;}
function teacherDocumentButtonLabel(document,context){if(document.material_type==="GROUP")return document.total_parts>1?`Open ${document.level} document — Part ${document.part_number}`:`Open ${document.level} document`;if(document.has_private&&document.has_ielts)return "Open private and IELTS document";return context==="PRIVATE"?"Open private document":"Open IELTS document";}

export function renderTeacherMaterialEmail(bundle){
  const documents=Array.isArray(bundle?.documents)?bundle.documents:[];
  if(!documents.length)throw new Error("Speaking teacher bundle contains no documents.");
  const groupDocuments=documents.filter((document)=>document.material_type==="GROUP");
  const assignedDocuments=documents.filter((document)=>document.material_type==="ASSIGNED");
  const levels=SPEAKING_LEVELS.filter((level)=>groupDocuments.some((document)=>document.level===level));
  const hasPrivate=assignedDocuments.some((document)=>document.has_private&&document.private_student_names?.length);
  const hasIelts=assignedDocuments.some((document)=>document.has_ielts&&document.ielts_student_names?.length);
  const applicable=[...levels,...(hasPrivate?["Private"]:[]),...(hasIelts?["IELTS"]:[])];
  const applicableText=naturalList(applicable);
  const date=formattedSpeakingDate(bundle.cycle_date);
  const subject=`JEA speaking materials — ${date} — ${applicableText}`;
  const greeting=teacherGreeting(bundle.recipient_name);
  const intro=[
    greeting,
    `Your speaking-practice materials for ${date} are ready. This email brings together all the documents assigned to you: ${applicableText}.`,
    "The students are organised by level and then alphabetically by their full names.",
    "Before each conversation, open the relevant document and find the student’s name. Read the topic first, then use the teacher questions as flexible prompts. You may rephrase the questions, change their order or ask other relevant questions. You do not need to ask every question or follow the document mechanically; the goal is to help the conversation develop naturally.",
    "When you want to send a topic to a student, use the green WhatsApp button beneath that topic and make sure it bears the correct student’s name. The WhatsApp message contains only the learner-facing topic; the teacher questions remain private."
  ];
  const htmlSections=[];const textSections=[];
  for(const level of levels){
    const parts=groupDocuments.filter((document)=>document.level===level).sort((a,b)=>a.part_number-b.part_number);
    const htmlParts=parts.map((document)=>{const documentLabel=document.total_parts>1?`Document ${document.part_number} of ${document.total_parts}`:"Document";const coverage=document.coverage_start===document.coverage_end?document.coverage_start:`${document.coverage_start} — ${document.coverage_end}`;return `<div style="border:1px solid #d1d5db;border-radius:10px;padding:14px;margin:12px 0"><p><strong>Level:</strong> ${escapeHtml(level)}<br><strong>${escapeHtml(documentLabel)}</strong><br><strong>Students:</strong> ${Number(document.student_count||0)}<br><strong>Alphabetical coverage:</strong> ${escapeHtml(coverage)}</p>${teacherButton(document.pdf_drive_url,teacherDocumentButtonLabel(document))}<p><strong>Filename:</strong> ${escapeHtml(document.pdf_filename)}</p></div>`;}).join("");
    const textParts=parts.map((document)=>{const documentLabel=document.total_parts>1?`Document ${document.part_number} of ${document.total_parts}`:"Document";const coverage=document.coverage_start===document.coverage_end?document.coverage_start:`${document.coverage_start} — ${document.coverage_end}`;return [`Level: ${level}`,documentLabel,`Students: ${Number(document.student_count||0)}`,`Alphabetical coverage: ${coverage}`,`${teacherDocumentButtonLabel(document)}: ${document.pdf_drive_url}`,`Filename: ${document.pdf_filename}`].join("\n");}).join("\n\n");
    htmlSections.push(`<section><h2 style="font-size:18px;margin-top:28px">GROUP STUDENTS — ${level}</h2>${htmlParts}</section>`);textSections.push(`GROUP STUDENTS — ${level}\n\n${textParts}`);
  }
  if(hasPrivate){
    const document=assignedDocuments.find((item)=>item.has_private);const names=document.private_student_names||[];
    htmlSections.push(`<section><h2 style="font-size:18px;margin-top:28px">PRIVATE STUDENTS</h2><p>${escapeHtml(names.join(", "))}</p>${teacherButton(document.pdf_drive_url,teacherDocumentButtonLabel(document,"PRIVATE"))}<p><strong>Filename:</strong> ${escapeHtml(document.pdf_filename)}</p></section>`);
    textSections.push(`PRIVATE STUDENTS\n\n${names.join(", ")}\n\n${teacherDocumentButtonLabel(document,"PRIVATE")}: ${document.pdf_drive_url}\nFilename: ${document.pdf_filename}`);
  }
  if(hasIelts){
    const document=assignedDocuments.find((item)=>item.has_ielts);const names=document.ielts_student_names||[];
    htmlSections.push(`<section><h2 style="font-size:18px;margin-top:28px">IELTS STUDENTS</h2><p>${escapeHtml(names.join(", "))}</p>${teacherButton(document.pdf_drive_url,teacherDocumentButtonLabel(document,"IELTS"))}<p><strong>Filename:</strong> ${escapeHtml(document.pdf_filename)}</p></section>`);
    textSections.push(`IELTS STUDENTS\n\n${names.join(", ")}\n\n${teacherDocumentButtonLabel(document,"IELTS")}: ${document.pdf_drive_url}\nFilename: ${document.pdf_filename}`);
  }
  const closing="These documents are intended for teachers. Please do not forward the PDFs or the teacher questions to students. Use the individual WhatsApp buttons whenever you need to send learner-facing content.";
  const html=shell({title:subject,preheader:subject,content:`<h1 style="font-size:22px">JEA speaking materials</h1>${intro.map((paragraph)=>`<p>${escapeHtml(paragraph)}</p>`).join("")}${htmlSections.join("")}<p style="margin-top:28px">${escapeHtml(closing)}</p><p><strong>The John’s English Academy Team</strong></p>`});
  const text=[...intro,...textSections,closing,"The John’s English Academy Team"].join("\n\n");
  return{subject,html,text};
}

export function renderSpeakingQueueEmail(sourceType,source,config){
  if(sourceType==="SPEAKING_GROUP_TOPICS")return renderGroupTopicsEmail(source);
  if(sourceType==="SPEAKING_PROFILE_REMINDER")return renderProfileReminderEmail(source,{formUrl:config.profileFormUrl});
  if(sourceType==="SPEAKING_TEACHER_MATERIALS")return renderTeacherMaterialEmail(source);
  throw new Error(`Unsupported speaking email source type: ${sourceType}`);
}
