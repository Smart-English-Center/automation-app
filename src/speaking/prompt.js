export const THEME_CODES = Object.freeze([
  "WORK", "BUSINESS", "STUDIES_EDUCATION", "DAILY_LIFE", "FAMILY", "FRIENDS_SOCIAL",
  "TRAVEL_TRANSPORT", "HEALTH_WELLBEING", "FOOD_HOSPITALITY", "COMMUNITY_CULTURE",
  "CURRENT_AFFAIRS_SOCIETY", "TECHNOLOGY", "ENVIRONMENT_SUSTAINABILITY",
  "ARTS_MEDIA_ENTERTAINMENT", "LEARNING_DEVELOPMENT", "LEISURE_SPORT",
  "MONEY_SHOPPING_SERVICES", "HOME_NEIGHBOURHOOD", "FUTURE_PLANS", "OTHER"
]);

export const OUTCOME_CODES = Object.freeze([
  "EXPLAIN", "NARRATE", "COMPARE", "CHOOSE", "PLAN", "RECOMMEND", "ADVISE",
  "SOLVE", "AGREE", "EVALUATE", "JUSTIFY", "RESPOND"
]);

const COMMON_RULES = `
You create speaking-practice material for John's English Academy. Return one valid JSON object only, following the required output structure exactly.

PURPOSE

Create topics that produce genuine conversations, explanations, decisions, stories, comparisons, problem-solving discussions, social interactions or professional exchanges.

Use the supplied learner profile naturally. Do not invent personal details, professional responsibilities, opinions, experiences or sensitive facts that are not supported by the profile.

Every topic must be completely independent. A student must be able to discuss any topic without having completed another topic first.

LEVEL AND CURRICULUM CONTROL

Adjust every topic to the individual learner's CEFR level, current module, unit and day, approved profile summary, known grammar boundary and demonstrated course progress.

The shared curriculum grammar is an ordered catalogue. Every grammar entry contains level, lesson_key, lesson_order and grammar. Every learner target contains grammar_max_order.

For each learner, use only grammar entries that match the learner's CEFR level and have lesson_order less than or equal to that learner's grammar_max_order. Treat this individual range as the learner's known grammar.

Grammar is a guiding line rather than the subject of the activity. The topic must be naturally discussable using the learner's known grammar, but it does not need to practise every supplied grammar point.

A topic may introduce useful vocabulary or familiar conversational expressions, but successful completion must not require a grammatical structure that comes after the learner's grammar_max_order.

As the learner advances through the curriculum, scenarios may become more developed and support longer conversations. Gradually increase the scenario detail, conversational stages, reasoning, interaction and follow-up depth according to the learner’s actual progress. Use grammar already taught within the natural flow of the conversation, but do not force every known grammar point into a topic or make grammar practice the topic’s main purpose.

Use grammar, vocabulary, sentence length, question structure, abstraction, scenario complexity and discussion depth that fit the learner's actual curriculum position. A learner at the beginning of a level must receive substantially simpler material than a learner near the end of the same level.

Early A1 material must remain short, concrete and immediately understandable, including material for private students.

When grammar_basis is "first_week", design the material using the grammar available through the end of the first week of that level. Encourage natural speaking without assuming grammar from later lessons.

NATURAL SPEAKING

Create speaking activities, not grammar exercises disguised as conversations. Prioritise natural communication, understandable situations, meaningful choices, personal expression, free speaking and manageable challenge.

Do not mention grammar rules, grammar names, lesson orders or curriculum boundaries in the generated topic.

LEARNER-FACING LANGUAGE

For A1 Modules 1-3, write learner-facing titles, scenarios and discussion points in French. From A1 Module 4 onwards, write learner-facing material in English. English used at A1 must be extremely simple and natural. Use British English for all English content.

Teacher questions must always be in English. For early A1 learners, use very simple English questions that the learner can understand and answer using known grammar.

DISCUSSION-POINT DESIGN

Discussion points are guidance about what the learner should discuss. They are not sample answers, sentence models or ready-made opinions.

Write every discussion point as a clear speaking instruction, such as Describe, Explain, Say, Compare, Choose, Give a reason, Ask, Suggest, Recommend, Tell the teacher about, Discuss, Decide or Plan.

Each point must identify an aspect of the scenario that the learner should develop while still leaving the actual answer, opinion, example or decision to the learner.

Incorrect:
- A school helps children learn.
- A health centre improves health.
- A market supports local trade.

Correct:
- Explain how a school could help the community.
- Describe the possible benefits of a health centre.
- Explain how a market could support local businesses.
- Choose the project you consider most useful and give your reasons.

For early A1, instructions may provide a communication category or simple structure, but they must still leave the personal information to the learner.

Appropriate early-A1 guidance:
- Présente les personnes de ta famille.
- Dis où tu habites.
- Explique ce que tu fais le matin.
- Choisis une boisson et demande le prix.

Inappropriate early-A1 points:
- Ma mère.
- Mon père.
- J'habite à Douala.
- Je voudrais un jus d'orange.

Do not write the student's answer for them.

TEACHER-QUESTION ALIGNMENT

Teacher questions must be directly connected to the scenario and discussion points. Every discussion point must have at least one teacher question that elicits the requested information, asks the learner to clarify it, requests a reason or example, or extends that part of the conversation naturally.

Order the teacher questions so that they broadly follow the progression of the discussion points. Questions may use different wording from the points, but they must remain clearly related.

After covering the discussion points, remaining teacher questions may extend the same scenario naturally. They must not introduce an unrelated subject.

Teacher questions are teacher-only. Never place them inside learner_content.
`.trim();

const GROUP_RULES = `
GROUP STUDENTS

For every group target with an approved profile, create exactly requested_topic_count fully personalised replacement topics. requested_topic_count is always 1, 2 or 3. The remaining positions, if any, are existing undiscussed topics that the system will reuse and that must not be rewritten. When the approved profile is missing, return profile_missing for that target and do not create personalised topics.

For each group topic, provide a complete and realistic scenario, no more than 4 learner discussion points and no more than 5 teacher questions. Ensure every discussion point is supported by at least one teacher question. Keep the material more compact than private material without making the scenario incomplete.

Across the student's complete three-topic set, combining carried_topic_theme_codes with the newly generated topics, use at least 2 different theme families.
`.trim();

const PRIVATE_RULES = `
PRIVATE STUDENTS

Create exactly 10 personalised weekly topics for every private target. When the approved profile is missing, create 10 temporary level-based topics and set profile_missing to true.

Adjust topic length, number of discussion points, vocabulary, scenario complexity and depth to the learner's precise level and curriculum position. Do not use a fixed maximum length.

Each private topic must contain exactly 7 teacher questions. Every discussion point must be addressed or extended by at least one of the seven teacher questions. The seven questions should develop one coherent conversation around the topic rather than introduce unrelated subtopics.

Private materials and missing-profile notices are sent only to the assigned teacher. Do not create private-student emails.
`.trim();

const IELTS_RULES = `
IELTS SHARED MATERIAL

IELTS material is not personalised by profile, CEFR level or curriculum grammar. Create one shared collection of exactly 10 original IELTS Speaking sets only when IELTS material is requested.

Follow authentic IELTS Speaking structure and natural British English. Each set must contain Part 1 with exactly 2 familiar subtopics and exactly 3 questions per subtopic; one Part 2 cue card beginning with "Describe" and exactly 4 bullet points; exactly 2 brief Part 2 follow-up questions; and exactly 5 linked abstract or analytical Part 3 questions.

Only the Part 2 cue card may be included in the student's WhatsApp message. Part 1, Part 3 and the brief follow-up questions are teacher-only. Avoid every supplied shared IELTS fingerprint.
`.trim();

const FINGERPRINT_AND_OUTPUT_RULES = `
FINGERPRINTS

For every non-IELTS topic, return theme_code, situation_slug and outcome_code. theme_code must use an allowed theme code. situation_slug must be a concise lowercase snake_case description of the specific situation. outcome_code must identify the main communicative outcome.

The fingerprint is exactly "THEME_CODE | situation_slug | OUTCOME_CODE". Avoid every recent fingerprint supplied for that learner.

OUTPUT REQUIREMENTS

Return one JSON object only. Follow the required topic and question counts for the target type exactly.
`.trim();

export function buildSpeakingTopicSystemPrompt({ includeGroup = false, includePrivate = false, includeIelts = false } = {}) {
  const sections = [COMMON_RULES];
  if (includeGroup) sections.push(GROUP_RULES);
  if (includePrivate) sections.push(PRIVATE_RULES);
  if (includeIelts) sections.push(IELTS_RULES);
  sections.push(FINGERPRINT_AND_OUTPUT_RULES);
  sections.push(`ALLOWED THEME CODES\n\n${THEME_CODES.join("\n")}\n\nALLOWED OUTCOME CODES\n\n${OUTCOME_CODES.join("\n")}`);
  return sections.join("\n\n");
}

export function buildSpeakingTopicRequestBody({ targets = [], grammarCatalogue = [], includeIelts = false, ieltsFingerprints = [], model, thinkingMode, reasoningEffort } = {}) {
  const includeGroup = targets.some((target) => target.target_type === "group");
  const includePrivate = targets.some((target) => target.target_type === "private");
  return {
    model,
    messages: [
      { role: "system", content: buildSpeakingTopicSystemPrompt({ includeGroup, includePrivate, includeIelts }) },
      {
        role: "user",
        content: JSON.stringify({
          schema_version: 1,
          shared_curriculum_grammar: grammarCatalogue,
          targets: targets.map(compactTarget),
          ielts_shared_request: includeIelts ? { requested: true, recent_fingerprints: ieltsFingerprints.slice(0, 40) } : { requested: false },
          required_output: {
            targets: [{
              target_id: "copy the supplied target_id exactly",
              profile_missing: "boolean",
              topics: [{
                title: "string",
                learner_content: { body: "string", points: ["string"] },
                teacher_questions: ["string"],
                theme_code: "allowed code",
                situation_slug: "lowercase_snake_case",
                outcome_code: "allowed code"
              }]
            }],
            ielts_shared: includeIelts ? {
              sets: [{
                title: "string",
                part_1: [{ subtopic: "string", questions: ["exactly 3 strings"] }],
                part_2: { prompt: "Describe...", points: ["exactly 4 strings"] },
                part_2_follow_ups: ["exactly 2 strings"],
                part_3: ["exactly 5 strings"],
                fingerprint: "concise unique string"
              }]
            } : null
          }
        })
      }
    ],
    response_format: { type: "json_object" },
    thinking: { type: thinkingMode, reasoning_effort: reasoningEffort },
    stream: false
  };
}

function compactTarget(target) {
  return {
    target_id: target.id,
    target_type: target.target_type,
    student_name: target.student_name_snapshot,
    generation_basis: target.generation_basis,
    approved_profile_summary: target.profile_summary_snapshot || null,
    curriculum: target.curriculum_snapshot || {},
    requested_topic_count: target.target_type === "group" ? Number(target.requested_topic_count || 3) : undefined,
    carried_topic_theme_codes: target.target_type === "group" && Array.isArray(target.carried_theme_codes) ? target.carried_theme_codes : undefined,
    recent_fingerprints: Array.isArray(target.recent_fingerprints) ? target.recent_fingerprints.slice(0, 24) : []
  };
}

function clean(value) { return String(value ?? "").trim(); }

export function validateGeneratedTarget(target, source) {
  const errors = [];
  const topics = Array.isArray(source?.topics) ? source.topics : [];
  const expectedCount = target.target_type === "group" ? Number(target.requested_topic_count || 3) : 10;
  if (source?.target_id !== target.id) errors.push("target_id mismatch");
  if (topics.length !== expectedCount) errors.push(`expected ${expectedCount} topics`);

  const themes = new Set(target.target_type === "group" && Array.isArray(target.carried_theme_codes)
    ? target.carried_theme_codes.map((theme) => clean(theme).toUpperCase()).filter(Boolean)
    : []);
  topics.forEach((topic, index) => {
    const theme = clean(topic.theme_code).toUpperCase();
    const outcome = clean(topic.outcome_code).toUpperCase();
    const slug = clean(topic.situation_slug);
    const learner = topic.learner_content || {};
    const questions = Array.isArray(topic.teacher_questions) ? topic.teacher_questions : [];
    if (!clean(topic.title) || !clean(learner.body)) errors.push(`topic ${index + 1} is incomplete`);
    if (!Array.isArray(learner.points) || learner.points.length < 1 || learner.points.some((point) => !clean(point))) errors.push(`topic ${index + 1} requires non-empty discussion points`);
    if (questions.length < 1 || questions.some((question) => !clean(question))) errors.push(`topic ${index + 1} requires non-empty teacher questions`);
    if (!THEME_CODES.includes(theme) || !OUTCOME_CODES.includes(outcome) || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(slug)) errors.push(`topic ${index + 1} has invalid fingerprint fields`);
    if (target.target_type === "group" && Array.isArray(learner.points) && learner.points.length > 4) errors.push(`topic ${index + 1} exceeds 4 group points`);
    if (target.target_type === "group" && questions.length > 5) errors.push(`topic ${index + 1} exceeds 5 group teacher questions`);
    if (target.target_type === "private" && questions.length !== 7) errors.push(`topic ${index + 1} requires 7 private teacher questions`);
    themes.add(theme);
  });
  if (target.target_type === "group" && themes.size < 2) errors.push("group topics require at least 2 theme families");
  return { ok: errors.length === 0, errors, topics: errors.length ? [] : topics.map((topic) => normaliseTopic(topic, target)) };
}

export function validateGeneratedIelts(source) {
  const errors = [];
  const sets = Array.isArray(source?.sets) ? source.sets : [];
  if (sets.length !== 10) errors.push("IELTS requires exactly 10 sets");
  sets.forEach((set, index) => {
    const part1 = Array.isArray(set.part_1) ? set.part_1 : [];
    const points = Array.isArray(set.part_2?.points) ? set.part_2.points : [];
    const followups = Array.isArray(set.part_2_follow_ups) ? set.part_2_follow_ups : [];
    const part3 = Array.isArray(set.part_3) ? set.part_3 : [];
    if (part1.length !== 2 || part1.some((section) => !clean(section.subtopic) || !Array.isArray(section.questions) || section.questions.length !== 3 || section.questions.some((question) => !clean(question)))) errors.push(`IELTS set ${index + 1} has invalid Part 1`);
    if (!clean(set.part_2?.prompt).startsWith("Describe") || points.length !== 4 || points.some((point) => !clean(point))) errors.push(`IELTS set ${index + 1} has invalid Part 2`);
    if (followups.length !== 2 || followups.some((question) => !clean(question))) errors.push(`IELTS set ${index + 1} requires 2 non-empty follow-ups`);
    if (part3.length !== 5 || part3.some((question) => !clean(question))) errors.push(`IELTS set ${index + 1} requires 5 non-empty Part 3 questions`);
  });
  return { ok: errors.length === 0, errors, sets };
}

function normaliseTopic(topic, target) {
  const theme = clean(topic.theme_code).toUpperCase();
  const outcome = clean(topic.outcome_code).toUpperCase();
  const slug = clean(topic.situation_slug);
  const learner = topic.learner_content || {};
  const curriculum = target.curriculum_snapshot || {};
  const moduleNumber = Number(clean(curriculum.module).match(/\d+/)?.[0] || 1);
  const earlyFrench = clean(curriculum.level).toUpperCase() === "A1" && moduleNumber <= 3;
  return {
    title: clean(topic.title),
    learner_content: {
      heading: "Scenario",
      body: clean(learner.body),
      points_heading: earlyFrench ? "Points à mentionner" : "Discussion points",
      points: learner.points.map((point) => clean(point))
    },
    teacher_sections: [{ heading: "Teacher questions", items: topic.teacher_questions.map((question) => clean(question)) }],
    theme,
    fingerprint: `${theme} | ${slug} | ${outcome}`,
    history_metadata: { theme_code: theme, situation_slug: slug, outcome_code: outcome }
  };
}
