import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { buildSpeakingTopicRequestBody, validateGeneratedTarget } from "../src/speaking/prompt.js";
import { renderGroupTopicsEmail } from "../src/speaking/emailRenderer.js";
import { registerSpeakingTopicResponseRoutes } from "../src/routes/speakingTopicResponseRoutes.js";
import { submitSpeakingTopicResponse } from "../src/speakingTopicResponse/service.js";

function generatedTopic(theme = "DAILY_LIFE") {
  return {
    title: "A replacement topic",
    learner_content: { body: "Discuss a practical situation.", points: ["Explain your choice."] },
    teacher_questions: ["Why did you make that choice?"],
    theme_code: theme,
    situation_slug: "replacement_topic",
    outcome_code: "EXPLAIN"
  };
}

function pageRow(overrides = {}) {
  return {
    id: "session-1",
    version: 1,
    editable: true,
    curriculum_snapshot: { level: "A1", module: "3" },
    topics: [1, 2, 3].map((position) => ({
      id: `topic-${position}`,
      position,
      title: `Sujet ${position}`,
      learner_content: { body: "Parlez de cette situation.", points: ["Donnez une raison."] },
      response: null
    })),
    ...overrides
  };
}

test("partial group generation requests only the missing topic and preserves combined theme diversity", () => {
  const target = {
    id: "target-1",
    target_type: "group",
    requested_topic_count: 1,
    carried_theme_codes: ["WORK"],
    curriculum_snapshot: { level: "A2", module: "2" }
  };
  const valid = validateGeneratedTarget(target, { target_id: target.id, topics: [generatedTopic("DAILY_LIFE")] });
  assert.equal(valid.ok, true);
  assert.equal(valid.topics.length, 1);
  const invalid = validateGeneratedTarget(target, { target_id: target.id, topics: [generatedTopic("WORK")] });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("; "), /at least 2 theme families/);

  const body = buildSpeakingTopicRequestBody({ targets: [target], grammarCatalogue: [] });
  const payload = JSON.parse(body.messages[1].content);
  assert.equal(payload.targets[0].requested_topic_count, 1);
  assert.deepEqual(payload.targets[0].carried_topic_theme_codes, ["WORK"]);
  assert.match(body.messages[0].content, /create exactly requested_topic_count/i);
});

test("private and IELTS topic counts remain unchanged", () => {
  const source = readFile(new URL("../src/speaking/prompt.js", import.meta.url), "utf8");
  return source.then((text) => {
    assert.match(text, /Create exactly 10 personalised weekly topics/);
    assert.match(text, /Create one shared collection of exactly 10 original IELTS Speaking sets/);
    assert.match(text, /target\.target_type === "group" \? Number\(target\.requested_topic_count \|\| 3\) : 10/);
  });
});

test("group emails explain required topic reporting in the correct language", () => {
  const topics = pageRow().topics;
  const french = renderGroupTopicsEmail({
    student_name: "Awa",
    curriculum_snapshot: { level: "A1", module: "3" },
    topic_response_url: "https://worker.example/api/speaking-topic-response?token=french",
    topics
  });
  assert.match(french.text, /Vous devez répondre pour les trois sujets/);
  assert.match(french.text, /Mettre à jour mes sujets/);

  const english = renderGroupTopicsEmail({
    student_name: "Awa",
    curriculum_snapshot: { level: "A1", module: "4" },
    topic_response_url: "https://worker.example/api/speaking-topic-response?token=english",
    topics
  });
  assert.match(english.text, /You must answer for all three topics/);
  assert.match(english.text, /Topics that have not been discussed will be sent to you again/);
});

test("the response service rejects an incomplete form and saves one required answer per topic", async () => {
  const row = pageRow();
  const dependencies = {
    loadSpeakingTopicResponseSession: async () => row,
    saveSpeakingTopicResponses: async (input) => ({ ...row, version: 2, saved: input })
  };
  await assert.rejects(
    submitSpeakingTopicResponse({ token: "token", version: 1, "topic_topic-1": "DISCUSSED" }, dependencies),
    (error) => error.code === "ALL_TOPICS_REQUIRED"
  );
  const saved = await submitSpeakingTopicResponse({
    token: "token",
    version: 1,
    "topic_topic-1": "DISCUSSED",
    "topic_topic-2": "NOT_YET",
    "topic_topic-3": "DISCUSSED"
  }, dependencies);
  assert.deepEqual(saved.saved.answers, {
    "topic-1": "DISCUSSED",
    "topic-2": "NOT_YET",
    "topic-3": "DISCUSSED"
  });
});

test("GET is read-only and the early-A1 page requires all three radio groups before one submit", async () => {
  const routes = {};
  let submitCalls = 0;
  const app = {
    get(path, handler) { routes[`GET ${path}`] = handler; },
    post(path, handler) { routes[`POST ${path}`] = handler; }
  };
  registerSpeakingTopicResponseRoutes(app, {
    loadSpeakingTopicResponsePage: async () => pageRow(),
    submitSpeakingTopicResponse: async () => { submitCalls += 1; return pageRow({ version: 2 }); }
  });
  const response = {
    statusCode: 200,
    set() { return this; },
    status(value) { this.statusCode = value; return this; },
    send(value) { this.body = value; return this; }
  };
  await routes["GET /api/speaking-topic-response"]({ query: { token: "token" } }, response);
  assert.equal(submitCalls, 0);
  assert.equal((response.body.match(/type="radio"/g) || []).length, 6);
  assert.equal((response.body.match(/ required /g) || []).length, 6);
  assert.equal((response.body.match(/type="submit"/g) || []).length, 1);
  assert.match(response.body, /Avez-vous déjà discuté de ce sujet avec votre professeur/);
});

test("repository wiring carries topics, generates only the missing count and still builds every group PDF", async () => {
  const [repository, responseRepository, pipeline, server, emailWorker] = await Promise.all([
    readFile(new URL("../src/supabase/speakingTopicRepository.js", import.meta.url), "utf8"),
    readFile(new URL("../src/supabase/speakingTopicResponseRepository.js", import.meta.url), "utf8"),
    readFile(new URL("../src/speaking/pipeline.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8"),
    readFile(new URL("../src/studentEmailDeliveryWorker.js", import.meta.url), "utf8")
  ]);
  assert.match(repository, /prepareGroupTopicReuse_/);
  assert.match(repository, /requested_topic_count=\$2::smallint/);
  assert.match(repository, /case when \$2::smallint=0::smallint then 'READY' else 'PENDING'/);
  assert.match(repository, /speaking_group_cycle_topics/);
  assert.match(repository, /speaking_group_topic_progress/);
  assert.match(repository, /speaking_group_topic_response_sessions/);
  assert.match(repository, /topic_response_url/);
  assert.match(repository, /loadTopicsForTargets_/);
  assert.match(repository, /values\(\$1,\$2,\$3,'student',\$4,\$5,\$6,'QUEUED',\$7,null,null,null,null\)/);
  assert.match(repository, /if\(sourceType==='SPEAKING_GROUP_TOPICS'\)/);
  assert.match(repository, /else if\(sourceType==='SPEAKING_PROFILE_REMINDER'\)/);
  assert.doesNotMatch(repository, /update email_queue set payload_json=jsonb_build_object\('topic_response_url'/);
  assert.match(emailWorker, /hasRenderedEmailContent_\(job\)/);
  assert.match(emailWorker, /&& !hasRenderedEmailContent_\(job\)/);
  assert.match(responseRepository, /select st\.id, map\.position, st\.title, st\.learner_content,\s+item\.response/);
  assert.doesNotMatch(responseRepository, /coalesce\(item\.response, progress\.last_response\)/);
  assert.match(pipeline, /groupDocuments=await createGroupDocumentJobs\(cycle,config,repository\)/);
  assert.match(server, /registerSpeakingTopicResponseRoutes\(app\)/);
});
