import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildReviewResponseBody } from "../src/review/reviewPrompt.js";
import {
  buildSpeakingDraftQueuePrioritySql,
  buildWritingCorrectionPayload,
  buildWritingCorrectionSystemPrompt,
  processSpeakingCorrectionOne
} from "../src/supabase/correctionRepository.js";
import {
  assembleFinalFeedback,
  findDeliveredWritingCorrection
} from "../src/supabase/finalFeedbackRepository.js";
import {
  markQueuedEmailFailed,
  markQueuedEmailSent
} from "../src/supabase/emailQueueRepository.js";
import {
  addCalendarDays,
  calculateWeeklyMetric,
  completedWeekForSunday,
  groupFeedbackDeliveries,
  hasThreeCompleteInactiveDays,
  isLastSundayOfMonth,
  isQuizOnlyFollowUp,
  normaliseQuizPercentage
} from "../src/teacherDigest/personalisation.js";
import {
  buildTeacherDigestEvidence
} from "../src/supabase/teacherDigestPersonalisationRepository.js";
import { applyTeacherDigestCatchUpWindow, buildTeacherDigestWindow } from "../src/cycleWindows.js";
import {
  runTeacherDigestStage,
  teacherDigestWindowDiagnosticContext
} from "../src/teacherDigest/diagnosticStage.js";
import {
  createMonthlyPaymentControlRuns,
  deactivateStudentFromMonthlyPaymentControl
} from "../src/supabase/adminPaymentControlRepository.js";
import { getBuildInfo } from "../src/buildInfo.js";
import { sendBrevoTransactionalEmail } from "../src/brevoClient.js";
import { sendMonthlyPaymentControlEmails } from "../src/services/adminPaymentControlService.js";
import { registerAdminPaymentControlRoutes } from "../src/routes/adminPaymentControlRoutes.js";
import { registerFinalFeedbackRoutes } from "../src/routes/finalFeedbackRoutes.js";
import { registerTeacherDigestRoutes } from "../src/routes/teacherDigestRoutes.js";
import { buildSpeakingCorrectionChatCompletionBody } from "../src/clients/openaiAudio.js";
import {
  classifySpeakPipeLink,
  normaliseSpeakPipeLink
} from "../src/submissionPolicy.js";

const STUDENT_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNMENT_KEY = "B1_M3_U4_D2_ASSIGNMENT";

test("SpeakPipe links are recognised consistently and canonicalised to HTTPS", () => {
  const messageId = "9t8xklgg9944bprc";
  const canonical = `https://www.speakpipe.com/voice-recorder/msg/${messageId}`;
  const accepted = [
    canonical,
    `http://www.speakpipe.com/voice-recorder/msg/${messageId}`,
    `www.speakpipe.com/voice-recorder/msg/${messageId}`,
    `speakpipe.com/voice-recorder/msg/${messageId}`,
    `//www.speakpipe.com/voice-recorder/msg/${messageId}`,
    `  https://speakpipe.com/voice-recorder/msg/${messageId}/?utm_source=form#recording  `
  ];

  for (const link of accepted) {
    const result = classifySpeakPipeLink(link);
    assert.equal(result.valid, true, link);
    assert.equal(result.normalized_url, canonical, link);
    assert.equal(normaliseSpeakPipeLink(link), canonical, link);
  }

  const shareLink = "speakpipe.com/msg/s/123/456/AbC_789-x";
  assert.deepEqual(classifySpeakPipeLink(shareLink), {
    valid: true,
    issue_code: "",
    issue_message: "",
    normalized_url: "https://www.speakpipe.com/msg/s/123/456/AbC_789-x"
  });

  for (const link of [
    "https://example.com/voice-recorder/msg/9t8xklgg9944bprc",
    "https://speakpipe.com.evil.example/voice-recorder/msg/9t8xklgg9944bprc",
    "https://www.speakpipe.com/voice-recorder/msg/",
    "ftp://www.speakpipe.com/voice-recorder/msg/9t8xklgg9944bprc"
  ]) {
    assert.equal(classifySpeakPipeLink(link).valid, false, link);
  }
});

test("first correction and reviewer prompts enforce the same writing and speaking overproduction limits", () => {
  const firstPrompt = buildWritingCorrectionSystemPrompt({ feedbackLanguage: "en" });
  assert.match(firstPrompt, /deduct no more than 2 points out of 20/i);
  assert.match(firstPrompt, /Task Achievement must remain at least 18\/20/i);
  assert.match(firstPrompt, /Do not deduct points from Grammar, Vocabulary, Organisation and coherence/i);

  const reviewer = buildReviewResponseBody({
    model: "mock-review-model",
    draft: {
      id: "draft-1",
      job_type: "WRITING_CORRECTION",
      student_id: STUDENT_ID,
      assignment_key: ASSIGNMENT_KEY,
      level: "B1",
      writing_answer: "A valid answer with a little extra relevant detail."
    }
  }).input[0].content;

  assert.match(reviewer, /deduct no more than 2 points out of 20/i);
  assert.match(reviewer, /Task achievement must therefore remain at least 18\/20/i);
  assert.match(reviewer, /Do not deduct any points from Grammar, Vocabulary, Complete sentences and organisation/i);

  const speakingBody = buildSpeakingCorrectionChatCompletionBody({
    audioBuffer: Buffer.from("mock-audio"),
    transcriptText: "I completed the speaking task and added one relevant detail.",
    speakingPrompt: "Answer the speaking task.",
    studentName: "Awa",
    studentLevel: "A2",
    moduleNumber: "1",
    unitNumber: "1",
    dayNumber: "1",
    model: "openai/mock-audio-model"
  });
  const speakingPrompt = speakingBody.messages[1].content[0].text;

  assert.match(speakingPrompt, /deduct no more than 2 points out of 20, strictly from Task Achievement/i);
  assert.match(speakingPrompt, /Task Achievement must remain at least 18\/20/i);
  assert.match(speakingPrompt, /Do not deduct points from Grammar and vocabulary, Pronunciation, Fluency, or Organisation and clarity/i);

  assert.match(reviewer, /Strict overproduction rule for SPEAKING_ONLY/i);
  assert.match(reviewer, /core speaking task[\s\S]*deduct no more than 2 points out of 20/i);
  assert.match(reviewer, /first speaking correction violates this maximum deduction[\s\S]*return FIXED or REGENERATED/i);
});

test("lossless token optimisation removes unused teacher output and duplicate review feedback", () => {
  const writingPrompt = buildWritingCorrectionSystemPrompt({ feedbackLanguage: "en" });
  assert.doesNotMatch(writingPrompt, /student_draft_feedback/);
  assert.doesNotMatch(writingPrompt, /teacher_draft_feedback/);
  assert.doesNotMatch(writingPrompt, /teacher_email_body/);
  assert.match(writingPrompt, /formatted_feedback must contain the full student-facing correction/i);

  const writingPayload = buildWritingCorrectionPayload({
    grammar_lesson_key: "A2_M2_U1_D3",
    current_lesson_grammar: "Present perfect for life experience",
    previous_grammar_summary: "Past simple | Present simple",
    previous_grammar: [
      { lesson_key: "A2_M2_U1_D2", grammar: "Past simple" },
      { lesson_key: "A2_M2_U1_D1", grammar: "Present simple" }
    ],
    previous_grammar_count: 42
  });
  assert.deepEqual(writingPayload.grammar_context, {
    lesson_key: "A2_M2_U1_D3",
    current_lesson_grammar: "Present perfect for life experience",
    previous_grammar_summary: "Past simple | Present simple",
    previous_grammar_count: 42
  });
  assert.equal("previous_grammar" in writingPayload.grammar_context, false);

  const speakingBody = buildSpeakingCorrectionChatCompletionBody({
    audioBuffer: Buffer.from("mock-audio"),
    transcriptText: "I completed the speaking task.",
    speakingPrompt: "Complete the speaking task.",
    studentName: "Awa",
    studentLevel: "A2",
    moduleNumber: "1",
    unitNumber: "1",
    dayNumber: "1",
    model: "openai/mock-audio-model"
  });
  const speakingPrompt = speakingBody.messages[1].content[0].text;
  assert.doesNotMatch(speakingPrompt, /teacher_draft_feedback/);
  assert.doesNotMatch(speakingPrompt, /teacher_email_body/);
  assert.match(speakingPrompt, /teacher_email_subject/);

  const uniqueFeedback = "UNIQUE_FIRST_CORRECTION_MARKER";
  const reviewBody = buildReviewResponseBody({
    model: "mock-review-model",
    draft: {
      id: "draft-token-test",
      job_type: "WRITING_CORRECTION",
      student_id: STUDENT_ID,
      assignment_key: ASSIGNMENT_KEY,
      level: "B1",
      writing_answer: "A complete learner answer.",
      student_draft_feedback: uniqueFeedback,
      teacher_draft_feedback: "UNUSED_TEACHER_FEEDBACK"
    }
  });
  const reviewPayloadText = reviewBody.input[1].content;
  const reviewPayload = JSON.parse(reviewPayloadText);
  assert.equal(reviewPayload.current_draft.first_feedback_markdown, uniqueFeedback);
  assert.equal(reviewPayload.writing.first_feedback_markdown, undefined);
  assert.equal(reviewPayload.current_draft.teacher_feedback, undefined);
  assert.equal(reviewPayloadText.split(uniqueFeedback).length - 1, 1);
  assert.doesNotMatch(reviewPayloadText, /UNUSED_TEACHER_FEEDBACK/);
  assert.doesNotMatch(reviewPayloadText, /\n\s+/);
});

test("delivered-writing lookup uses the exact student and assignment pair", async () => {
  const calls = [];
  const row = { id: "feedback-1", delivery_status: "EMAIL_SENT" };
  const result = await findDeliveredWritingCorrection(
    { studentId: STUDENT_ID, assignmentKey: ASSIGNMENT_KEY },
    {
      withSupabaseClient: async (callback) => callback({
        query: async (sql, params) => {
          calls.push({ sql, params });
          return { rows: [row] };
        }
      })
    }
  );
  assert.equal(result, row);
  assert.deepEqual(calls[0].params, [STUDENT_ID, ASSIGNMENT_KEY]);
  assert.match(calls[0].sql, /writing_draft_id is not null/i);
  assert.match(calls[0].sql, /EMAIL_SENT[\s\S]*SENT/i);
});

test("active speaking processor performs a final database guard before any paid API call", async () => {
  let guardCalls = 0;
  let releaseCalls = 0;
  const draft = {
    id: "draft-1",
    status: "TRANSCRIBED",
    submission_id: "submission-1",
    student_id: STUDENT_ID,
    assignment_key: ASSIGNMENT_KEY
  };

  const result = await processSpeakingCorrectionOne({
    dependencies: {
      claimSpeakingDraft: async () => draft,
      findDeliveredWritingCorrection: async ({ studentId, assignmentKey }) => {
        guardCalls += 1;
        assert.equal(studentId, STUDENT_ID);
        assert.equal(assignmentKey, ASSIGNMENT_KEY);
        return { id: "feedback-1", delivery_status: "EMAIL_SENT" };
      },
      releaseSpeakingDraftAfterDeliveredWriting: async (released) => {
        releaseCalls += 1;
        assert.equal(released, draft);
      }
    }
  });

  assert.equal(result.status, "SPEAKING_API_SKIPPED_WRITING_ALREADY_DELIVERED");
  assert.equal(result.skip_reason, "WRITING_FEEDBACK_ALREADY_DELIVERED");
  assert.equal(guardCalls, 1);
  assert.equal(releaseCalls, 1);
});

test("fresh stored-audio speaking work is claimed before retryable failures", () => {
  const prioritySql = buildSpeakingDraftQueuePrioritySql();

  assert.match(prioritySql, /^case when upper\(d\.status\) in \(/i);
  assert.match(prioritySql, /TRANSCRIPTION_FAILED_RETRYABLE/);
  assert.match(prioritySql, /CORRECTION_FAILED_RETRYABLE/);
  assert.match(prioritySql, /FAILED_RETRYABLE/);
  assert.match(prioritySql, /then 1 else 0 end$/i);
  assert.doesNotMatch(prioritySql, /WAITING_FOR_AUDIO_STORAGE/);
  assert.doesNotMatch(prioritySql, /QUEUED/);
  assert.doesNotMatch(prioritySql, /TRANSCRIBED/);
});

test("Sunday 30 uses Sunday 23 through Saturday 29", () => {
  assert.deepEqual(completedWeekForSunday("2026-08-30"), {
    week_start: "2026-08-23",
    week_end: "2026-08-29"
  });
  assert.equal(isLastSundayOfMonth("2026-08-30"), true);
  assert.equal(isLastSundayOfMonth("2026-08-23"), false);
});

test("a missed Wednesday digest is recovered by Friday without changing the Sunday weekly window", () => {
  const friday = buildTeacherDigestWindow({ cycleDate: "2026-09-04" });
  const recovered = applyTeacherDigestCatchUpWindow(friday, {
    previousActivityEnd: "2026-08-30T00:00:00+01:00",
    previousDigestSentAt: "2026-08-30T05:10:00+01:00",
    snapshotAt: "2026-09-04T04:00:00+01:00"
  });
  assert.equal(recovered.activity_window_start, "2026-08-29T23:00:00.000Z");
  assert.equal(recovered.activity_window_end_exclusive, "2026-09-03T23:00:00.000Z");
  assert.equal(recovered.feedback_window_start, "2026-08-30T04:10:00.000Z");
  assert.equal(recovered.feedback_window_end_exclusive, "2026-09-04T03:00:00.000Z");
  assert.equal(recovered.catch_up_applied, true);
  assert.deepEqual(recovered.included_dates, ["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepEqual(completedWeekForSunday("2026-09-06"), { week_start: "2026-08-30", week_end: "2026-09-05" });
});

test("the repaired 2 September checkpoint makes the fresh 4 September digest cover only Wednesday and Thursday", () => {
  const friday = buildTeacherDigestWindow({ cycleDate: "2026-09-04" });
  const repaired = applyTeacherDigestCatchUpWindow(friday, {
    previousActivityEnd: "2026-09-01T23:00:00.000Z",
    previousDigestSentAt: "2026-09-02T05:00:04.030Z",
    snapshotAt: "2026-09-04T05:00:00.000Z"
  });

  assert.equal(repaired.activity_window_start, "2026-09-01T23:00:00.000Z");
  assert.equal(repaired.activity_window_end_exclusive, "2026-09-03T23:00:00.000Z");
  assert.deepEqual(repaired.included_dates, ["2026-09-02", "2026-09-03"]);
  assert.equal(repaired.catch_up_applied, false);
});

test("teacher digest catch-up accepts Supabase timestamptz values returned as JavaScript Date objects", () => {
  const sunday = buildTeacherDigestWindow({ cycleDate: "2026-08-30" });
  const recovered = applyTeacherDigestCatchUpWindow(sunday, {
    previousActivityEnd: new Date("2026-08-28T00:00:00+01:00"),
    previousDigestSentAt: new Date("2026-08-28T05:10:00+01:00"),
    snapshotAt: new Date("2026-08-30T20:23:29+01:00")
  });

  assert.equal(recovered.activity_window_start, "2026-08-27T23:00:00.000Z");
  assert.equal(recovered.activity_window_end_exclusive, "2026-08-29T23:00:00.000Z");
  assert.equal(recovered.feedback_window_start, "2026-08-28T04:10:00.000Z");
  assert.equal(recovered.feedback_window_end_exclusive, "2026-08-30T19:23:29.000Z");
  assert.equal(recovered.catch_up_applied, false);
  assert.deepEqual(recovered.included_dates, ["2026-08-28", "2026-08-29"]);
  assert.doesNotMatch(recovered.activity_window_start, /West Africa Time|GMT\+0100/);

  assert.throws(
    () => applyTeacherDigestCatchUpWindow(sunday, { previousActivityEnd: new Date(Number.NaN) }),
    /Invalid previous activity-window end timestamp/
  );
});

test("teacher digest catch-up repairs a legacy browser-formatted checkpoint before SQL reuse", () => {
  const sunday = buildTeacherDigestWindow({ cycleDate: "2026-08-30" });
  const recovered = applyTeacherDigestCatchUpWindow(sunday, {
    previousActivityEnd: new Date("2026-08-28T00:00:00+01:00"),
    previousDigestSentAt: "Fri Aug 28 2026 00:00:00 GMT+0100 (West Africa Time)",
    snapshotAt: "2026-08-30T20:44:08+01:00"
  });

  assert.equal(recovered.feedback_window_start, "2026-08-27T23:00:00.000Z");
  assert.equal(recovered.feedback_window_end_exclusive, "2026-08-30T19:44:08.000Z");
  assert.doesNotMatch(JSON.stringify(recovered), /West Africa Time|GMT\+0100/);
});

test("Sunday digest timestamps stay SQL-safe with missing, null and ISO checkpoints", () => {
  const sunday = buildTeacherDigestWindow({ cycleDate: "2026-08-30" });
  const cases = [
    {},
    { previousActivityEnd: null, previousDigestSentAt: null },
    {
      previousActivityEnd: "2026-08-28T00:00:00+01:00",
      previousDigestSentAt: "2026-08-28T05:10:00+01:00"
    }
  ];

  for (const checkpoints of cases) {
    const recovered = applyTeacherDigestCatchUpWindow(sunday, {
      ...checkpoints,
      snapshotAt: "2026-08-30T20:40:10.371Z"
    });
    for (const value of [
      recovered.activity_window_start,
      recovered.activity_window_end_exclusive,
      recovered.feedback_window_start,
      recovered.feedback_window_end_exclusive
    ]) {
      assert.equal(Number.isNaN(Date.parse(value)), false, value);
      assert.doesNotMatch(value, /West Africa Time|GMT\+0100/);
    }
  }
});

test("teacher digest diagnostics identify the exact failing stage without changing successful operations", async () => {
  const successful = await runTeacherDigestStage("load-success", async () => ({ ok: true }));
  assert.deepEqual(successful, { ok: true });

  const databaseError = Object.assign(
    new Error('invalid input syntax for type timestamp with time zone: "Fri Aug 28 2026 00:00:00 GMT+0100 (West Africa Time)"'),
    { code: "22007" }
  );
  await assert.rejects(
    () => runTeacherDigestStage(
      "load unseen feedback",
      async () => { throw databaseError; },
      teacherDigestWindowDiagnosticContext({
        cycle_date: "2026-08-30",
        activity_window_start: "2026-08-27T23:00:00.000Z",
        activity_window_end_exclusive: "2026-08-29T23:00:00.000Z",
        feedback_window_start: "Fri Aug 28 2026 00:00:00 GMT+0100 (West Africa Time)",
        feedback_window_end_exclusive: "2026-08-30T20:05:51.621Z"
      })
    ),
    (error) => {
      assert.equal(error.code, "22007");
      assert.match(error.message, /^TEACHER_DIGEST_STAGE=LOAD_UNSEEN_FEEDBACK;/);
      assert.match(error.message, /"feedback_window_start":"Fri Aug 28 2026/);
      assert.equal(error.cause, databaseError);
      return true;
    }
  );

  const alreadyLabelled = new Error("TEACHER_DIGEST_STAGE=INNER_QUERY; ERROR=original");
  await assert.rejects(
    () => runTeacherDigestStage("outer query", async () => { throw alreadyLabelled; }),
    (error) => error === alreadyLabelled
  );
});

test("assignments delivered in one feedback PDF are grouped as one delivery", () => {
  const deliveries = groupFeedbackDeliveries([
    {
      id: "feedback-1",
      email_queue_id: "email-1",
      delivery_key: "email-1",
      assignment_key: "A2_M1_U1_D3_ASSIGNMENT",
      writing_score: 84,
      speaking_score: 78,
      feedback_link: "https://example.test/combined.pdf",
      delivery_sent_at: "2026-08-30T03:00:00Z"
    },
    {
      id: "feedback-2",
      email_queue_id: "email-1",
      delivery_key: "email-1",
      assignment_key: "A2_M1_U1_D4_ASSIGNMENT",
      writing_score: 88,
      speaking_score: 81,
      feedback_link: "https://example.test/combined.pdf",
      delivery_sent_at: "2026-08-30T03:00:00Z"
    }
  ]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].assignment_count, 2);
  assert.deepEqual(deliveries[0].assignment_keys, ["A2_M1_U1_D3_ASSIGNMENT", "A2_M1_U1_D4_ASSIGNMENT"]);
  assert.match(deliveries[0].scores_display, /writing 84\/100, speaking 78\/100/);
  assert.match(deliveries[0].scores_display, /writing 88\/100, speaking 81\/100/);
});

test("quiz percentages support percentage, score/max and old 0-100 score rows", () => {
  assert.equal(normaliseQuizPercentage({ percentage: 82, score: 1, max_score: 2 }), 82);
  assert.equal(normaliseQuizPercentage({ score: 7, max_score: 10 }), 70);
  assert.equal(normaliseQuizPercentage({ score: 64, max_score: null }), 64);
  assert.equal(normaliseQuizPercentage({ score: 120, max_score: null }), null);
});

test("weekly metric counts actual working days and never converts missing work to zero", () => {
  const metric = calculateWeeklyMetric({
    student: {
      student_id: STUDENT_ID,
      enrollment_id: "22222222-2222-4222-8222-222222222222",
      teacher_id: "33333333-3333-4333-8333-333333333333",
      start_date: "2026-08-01"
    },
    weekStart: "2026-08-23",
    submissions: [
      { id: "s1", assignment_key: "A1", answer_text: "Answer", speakpipe_link: "https://www.speakpipe.com/voice-recorder/msg-1", submitted_at: "2026-08-23T09:00:00Z" },
      { id: "s2", assignment_key: "A2", writing_answer: "Answer", audio_link: "", submitted_at: "2026-08-26T09:00:00Z" }
    ],
    quizzes: [
      { id: "q1", quiz_key: "Q1", score: 80, submitted_at: "2026-08-26T10:00:00Z" },
      { id: "q2", quiz_key: "Q2", score: 90, submitted_at: "2026-08-28T10:00:00Z" }
    ],
    feedback: [
      { assignment_key: "A1", writing_status: "REVIEWED", writing_score: 60, speaking_status: "REVIEWED", speaking_score: 80 },
      { assignment_key: "A2", writing_status: "REVIEWED", writing_score: 80, speaking_status: "NOT_ASSESSED", speaking_score: null }
    ]
  });

  assert.equal(metric.active_days, 3);
  assert.deepEqual(metric.activity_dates, ["2026-08-23", "2026-08-26", "2026-08-28"]);
  assert.equal(metric.quiz_average, 85);
  assert.equal(metric.writing_average, 70);
  assert.equal(metric.speaking_average, 80);
  assert.equal(metric.speaking_assessed_count, 1);
  assert.equal(metric.speaking_pending_count, 0);
  assert.equal(metric.last_writing_at, "2026-08-26T09:00:00Z");
  assert.equal(metric.last_speaking_at, "2026-08-23T09:00:00Z");
});

test("a delayed speaking result is pending and is excluded from the average", () => {
  const metric = calculateWeeklyMetric({
    student: { student_id: STUDENT_ID, start_date: "2026-01-01" },
    weekStart: "2026-08-23",
    submissions: [{ assignment_key: "A1", audio_link: "audio", submitted_at: "2026-08-24T10:00:00Z" }],
    feedback: [{
      assignment_key: "A1",
      speaking_status: "NOT_ASSESSED",
      speaking_score: null,
      speaking_problem_code: "SPEAKING_PROCESSING_DELAYED"
    }]
  });
  assert.equal(metric.speaking_average, null);
  assert.equal(metric.speaking_pending_count, 1);
  assert.equal(metric.speaking_not_assessed_count, 0);
});

test("no-submission eligibility requires three complete preceding inactive days", () => {
  assert.equal(hasThreeCompleteInactiveDays({ cycleDate: "2026-08-29", lastActivityAt: "2026-08-25", enrollmentStart: "2026-01-01" }), true);
  assert.equal(hasThreeCompleteInactiveDays({ cycleDate: "2026-08-29", lastActivityAt: "2026-08-26", enrollmentStart: "2026-01-01" }), false);
  assert.equal(hasThreeCompleteInactiveDays({ cycleDate: "2026-08-29", lastActivityAt: null, enrollmentStart: "2026-08-27" }), false);
});

test("quiz-only follow-up checks the preceding seven complete days", () => {
  const quizzes = [{ submitted_at: "2026-08-27T08:00:00Z" }];
  assert.equal(isQuizOnlyFollowUp({ cycleDate: "2026-08-29", quizzes, submissions: [] }), true);
  assert.equal(isQuizOnlyFollowUp({
    cycleDate: "2026-08-29",
    quizzes,
    submissions: [{ answer_text: "done", submitted_at: "2026-08-24T08:00:00Z" }]
  }), false);
  assert.equal(isQuizOnlyFollowUp({
    cycleDate: "2026-08-29",
    quizzes,
    submissions: [{ speakpipe_link: "https://www.speakpipe.com/voice-recorder/msg-2", submitted_at: "2026-08-24T08:00:00Z" }]
  }), false);
});

test("digest repository uses resumable checkpoints, latest quiz attempts and concurrency locks", async () => {
  const repository = await readFile(new URL("../src/supabase/teacherDigestRepository.js", import.meta.url), "utf8");
  const personalisationRepository = await readFile(new URL("../src/supabase/teacherDigestPersonalisationRepository.js", import.meta.url), "utf8");
  const routes = await readFile(new URL("../src/routes/teacherDigestRoutes.js", import.meta.url), "utf8");
  assert.match(repository, /pg_try_advisory_lock\(hashtext\(\$1\)\)/i);
  assert.match(repository, /payload_json\s*->\s*'window'\s*->>\s*'snapshot_at'/i);
  assert.doesNotMatch(repository, /snapshot_at'[\s\S]{0,80}::timestamptz/i);
  assert.match(repository, /last\.feedback_checkpoint_at\s*\|\|\s*last\.activity_window_end_exclusive/i);
  assert.match(personalisationRepository, /partition by quiz\.student_id, quiz\.quiz_key[\s\S]*order by quiz\.submitted_at desc/i);
  assert.match(personalisationRepository, /\(display_rank = 1\) as is_displayed/i);
  assert.match(personalisationRepository, /quiz_items_to_include/i);
  assert.match(personalisationRepository, /writing_answer, answer_text/i);
  assert.match(personalisationRepository, /audio_link, speakpipe_link/i);
  assert.match(personalisationRepository, /is_last_sunday_of_month:\s*isLastSundayOfMonth\(window\.cycle_date\)/i);
  assert.match(repository, /persistWeeklyMetrics:\s*false/i);
  assert.match(repository, /when email_queue\.status = 'FAILED' then 'QUEUED'/i);
  assert.match(repository, /attempt_count = case when email_queue\.status = 'FAILED' then 0/i);
  assert.match(repository, /email queue row[\s\S]*is not deliverable/i);
  assert.match(repository, /regenerateAfterTerminalEmailFailure[\s\S]*recoverySnapshot/i);
  assert.match(repository, /if \(!regenerateAfterTerminalEmailFailure\)[\s\S]*from teacher_digest_pdf_jobs/i);
  assert.match(repository, /pdfs_regenerated_after_terminal_email_failure/i);
  assert.match(personalisationRepository, /persistWeeklyMetrics[\s\S]*UPSERT_WEEKLY_METRIC[\s\S]*upsertWeeklyMetric_\(client, metric\)[\s\S]*:\s*metric/i);
  assert.doesNotMatch(personalisationRepository, /Promise\.all\(\[[\s\S]*LOAD_MESSAGE_COMPONENTS[\s\S]*LOAD_UNSEEN_QUIZZES/i);
  assert.match(routes, /app\.get\("\/worker\/teacher-digest\/generate-one", generateOneHandler\)/i);
  assert.doesNotMatch(routes, /repair-preview|repair-reissue/i);
});

test("historical digest last activity is capped at the activity-window end", async () => {
  let lastActivitySql = "";
  let lastActivityParams = [];
  const client = {
    query: async (sql, params = []) => {
      const normal = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      if (normal.includes("with activity as")) {
        lastActivitySql = String(sql);
        lastActivityParams = params;
        return { rows: [{ student_id: STUDENT_ID, last_submission_at: "2026-08-25T10:00:00.000Z", last_assignment_at: "2026-08-25T10:00:00.000Z" }] };
      }
      if (normal.includes("select id, student_id, assignment_key, writing_answer")) return { rows: [] };
      if (normal.includes("select id, student_id, quiz_key, score")) return { rows: [] };
      if (normal.includes("from final_feedback ff")) return { rows: [] };
      if (normal.includes("from quiz_scores quiz")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${normal}`);
    }
  };
  const cutoff = "2026-08-29T23:00:00.000Z";

  await buildTeacherDigestEvidence(client, {
    students: [{
      student_id: STUDENT_ID,
      enrollment_id: "22222222-2222-4222-8222-222222222222",
      start_date: "2026-01-01",
      student_name: "Awa Test",
      level: "A1"
    }],
    teacher: { teacher_id: "33333333-3333-4333-8333-333333333333" },
    window: {
      cycle_date: "2026-08-30",
      cycle_day: "WEDNESDAY",
      activity_window_start: "2026-08-27T23:00:00.000Z",
      activity_window_end_exclusive: cutoff,
      feedback_window_start: "2026-08-27T23:00:00.000Z",
      feedback_window_end_exclusive: "2026-08-30T06:00:00.000Z"
    },
    options: { persistWeeklyMetrics: false }
  });

  assert.equal(lastActivityParams[1], cutoff);
  assert.equal((lastActivitySql.match(/submitted_at\s*<\s*\$2::timestamptz/g) || []).length, 2);
});

test("Brevo delivery removes duplicate recipient addresses across To, CC and BCC", async () => {
  const oldFetch = globalThis.fetch;
  const oldApiKey = process.env.BREVO_API_KEY;
  const oldSender = process.env.BREVO_SENDER_EMAIL;
  let requestBody = null;

  process.env.BREVO_API_KEY = "test-api-key";
  process.env.BREVO_SENDER_EMAIL = "sender@example.com";
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ messageId: "brevo-message-1" })
    };
  };

  try {
    await sendBrevoTransactionalEmail({
      toEmail: "teacher@example.com",
      toName: "Teacher",
      subject: "Teacher digest",
      htmlContent: "<p>Digest ready</p>",
      ccEmail: "teacher@example.com,observer@example.com,OBSERVER@example.com",
      bccEmail: "TEACHER@example.com,observer@example.com,archive@example.com,archive@example.com"
    });

    assert.deepEqual(requestBody.to, [{ email: "teacher@example.com", name: "Teacher" }]);
    assert.deepEqual(requestBody.cc, [{ email: "observer@example.com" }]);
    assert.deepEqual(requestBody.bcc, [{ email: "archive@example.com" }]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldApiKey === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = oldApiKey;
    if (oldSender === undefined) delete process.env.BREVO_SENDER_EMAIL; else process.env.BREVO_SENDER_EMAIL = oldSender;
  }
});

test("teacher digest browser routes remain registered for preview and generation", () => {
  const app = fakeApp_();
  registerTeacherDigestRoutes(app);

  for (const route of [
    "GET /worker/teacher-digest/payload-preview",
    "POST /worker/teacher-digest/payload-preview",
    "GET /worker/teacher-digest/generate-one",
    "POST /worker/teacher-digest/generate-one",
    "POST /worker/teacher-digest/generate"
  ]) {
    assert.equal(typeof app.handlers.get(route), "function", route);
  }
});

test("automatic inactivity email producers are retired while weekly encouragement remains", async () => {
  const scheduler = await readFile(new URL("../src/scheduler.js", import.meta.url), "utf8");
  const queueRepository = await readFile(new URL("../src/supabase/emailQueueRepository.js", import.meta.url), "utf8");
  const runner = await readFile(new URL("../scripts/run-encouragement-emails-once.js", import.meta.url), "utf8");

  assert.doesNotMatch(scheduler, /MONTHLY_INACTIVE_STUDENT_REACTIVATION|NO_SUBMISSION_REMINDER|WEEKLY_NO_ASSIGNMENT/);
  assert.doesNotMatch(runner, /monthly-inactive-students|queueMonthlyInactiveStudentReactivationEmails/);
  assert.match(queueRepository, /RETIRED_AUTOMATIC_REMINDER_SOURCE_TYPES[\s\S]*MONTHLY_INACTIVE_STUDENT_REACTIVATION/);
  assert.match(scheduler, /JEA Weekly Encouragement Queue/);
});

test("teacher digest provider acceptance commits before DeepSeek inclusion bookkeeping", async () => {
  const executed = [];
  const client = {
    query: async (sql) => {
      const normal = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      executed.push(normal);
      if (["begin", "commit"].includes(normal)) return { rows: [] };
      if (normal.startsWith("update email_queue")) return { rows: [{ id: "email-1", source_type: "TEACHER_PROGRESS_DIGEST" }] };
      if (normal.startsWith("select generated.id")) return { rows: [{ id: "run-1" }] };
      if (normal.startsWith("update teacher_digest_deepseek_messages")) return { rows: [] };
      if (normal.startsWith("select id from teacher_digest_deepseek_messages")) return { rows: [{ id: "message-1" }] };
      if (normal.includes("update teacher_digest_deepseek_evidence_items item")) {
        return {
          rows: [
            { id: "feedback-item-1", source_kind: "FINAL_FEEDBACK" },
            { id: "quiz-item-1", source_kind: "QUIZ_SCORE" }
          ]
        };
      }
      if (normal.startsWith("update teacher_digest_deepseek_runs")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${normal}`);
    }
  };
  const result = await markQueuedEmailSent(
    { emailId: "44444444-4444-4444-8444-444444444444", providerMessageId: "brevo-1" },
    { withSupabaseClient: async (callback) => callback(client) }
  );
  const queueUpdateIndex = executed.findIndex((sql) => sql.startsWith("update email_queue"));
  const firstCommitIndex = executed.indexOf("commit");
  const runLookupIndex = executed.findIndex((sql) => sql.startsWith("select generated.id"));

  assert.equal(result.post_send_finalization_status, "COMPLETED");
  assert.equal(result.post_send_finalization.teacher_digest_feedback_item_count, 1);
  assert.equal(result.post_send_finalization.teacher_digest_quiz_item_count, 1);
  assert.ok(queueUpdateIndex >= 0 && firstCommitIndex > queueUpdateIndex);
  assert.ok(runLookupIndex > firstCommitIndex);
  assert.ok(!executed.some((sql) => sql.startsWith("update teacher_digest_runs")));
  assert.ok(executed.some((sql) => sql.includes("update teacher_digest_deepseek_evidence_items") && sql.includes("is_included = true")));
  assert.ok(executed.some((sql) => sql.startsWith("update teacher_digest_deepseek_runs") && sql.includes("status='published'")));
});

test("post-send digest bookkeeping failure cannot roll back provider acceptance", async () => {
  const executed = [];
  const client = {
    query: async (sql) => {
      const normal = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      executed.push(normal);
      if (["begin", "commit", "rollback"].includes(normal)) return { rows: [] };
      if (normal.startsWith("update email_queue")) {
        return { rows: [{ id: "email-1", status: "SENT", source_type: "TEACHER_PROGRESS_DIGEST", provider_message_id: "brevo-1" }] };
      }
      if (normal.startsWith("select generated.id")) throw new Error("simulated checkpoint failure");
      throw new Error(`Unexpected SQL: ${normal}`);
    }
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await markQueuedEmailSent(
      { emailId: "44444444-4444-4444-8444-444444444444", providerMessageId: "brevo-1" },
      { withSupabaseClient: async (callback) => callback(client) }
    );
    assert.equal(result.status, "SENT");
    assert.equal(result.post_send_finalization_status, "FAILED");
    assert.match(result.post_send_finalization_error, /simulated checkpoint failure/);
    assert.ok(executed.indexOf("commit") < executed.indexOf("rollback"));
  } finally {
    console.error = originalConsoleError;
  }
});

test("failure handling never downgrades an email already recorded as SENT", async () => {
  const executed = [];
  const client = {
    query: async (sql) => {
      const normal = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      executed.push(normal);
      if (["begin", "commit"].includes(normal)) return { rows: [] };
      if (normal.startsWith("select * from email_queue")) {
        return { rows: [{ id: "email-1", status: "SENT", source_type: "TEACHER_PROGRESS_DIGEST" }] };
      }
      throw new Error(`Unexpected SQL: ${normal}`);
    }
  };

  const result = await markQueuedEmailFailed(
    { emailId: "44444444-4444-4444-8444-444444444444", errorMessage: "late failure" },
    { withSupabaseClient: async (callback) => callback(client) }
  );
  assert.equal(result.status, "SENT");
  assert.ok(!executed.some((sql) => sql.startsWith("update email_queue")));
});

test("monthly payment snapshot selects one current enrollment for students.active=true", async () => {
  let activeSql = "";
  const client = {
    query: async (sql) => {
      const normal = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      if (normal.startsWith("select to_regclass")) return { rows: [{ table_name: "public.mock" }] };
      if (["begin", "commit"].includes(normal)) return { rows: [] };
      if (normal.includes("from students s") && normal.includes("join lateral")) {
        activeSql = String(sql);
        return { rows: [{ enrollment_id: "e1", student_id: STUDENT_ID, student_full_name: "Test", student_email: "test@example.com", start_date: "2026-08-01" }] };
      }
      if (normal.includes("from admin_monthly_payment_control_runs")) return { rows: [] };
      if (normal.startsWith("insert into admin_monthly_payment_control_runs")) return { rows: [{ id: "r1", admin_email: "admin@example.com" }] };
      if (normal.startsWith("insert into admin_monthly_payment_control_students")) return { rows: [{ id: "row1" }] };
      throw new Error(`Unexpected SQL: ${normal}`);
    }
  };
  const result = await createMonthlyPaymentControlRuns(
    { adminEmails: ["admin@example.com"], cycleMonth: "2026-08-01" },
    { withSupabaseClient: async (callback) => callback(client) }
  );
  assert.equal(result.active_student_count, 1);
  assert.match(activeSql, /where s\.active is true/i);
  assert.match(activeSql, /join lateral/i);
  assert.match(activeSql, /limit 1/i);
});

test("monthly payment service sends one Brevo email containing one secure dashboard link", async () => {
  const oldEmails = process.env.ADMIN_PAYMENT_CONTROL_EMAILS;
  const oldUrl = process.env.ADMIN_PAYMENT_CONTROL_PUBLIC_BASE_URL;
  process.env.ADMIN_PAYMENT_CONTROL_EMAILS = "first@example.com,second@example.com";
  process.env.ADMIN_PAYMENT_CONTROL_PUBLIC_BASE_URL = "https://worker.example.com";
  const messages = [];
  try {
    const result = await sendMonthlyPaymentControlEmails({}, {
      createMonthlyPaymentControlRuns: async (options) => ({
        ok: true,
        runs: [{ id: "r1", token_raw: "secure-token", cycle_month: "2026-08-01", expires_at: "2026-09-01T00:00:00Z", active_student_count: 2, admin_email: options.adminEmails[0] }]
      }),
      sendBrevoTransactionalEmail: async (message) => { messages.push(message); return { message_id: "b1" }; },
      markMonthlyPaymentControlRunEmailStatus: async () => ({ ok: true })
    });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].toEmail, "first@example.com");
    assert.equal((messages[0].htmlContent.match(/href=/g) || []).length, 1);
    assert.match(messages[0].htmlContent, /\/api\/admin\/payment-control\?token=secure-token/);
    assert.equal(result.email_delivery_status, "sent");
  } finally {
    if (oldEmails === undefined) delete process.env.ADMIN_PAYMENT_CONTROL_EMAILS; else process.env.ADMIN_PAYMENT_CONTROL_EMAILS = oldEmails;
    if (oldUrl === undefined) delete process.env.ADMIN_PAYMENT_CONTROL_PUBLIC_BASE_URL; else process.env.ADMIN_PAYMENT_CONTROL_PUBLIC_BASE_URL = oldUrl;
  }
});

function fakeApp_() {
  const handlers = new Map();
  return {
    handlers,
    get(path, handler) { handlers.set(`GET ${path}`, handler); },
    post(path, handler) { handlers.set(`POST ${path}`, handler); }
  };
}

function fakeResponse_() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    json(body) { this.body = body; return this; }
  };
}

test("final feedback assembly naturally refreshes source-changed delivered rows", async () => {
  const oldDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://mock:mock@localhost:5432/mock";
  let assemblySql = "";
  let assemblyParams = [];
  const client = {
    query: async (sql, params = []) => {
      const normal = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      if (["begin", "commit", "rollback"].includes(normal)) return { rows: [], rowCount: 0 };
      if (normal.startsWith("with source_drafts")) {
        assemblySql = String(sql);
        assemblyParams = params;
        return {
          rowCount: 1,
          rows: [{
            id: "52098827-5a33-460f-af5f-137a61becc85",
            student_email: "kamdemclementine548@gmail.com",
            assignment_key: "A2_M1_U4_D3_ASSIGNMENT",
            speaking_status: "REVIEWED",
            speaking_score_display: "65/100",
            final_score_display: "68/100",
            pdf_status: "READY_FOR_PDF",
            delivery_status: "NOT_QUEUED"
          }]
        };
      }
      throw new Error(`Unexpected SQL: ${normal}`);
    }
  };

  const result = await assembleFinalFeedback({ limit: 1 }, {
    withSupabaseClient: async (callback) => callback(client)
  });

  assert.equal(result.assembled_count, 1);
  assert.equal(result.final_feedback[0].final_score_display, "68/100");
  assert.equal(assemblyParams.length, 7);
  assert.match(assemblySql, /greatest\([\s\S]*\) > ff\.pdf_ready_at/i);
  assert.match(assemblySql, /ff\.id is null[\s\S]*or ff\.pdf_ready_at is null/i);
  assert.doesNotMatch(assemblySql, /forceReissue|Explicit corrected-feedback reissue|ff\.delivery_status is distinct from 'EMAIL_SENT'/i);
  assert.match(assemblySql, /pdf_job_id = case when \([\s\S]*is distinct from row\([\s\S]*then null/i);
  assert.match(assemblySql, /email_sent_at = case when \([\s\S]*is distinct from row\([\s\S]*then null/i);
  if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = oldDatabaseUrl;
});

test("generic browser route advances one available student without a target email", async () => {
  const oldSecret = process.env.WORKER_ADMIN_TEST_SECRET;
  process.env.WORKER_ADMIN_TEST_SECRET = "test-secret";
  const app = fakeApp_();
  let generateCalls = 0;

  try {
    registerFinalFeedbackRoutes(app, {
      assembleFinalFeedback: async (options) => {
        assert.equal(options.limit, 100);
        assert.equal(options.studentEmail, undefined);
        assert.equal(options.assignmentKey, undefined);
        return { assembled_count: 3, final_feedback: [] };
      },
      generateNextPdfJob: async (options) => {
        generateCalls += 1;
        assert.equal(options.finalFeedbackId, undefined);
        assert.equal(options.includeSameDayReady, true);
        return generateCalls === 1
          ? { status: "PDF_SUBMITTED", pdf_job: { id: "normal-job-1", student_email: "next@example.com" } }
          : { status: "NO_READY_PDF_PAYLOAD" };
      }
    });

    const request = {
      query: {
        secret: "test-secret",
        confirm: "PROCESS_NEXT_STUDENT_FEEDBACK"
      },
      body: {},
      get() { return ""; }
    };

    const firstResponse = fakeResponse_();
    await app.handlers.get("GET /worker/final-feedback/process-next")(request, firstResponse);
    assert.equal(firstResponse.statusCode, 201);
    assert.equal(firstResponse.body.status, "NEXT_STUDENT_FEEDBACK_PDF_SUBMITTED");
    assert.equal(generateCalls, 1);

    const secondResponse = fakeResponse_();
    await app.handlers.get("GET /worker/final-feedback/process-next")(request, secondResponse);
    assert.equal(secondResponse.statusCode, 200);
    assert.equal(secondResponse.body.status, "NO_PENDING_STUDENT_FEEDBACK");
    assert.equal(generateCalls, 2);
    assert.equal(app.handlers.has("GET /worker/final-feedback/reissue-corrected"), false);
    assert.equal(app.handlers.has("GET /worker/final-feedback/reissue-corrected-batch"), false);
  } finally {
    if (oldSecret === undefined) delete process.env.WORKER_ADMIN_TEST_SECRET;
    else process.env.WORKER_ADMIN_TEST_SECRET = oldSecret;
  }
});

test("PDF claiming rejects final feedback older than any source draft and supports exact feedback targeting", async () => {
  const source = await readFile(new URL("../src/supabase/pdfJobRepository.js", import.meta.url), "utf8");
  assert.match(source, /current_draft\.submission_id = ff\.submission_id/i);
  assert.match(source, /> ff\.pdf_ready_at/i);
  assert.match(source, /finalFeedbackId[\s\S]*ff\.id = \$\$\{params\.length\}::uuid/i);
  assert.match(source, /selectedRowsFilter = filter/i);
});

test("student feedback email has no incident-specific replacement language", async () => {
  const source = await readFile(new URL("../src/supabase/emailQueueRepository.js", import.meta.url), "utf8");
  assert.match(source, /Your feedback PDF is ready/i);
  assert.doesNotMatch(source, /Corrected replacement feedback PDF|previous PDF did not include|corrected_reissue/i);
});

test("a replacement emailed after an earlier digest becomes eligible for a later digest", async () => {
  const source = await readFile(new URL("../src/supabase/teacherDigestPersonalisationRepository.js", import.meta.url), "utf8");
  assert.match(source, /included\.source_kind = 'FINAL_FEEDBACK'/i);
  assert.match(source, /included\.source_id = ff\.id/i);
  assert.match(source, /included\.delivery_key = coalesce\([\s\S]*ff\.email_queue_id::text/i);
});

test("secure dashboard renders one POST Deactivate button per active student", async () => {
  const app = fakeApp_();
  registerAdminPaymentControlRoutes(app, {
    loadMonthlyPaymentControlPage: async () => ({
      token_raw: "secure-token",
      expired: false,
      status: "SENT",
      students: [
        { id: "row1", student_full_name: "First", student_email: "first@example.com", level: "B1" },
        { id: "row2", student_full_name: "<script>unsafe</script>", student_email: "second@example.com", level: "A2" }
      ]
    }),
    deactivateStudentFromPaymentControlPage: async () => ({ ok: true, status: "STUDENT_DEACTIVATED" }),
    sendMonthlyPaymentControlEmails: async () => ({ ok: true })
  });
  const response = fakeResponse_();
  await app.handlers.get("GET /api/admin/payment-control")({ query: { token: "secure-token" } }, response);
  assert.equal((response.body.match(/type="submit"/g) || []).length, 2);
  assert.equal((response.body.match(/method="post"/g) || []).length, 2);
  assert.doesNotMatch(response.body, /<script>unsafe<\/script>/);
});

test("deactivation repository writes students.active=false", async () => {
  let studentUpdate = "";
  const client = {
    query: async (sql) => {
      const normal = String(sql).replace(/\s+/g, " ").trim().toLowerCase();
      if (normal.startsWith("select to_regclass")) return { rows: [{ table_name: "public.mock" }] };
      if (["begin", "commit"].includes(normal)) return { rows: [] };
      if (normal.includes("from admin_monthly_payment_control_runs") && normal.includes("for update")) return { rows: [{ id: "r1", status: "SENT", expires_at: "2099-01-01T00:00:00Z" }] };
      if (normal.includes("from admin_monthly_payment_control_students") && normal.includes("for update")) return { rows: [{ id: "row1", run_id: "r1", student_id: STUDENT_ID, enrollment_id: "e1", row_status: "ACTIVE" }] };
      if (normal.startsWith("update enrollments")) return { rows: [{ id: "e1" }] };
      if (normal.startsWith("update students")) { studentUpdate = String(sql); return { rows: [] }; }
      if (normal.startsWith("update admin_monthly_payment_control_students")) return { rows: [{ id: "row1", row_status: "DEACTIVATED" }] };
      if (normal.startsWith("insert into admin_monthly_payment_control_actions")) return { rows: [{ id: "a1" }] };
      throw new Error(`Unexpected SQL: ${normal}`);
    }
  };
  const result = await deactivateStudentFromMonthlyPaymentControl(
    { token: "secure-token", paymentControlStudentId: "row1" },
    { withSupabaseClient: async (callback) => callback(client) }
  );
  assert.equal(result.status, "STUDENT_DEACTIVATED");
  assert.match(studentUpdate, /active = false/i);
  assert.match(studentUpdate, /status = 'INACTIVE'/i);
});

test("date helper remains stable across month boundaries", () => {
  assert.equal(addCalendarDays("2026-09-01", -1), "2026-08-31");
  assert.throws(() => addCalendarDays("2026-02-31", 1), /Invalid calendar date/);
  assert.throws(() => buildTeacherDigestWindow({ cycleDate: "2026-02-31" }), /Invalid calendar date/);
});

test("build information exposes only the immutable Sliplane commit identifier", () => {
  const info = getBuildInfo({
    SLIPLANE_COMMIT_HASH: "abc123def456",
    DATABASE_URL: "postgresql://must-not-leak",
    WORKER_ADMIN_SECRET: "must-not-leak"
  });
  assert.deepEqual(info, {
    service: "selc-worker",
      package_version: "1.2.7",
    commit_hash: "abc123def456",
    commit_hash_available: true
  });
  assert.doesNotMatch(JSON.stringify(info), /must-not-leak|DATABASE_URL|WORKER_ADMIN_SECRET/);
});

test("activity dates use Africa/Douala rather than the UTC calendar day", () => {
  const metric = calculateWeeklyMetric({
    student: { student_id: STUDENT_ID, start_date: "2026-08-23" },
    weekStart: "2026-08-23",
    quizzes: [{ quiz_key: "Q1", score: 80, submitted_at: "2026-08-22T23:30:00.000Z" }]
  });
  assert.deepEqual(metric.activity_dates, ["2026-08-23"]);
});

test("speaking teacher bundles select and use a canonical PostgreSQL cycle date", async () => {
  const repository = await readFile(new URL("../src/supabase/speakingTopicRepository.js", import.meta.url), "utf8");
  assert.match(repository, /to_char\(cycle_date, ['"]YYYY-MM-DD['"]\) as cycle_date_iso/i);
  assert.match(repository, /cycle_date:\s*canonicalTeacherBundleCycleDate\(cycle\)/);
  assert.doesNotMatch(repository, /String\(cycle\.cycle_date\)\.slice\(0,\s*10\)/);
  assert.match(repository, /on conflict\(idempotency_key\) do nothing/i);
  assert.match(repository, /select id,status,attempt_count,next_attempt_at,error_code,error_message from email_queue where idempotency_key=\$1/i);
});
