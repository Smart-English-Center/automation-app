import { withSupabaseClient } from "./client.js";

function clean(value) { return String(value ?? "").trim(); }

function responseError_(code, message, httpStatus = 400) {
  const error = new Error(message);
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

async function loadSession_(client, tokenHash, { forUpdate = false } = {}) {
  const session = (await client.query(`
    select rs.*, t.student_name_snapshot, t.curriculum_snapshot, c.cycle_date,
      s.full_name student_name, s.email student_email,
      not exists(
        select 1
        from speaking_topic_targets later
        join speaking_topic_cycles later_cycle on later_cycle.id=later.cycle_id
        where later.student_id=rs.student_id
          and later.target_type='group'
          and later_cycle.cycle_date>c.cycle_date
      ) editable
    from speaking_group_topic_response_sessions rs
    join speaking_topic_targets t on t.id=rs.target_id
    join speaking_topic_cycles c on c.id=t.cycle_id
    join students s on s.id=rs.student_id
    where rs.access_token_hash=$1
    ${forUpdate ? "for update of rs" : ""}
  `, [clean(tokenHash)])).rows[0];
  if (!session) return null;
  session.topics = (await client.query(`
    select st.id, map.position, st.title, st.learner_content,
      item.response
    from speaking_group_cycle_topics map
    join speaking_topics st on st.id=map.topic_id
    join speaking_group_topic_progress progress on progress.topic_id=st.id
    left join speaking_group_topic_response_items item
      on item.session_id=$2 and item.topic_id=st.id
    where map.target_id=$1
    order by map.position
  `, [session.target_id, session.id])).rows;
  return session;
}

export async function loadSpeakingTopicResponseSession(tokenHash) {
  return withSupabaseClient((client) => loadSession_(client, tokenHash));
}

export async function saveSpeakingTopicResponses({ tokenHash, version, answers }) {
  return withSupabaseClient(async (client) => {
    await client.query("begin");
    try {
      const session = await loadSession_(client, tokenHash, { forUpdate: true });
      if (!session) throw responseError_("TOPIC_RESPONSE_NOT_FOUND", "This speaking-topic response page was not found.", 404);
      if (!session.editable) throw responseError_("TOPIC_RESPONSE_LOCKED", "These answers can no longer be changed because the next topic cycle has already started.", 409);
      if (Number(session.version) !== Number(version)) throw responseError_("TOPIC_RESPONSE_CHANGED", "This page has changed. Reload it before submitting again.", 409);
      const expectedIds = session.topics.map((topic) => clean(topic.id));
      if (expectedIds.length !== 3 || Object.keys(answers || {}).length !== 3 || expectedIds.some((id) => !answers[id])) {
        throw responseError_("ALL_TOPICS_REQUIRED", "Please answer the question for every topic before submitting.");
      }

      for (const topic of session.topics) {
        const topicId = clean(topic.id);
        const response = clean(answers[topicId]).toUpperCase();
        if (!["DISCUSSED", "NOT_YET"].includes(response)) throw responseError_("INVALID_TOPIC_RESPONSE", "One of the topic responses is invalid.");
        const previous = clean(topic.response).toUpperCase() || null;
        await client.query(`
          insert into speaking_group_topic_response_items(session_id,topic_id,response,created_at,updated_at)
          values($1,$2,$3,now(),now())
          on conflict(session_id,topic_id) do update set response=excluded.response,updated_at=now()
        `, [session.id, topicId, response]);
        const updated = await client.query(`
          update speaking_group_topic_progress set
            status=case when $2='DISCUSSED' then 'DISCUSSED' else 'ACTIVE' end,
            last_response=$2,
            last_response_at=now(),
            discussed_at=case when $2='DISCUSSED' then now() else null end,
            version=version+1,
            updated_at=now()
          where topic_id=$1 and student_id=$3 and status in ('ACTIVE','DISCUSSED')
          returning topic_id
        `, [topicId, response, session.student_id]);
        if (!updated.rowCount) throw responseError_("TOPIC_PROGRESS_MISSING", "A topic can no longer be updated.", 409);
        await client.query(`
          insert into speaking_group_topic_response_actions(session_id,topic_id,previous_response,new_response,created_at)
          values($1,$2,$3,$4,now())
        `, [session.id, topicId, previous, response]);
      }

      await client.query(`
        update speaking_group_topic_response_sessions set
          status='SUBMITTED', submitted_at=now(), version=version+1, updated_at=now()
        where id=$1
      `, [session.id]);
      await client.query("commit");
      return loadSession_(client, tokenHash);
    } catch (error) {
      await client.query("rollback").catch(() => {});
      throw error;
    }
  });
}
