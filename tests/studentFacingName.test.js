import test from "node:test";
import assert from "node:assert/strict";
import { renderEncouragementEmail } from "../src/encouragementEmailTemplate.js";
import { studentFacingName } from "../src/studentFacingName.js";
import {
  reminderWhatsAppMessage,
  renderGroupTopicsEmail,
  renderProfileReminderEmail
} from "../src/speaking/emailRenderer.js";
import { buildDigestStudentRequest } from "../src/teacherDigest/deepseekPayload.js";

test("student-facing names use up to two given names from surname-first records", () => {
  assert.equal(studentFacingName("MATENE Emsy Pascale"), "Emsy Pascale");
  assert.equal(studentFacingName("ZOBO NGONO Jean Christophe"), "Jean Christophe");
  assert.equal(studentFacingName("MATENE Emsy"), "Emsy");
  assert.equal(studentFacingName("Emsy"), "Emsy");
  assert.equal(studentFacingName("pascalematene@gmail.com", "there"), "there");
});

test("early-A1 speaking email uses the approved preparation wording and two given names", () => {
  const rendered = renderGroupTopicsEmail({
    student_name: "MATENE Emsy Pascale",
    topic_response_url: "https://example.test/topics?token=early-a1",
    curriculum_snapshot: { level: "A1", module: 3 },
    topics: [
      {
        title: "Votre quartier",
        learner_content: {
          body: "Parlez de votre quartier.",
          points: ["Décrivez un lieu que vous aimez."]
        }
      }
    ]
  });

  assert.match(rendered.text, /^Bonjour Emsy Pascale,/);
  assert.match(rendered.text, /Pendant la séance, vous devrez parler en anglais\./);
  assert.match(rendered.text, /choisissez un ou deux sujets/);
  assert.match(rendered.text, /n’écrivez pas de réponses complètes ni tout ce que vous prévoyez de dire/);
  assert.match(rendered.text, /parler naturellement en anglais, et non à lire un texte préparé/);
  assert.doesNotMatch(rendered.text, /MATENE/);
});

test("later speaking email uses the approved English preparation wording", () => {
  const rendered = renderGroupTopicsEmail({
    student_name: "MATENE Emsy Pascale",
    topic_response_url: "https://example.test/topics?token=later-a1",
    curriculum_snapshot: { level: "A1", module: 4 },
    topics: [
      {
        title: "A useful change",
        learner_content: {
          body: "Talk about a useful change.",
          points: ["Explain why it helped you."]
        }
      }
    ]
  });

  assert.match(rendered.text, /^Hello Emsy Pascale,/);
  assert.match(rendered.text, /choose one or two topics/);
  assert.match(rendered.text, /do not write complete answers or everything you plan to say/);
  assert.match(rendered.text, /speak naturally, not read a prepared text/);
  assert.doesNotMatch(rendered.text, /MATENE/);
});

test("speaking profile reminders use two given names in email and WhatsApp copy", () => {
  const target = {
    student_name: "MATENE Emsy Pascale",
    curriculum_snapshot: { level: "A1", module: 2 }
  };
  const email = renderProfileReminderEmail(target, { formUrl: "https://example.test/profile" });
  const whatsapp = reminderWhatsAppMessage({
    studentName: target.student_name,
    formUrl: "https://example.test/profile",
    curriculum: target.curriculum_snapshot
  });

  assert.match(email.text, /^Bonjour Emsy Pascale,/);
  assert.match(whatsapp, /^Bonjour Emsy Pascale,/);
  assert.doesNotMatch(`${email.text}\n${whatsapp}`, /MATENE/);
});

test("student encouragement copy uses two given names while teacher copy keeps its existing format", () => {
  const common = {
    messageType: "WEEKLY_ACTIVE_STUDENT_ENCOURAGEMENT",
    sourceType: "WEEKLY_ACTIVE_STUDENT_ENCOURAGEMENT",
    message: {
      subject: "Continuez, {{student_name}}",
      body_text: "Bonjour {{student_name}},\n\nContinuez vos efforts.",
      audience_type: "STUDENT"
    },
    recipient: {
      recipient_name: "MATENE Emsy Pascale",
      recipient_email: "student@example.test",
      audience_type: "STUDENT"
    }
  };
  const student = renderEncouragementEmail(common);
  const teacher = renderEncouragementEmail({
    ...common,
    message: {
      subject: "Hello {{teacher_name}}",
      body_text: "Hello {{teacher_name}},\n\nTeacher update.",
      audience_type: "TEACHER"
    },
    recipient: {
      recipient_name: "Zobo Ngono Jean Christophe",
      recipient_email: "teacher@example.test",
      audience_type: "TEACHER"
    }
  });

  assert.match(student.subject, /Emsy Pascale/);
  assert.match(student.body_text, /Emsy Pascale/);
  assert.doesNotMatch(`${student.subject}\n${student.body_text}`, /MATENE/);
  assert.match(teacher.subject, /Zobo Ngono/);
});

test("DeepSeek digest requests use the student's two student-facing given names", () => {
  const request = buildDigestStudentRequest({
    requestId: "request-1",
    student: {
      student_id: "00000000-0000-4000-8000-000000000001",
      student_name: "MATENE Emsy Pascale",
      level: "A1",
      current_module: 3
    },
    cycle_date: "2026-09-09",
    window: { cycle_date: "2026-09-09", cycle_day: "WEDNESDAY" },
    facts: { has_ever_submitted: false }
  });

  assert.equal(request.student_name_for_message, "Emsy Pascale");
  assert.equal(request.language, "fr");
  assert.doesNotMatch(request.student_name_for_message, /MATENE/);
});
