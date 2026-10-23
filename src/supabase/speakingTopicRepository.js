import crypto from "node:crypto";
import { studentFacingName } from "../studentFacingName.js";
import { createSpeakingTopicResponseToken } from "../speakingTopicResponse/security.js";
import { speakingTopicResponseUrl } from "../speakingTopicResponse/service.js";
import { withSupabaseClient } from "./client.js";

function clean(value) { return String(value ?? "").trim(); }

export function canonicalTeacherBundleCycleDate(cycle = {}) {
  const value = clean(cycle.cycle_date_iso);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error("Speaking teacher bundle cycle date must be canonical YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const lastDay = month >= 1 && month <= 12 ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 0;
  if (day < 1 || day > lastDay) throw new Error("Speaking teacher bundle cycle date must be canonical YYYY-MM-DD.");
  return value;
}

export function buildTeacherBundleQueuePayload({ cycle, cycleId, bundle }) {
  return {
    bundle_version: "JEA_SPEAKING_TEACHER_BUNDLE_V1",
    cycle_id: cycleId,
    cycle_date: canonicalTeacherBundleCycleDate(cycle),
    recipient_email: bundle.recipient_email,
    recipient_name: bundle.recipient_name,
    document_job_ids: bundle.documents.map((document) => document.job_id),
    documents: bundle.documents
  };
}
function retryDate(minutes) {
  const parsed = Number(minutes);
  const safeMinutes = Number.isFinite(parsed) && parsed >= 1 ? parsed : 5;
  return new Date(Date.now() + safeMinutes * 60000);
}

async function prepareGroupTopicReuse_(client, target) {
  if (!target || target.target_type !== "group" || target.status === "PROFILE_MISSING") return target;
  const level = clean(target.curriculum_snapshot?.level).toUpperCase();
  await client.query(`
    update speaking_group_topic_progress set
      status='RETIRED',retired_at=now(),updated_at=now()
    where student_id=$1 and status='ACTIVE'
      and (upper(coalesce(level_snapshot,''))<>$2
        or profile_approved_at_snapshot is distinct from $3::timestamptz)
  `,[target.student_id,level,target.profile_approved_at_snapshot||null]);
  const reusable=(await client.query(`
    select progress.topic_id
    from speaking_group_topic_progress progress
    join speaking_topics topic on topic.id=progress.topic_id
    where progress.student_id=$1 and progress.status='ACTIVE'
    order by progress.first_offered_at,topic.position,topic.id
    for update of progress
    limit 3
  `,[target.student_id])).rows;
  for(let index=0;index<reusable.length;index+=1){
    await client.query(`insert into speaking_group_cycle_topics(target_id,topic_id,position,carried_forward)
      values($1,$2,$3,true) on conflict(target_id,topic_id) do nothing`,[target.id,reusable[index].topic_id,index+1]);
  }
  const missing=Math.max(0,3-reusable.length);
  // Match the smallint column explicitly in both contexts. Comparing an
  // untyped $2 with integer zero otherwise conflicts with column inference.
  return (await client.query(`update speaking_topic_targets set requested_topic_count=$2::smallint,
    status=case when $2::smallint=0::smallint then 'READY' else 'PENDING' end,updated_at=now()
    where id=$1 returning *`,[target.id,missing])).rows[0];
}

export async function ensureSpeakingCycle({ cycleDate, cycleDay }, dependencies = {}) {
  const withClient = dependencies.withSupabaseClient || withSupabaseClient;
  return withClient(async (client) => {
    // Persist the scheduled cycle independently of target preparation. A
    // failed reuse query must leave a visible, retryable cycle rather than
    // making the whole scheduled run disappear from diagnostics.
    const cycle = (await client.query(`
      insert into speaking_topic_cycles(cycle_date,cycle_day,status,started_at,last_error_code)
      values($1,$2,'OPEN',now(),'CYCLE_INITIALIZATION_PENDING')
      on conflict(cycle_date) do update set updated_at=now()
      returning *
    `, [cycleDate, cycleDay])).rows[0];
    await client.query("begin");
    try {
      const candidates = (await client.query(`
        with active_enrolments as (
          select distinct on (e.student_id) e.*, s.full_name, lower(trim(s.email)) student_email,
            coalesce(nullif(trim(s.whatsapp_number),''),nullif(trim(s.phone),'')) student_phone,
            lower(trim(s.student_type)) student_type,
            t.full_name teacher_name, lower(trim(t.email)) teacher_email,
            coalesce(nullif(trim(t.whatsapp_number),''),nullif(trim(t.phone),'')) teacher_phone,
            p.approved_summary, p.approved_at profile_approved_at
          from enrollments e join students s on s.id=e.student_id
          left join teachers t on t.id=e.teacher_id
          left join student_speaking_profiles p on p.student_id=s.id
          where s.active is true and upper(trim(s.status))='ACTIVE'
            and e.active is true and upper(trim(e.status))='ACTIVE'
            and lower(trim(s.student_type)) in ('group','private','ielts')
          order by e.student_id, coalesce(e.start_date,e.created_at::date) desc, e.created_at desc
        ), latest_submission as (
          select distinct on (si.student_id) si.student_id, si.id submission_id, si.level, si.module, si.unit, si.day,
            concat(
              coalesce(si.level,''),
              '_M',coalesce(si.module::text,''),
              '_U',coalesce(si.unit::text,''),
              '_D',coalesce(si.day::text,'')
            ) lesson_key
          from submission_inbox si
          where upper(coalesce(si.status,'')) in ('LATEST_VALID','IMPORTED')
            and upper(coalesce(si.skill_type,''))='ASSIGNMENT'
          order by si.student_id, si.submitted_at desc, si.created_at desc
        )
        select ae.*, ls.submission_id, coalesce(ls.level,ae.level) current_level,
          coalesce(ls.module,'1') current_module, coalesce(ls.unit,'1') current_unit,
          coalesce(ls.day,'1') current_day, ls.lesson_key
        from active_enrolments ae left join latest_submission ls on ls.student_id=ae.student_id
      `)).rows;

      for (const row of candidates) {
        if (row.student_type === "ielts") continue;
        if (cycleDay === "FRIDAY" && row.student_type !== "group") continue;
        const profileMissing = !clean(row.approved_summary);
        const generationBasis = profileMissing ? (row.student_type === "group" ? "profile_missing" : "temporary_level") : "approved_profile";
        const status = profileMissing && row.student_type === "group" ? "PROFILE_MISSING" : "PENDING";
        const curriculum = {
          level: row.current_level || row.level,
          module: row.current_module,
          unit: row.current_unit,
          day: row.current_day,
          lesson_key: row.lesson_key || `${row.level}_M1_U1_D1`,
          first_week_basis: !row.submission_id,
          student_email: row.student_email,
          student_phone: row.student_phone || "",
          teacher_name: row.teacher_name || "",
          teacher_email: row.teacher_email || "",
          teacher_phone: row.teacher_phone || ""
        };
        const insertedTarget=(await client.query(`
          insert into speaking_topic_targets(cycle_id,target_type,student_id,enrollment_id,teacher_id,
            student_name_snapshot,generation_basis,profile_summary_snapshot,profile_approved_at_snapshot,
            curriculum_snapshot,source_submission_id,status,requested_topic_count)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
          on conflict do nothing
          returning *
        `, [cycle.id,row.student_type,row.student_id,row.id,row.student_type === "private" ? row.teacher_id : null,
          row.full_name,generationBasis,profileMissing ? null : row.approved_summary,profileMissing ? null : row.profile_approved_at,
          JSON.stringify(curriculum),row.submission_id || null,status,row.student_type === "group" && !profileMissing ? 3 : null])).rows[0];
        if(insertedTarget?.target_type === "group")await prepareGroupTopicReuse_(client,insertedTarget);
      }

      if (cycleDay === "MONDAY" && candidates.some((row) => row.student_type === "ielts")) {
        await client.query(`insert into speaking_topic_targets(cycle_id,target_type,generation_basis,status,curriculum_snapshot)
          values($1,'ielts_shared','ielts_shared','PENDING','{}'::jsonb) on conflict do nothing`, [cycle.id]);
      }
      await client.query(`update speaking_topic_cycles set
        status=case when status='BLOCKED' then 'OPEN' else status end,
        last_error_code=null,updated_at=now()
        where id=$1 and last_error_code in ('CYCLE_INITIALIZATION_PENDING','CYCLE_INITIALIZATION_FAILED')`, [cycle.id]);
      await client.query("commit");
      return { cycle, candidate_count: candidates.length };
    } catch (error) {
      await client.query("rollback");
      await client.query(`update speaking_topic_cycles set
        status=case when status='COMPLETED' then status else 'BLOCKED' end,
        last_error_code='CYCLE_INITIALIZATION_FAILED',updated_at=now()
        where id=$1`, [cycle.id]).catch(() => {});
      error.cycleId = cycle.id;
      error.message = `Speaking cycle ${cycleDate} (${cycle.id}) initialization failed: ${error.message}`;
      throw error;
    }
  });
}

export async function claimGenerationBatch({ cycleId, groupLimit = 10 }) {
  return withSupabaseClient(async (client) => {
    await client.query("begin");
    try {
      let rows = (await client.query(`
        select t.*,
          coalesce((select jsonb_agg(distinct topic.theme)
            from speaking_group_cycle_topics map
            join speaking_topics topic on topic.id=map.topic_id
            where map.target_id=t.id),'[]'::jsonb) carried_theme_codes,
          coalesce((select jsonb_agg(x.fingerprint order by x.generated_at desc) from (
            select st.fingerprint, st.generated_at from speaking_topics st
            join speaking_topic_targets old on old.id=st.target_id
            where old.student_id=t.student_id and old.status='READY'
            order by st.generated_at desc limit 24
          ) x),'[]'::jsonb) recent_fingerprints
        from speaking_topic_targets t
        where t.cycle_id=$1 and t.target_type='group'
          and t.status in ('PENDING','RETRY_WAIT') and coalesce(t.next_attempt_at,now())<=now()
        order by t.attempt_count,t.created_at for update skip locked
        limit least($2,case when exists(select 1 from speaking_topic_targets x where x.cycle_id=$1 and x.target_type='group' and x.last_error_code='BATCH_SPLIT_REQUIRED' and x.status in('PENDING','RETRY_WAIT')) then 5 else $2 end)
      `, [cycleId, groupLimit])).rows;
      let kind = "group";
      if (!rows.length) {
        rows = (await client.query(`
          select t.*,
            coalesce((select jsonb_agg(x.fingerprint order by x.generated_at desc) from (
              select st.fingerprint, st.generated_at from speaking_topics st
              join speaking_topic_targets old on old.id=st.target_id
              where (old.student_id=t.student_id or (t.target_type='ielts_shared' and old.target_type='ielts_shared')) and old.status='READY'
              order by st.generated_at desc limit case when t.target_type='ielts_shared' then 40 else 24 end
            ) x),'[]'::jsonb) recent_fingerprints
          from speaking_topic_targets t
          where t.cycle_id=$1 and t.target_type in ('private','ielts_shared')
            and t.status in ('PENDING','RETRY_WAIT') and coalesce(t.next_attempt_at,now())<=now()
          order by case when t.target_type='ielts_shared' then 2 else 1 end,t.student_name_snapshot nulls last
          for update skip locked
        `, [cycleId])).rows;
        kind = "private_ielts";
      }
      if (rows.length) await client.query("update speaking_topic_targets set status='GENERATING' where id=any($1::uuid[])", [rows.map((row) => row.id)]);
      await client.query("commit");
      return { kind, targets: rows };
    } catch (error) { await client.query("rollback"); throw error; }
  });
}

export async function loadGrammarCatalogue(targets, dependencies = {}) {
  const requested = targets.filter((target) => target.target_type !== "ielts_shared").map((target) => ({
    target_id: target.id,
    level: clean(target.curriculum_snapshot?.level),
    module: clean(target.curriculum_snapshot?.module),
    unit: clean(target.curriculum_snapshot?.unit),
    day: clean(target.curriculum_snapshot?.day),
    lesson_key: clean(target.curriculum_snapshot?.lesson_key),
    first_week_basis: Boolean(target.curriculum_snapshot?.first_week_basis)
  }));
  if (!requested.length) return { grammarCatalogue: [], targets: [...targets], unresolvedTargets: [] };

  const useClient = dependencies.withSupabaseClient || withSupabaseClient;
  const row = await useClient(async (client) => (await client.query(`
    with requested as (
      select *
      from jsonb_to_recordset($1::jsonb) as x(
        target_id text,
        level text,
        module text,
        unit text,
        day text,
        lesson_key text,
        first_week_basis boolean
      )
    ), exact_bounds as (
      select r.target_id, matched.lesson_order
      from requested r
      left join lateral (
        select gc.lesson_order
        from grammar_context gc
        where coalesce(gc.active,true)=true
          and upper(coalesce(gc.level::text,''))=upper(coalesce(r.level,''))
          and (
            lower(trim(coalesce(gc.lesson_key::text,'')))=lower(trim(coalesce(r.lesson_key,'')))
            or (
              regexp_replace(coalesce(gc.module::text,''),'[^0-9]','','g')=regexp_replace(coalesce(r.module,''),'[^0-9]','','g')
              and regexp_replace(coalesce(gc.unit::text,''),'[^0-9]','','g')=regexp_replace(coalesce(r.unit,''),'[^0-9]','','g')
              and regexp_replace(coalesce(gc.day::text,''),'[^0-9]','','g')=regexp_replace(coalesce(r.day,''),'[^0-9]','','g')
            )
          )
        order by gc.lesson_order desc nulls last
        limit 1
      ) matched on true
    ), first_week_bounds as (
      select upper(coalesce(gc.level::text,'')) level, max(gc.lesson_order) max_order
      from grammar_context gc
      where coalesce(gc.active,true)=true
        and regexp_replace(coalesce(gc.module::text,''),'[^0-9]','','g')='1'
        and regexp_replace(coalesce(gc.unit::text,''),'[^0-9]','','g')='1'
      group by upper(coalesce(gc.level::text,''))
    ), target_bounds as (
      select r.target_id,
        case
          when r.first_week_basis then fw.max_order
          else coalesce(exact.lesson_order,fw.max_order)
        end grammar_max_order,
        case
          when not r.first_week_basis and exact.lesson_order is not null then 'latest_valid_submission'
          else 'first_week'
        end grammar_basis
      from requested r
      left join exact_bounds exact on exact.target_id=r.target_id
      left join first_week_bounds fw on fw.level=upper(coalesce(r.level,''))
    ), level_bounds as (
      select upper(coalesce(r.level,'')) level, max(bounds.grammar_max_order) max_order
      from requested r
      join target_bounds bounds on bounds.target_id=r.target_id
      where bounds.grammar_max_order is not null
      group by upper(coalesce(r.level,''))
    ), catalogue as (
      select gc.level, gc.lesson_key, gc.lesson_order, gc.current_lesson_grammar grammar
      from grammar_context gc
      join level_bounds bounds on bounds.level=upper(coalesce(gc.level::text,''))
      where coalesce(gc.active,true)=true
        and gc.lesson_order<=bounds.max_order
        and nullif(trim(gc.current_lesson_grammar),'') is not null
    )
    select
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'level',level,
            'lesson_key',lesson_key,
            'lesson_order',lesson_order,
            'grammar',grammar
          ) order by upper(level),lesson_order,lesson_key
        )
        from catalogue
      ),'[]'::jsonb) grammar_catalogue,
      coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'target_id',target_id,
            'grammar_max_order',grammar_max_order,
            'grammar_basis',grammar_basis
          ) order by target_id
        )
        from target_bounds
      ),'[]'::jsonb) target_bounds
  `, [JSON.stringify(requested)])).rows[0] || {});

  const boundsByTarget = new Map((Array.isArray(row.target_bounds) ? row.target_bounds : []).map((bound) => [clean(bound.target_id),bound]));
  const enrichedTargets = [];
  const unresolvedTargets = [];
  for (const target of targets) {
    if (target.target_type === "ielts_shared") {
      enrichedTargets.push(target);
      continue;
    }
    const bound = boundsByTarget.get(clean(target.id));
    if (!bound || bound.grammar_max_order === null || bound.grammar_max_order === undefined || clean(bound.grammar_max_order) === "") {
      unresolvedTargets.push(target);
      continue;
    }
    enrichedTargets.push({
      ...target,
      curriculum_snapshot: {
        ...(target.curriculum_snapshot || {}),
        grammar_max_order: bound.grammar_max_order,
        grammar_basis: clean(bound.grammar_basis) || "first_week"
      }
    });
  }
  return {
    grammarCatalogue: Array.isArray(row.grammar_catalogue) ? row.grammar_catalogue : [],
    targets: enrichedTargets,
    unresolvedTargets
  };
}

export async function beginGenerationAttempts({ batchKey, targets, model }) {
  return withSupabaseClient(async (client) => {
    for (let index=0; index<targets.length; index+=1) {
      const target=targets[index];
      await client.query(`insert into speaking_topic_generation_attempts(batch_key,batch_position,target_id,attempt_number,model,status,started_at)
        values($1,$2,$3,$4,$5,'RUNNING',now())`, [batchKey,index+1,target.id,Number(target.attempt_count||0)+1,model]);
    }
  });
}

export async function recoverStaleGenerationAttempts({ cycleId, staleMinutes = 30 }) {
  const parsed = Number(staleMinutes);
  const safeMinutes = Number.isInteger(parsed) && parsed >= 5 && parsed <= 1440 ? parsed : 30;
  return withSupabaseClient(async (client) => {
    await client.query("begin");
    try {
      const stale = (await client.query(`
        select a.id attempt_id,a.target_id
        from speaking_topic_generation_attempts a
        join speaking_topic_targets t on t.id=a.target_id
        where t.cycle_id=$1 and t.status='GENERATING' and a.status='RUNNING'
          and a.started_at<=now()-($2::integer*interval '1 minute')
        for update of a,t skip locked
      `,[cycleId,safeMinutes])).rows;
      if (!stale.length) {
        await client.query("commit");
        return { recovered: 0, stale_minutes: safeMinutes };
      }
      const attemptIds=stale.map((row)=>row.attempt_id);
      const targetIds=[...new Set(stale.map((row)=>row.target_id))];
      await client.query(`update speaking_topic_generation_attempts
        set status='FAILED_RETRYABLE',completed_at=now(),retry_after=now(),
          failure_code='STALE_ATTEMPT_RECOVERED',
          failure_summary='The worker stopped before completing this generation attempt; the target was returned to the next batch.'
        where id=any($1::uuid[])`,[attemptIds]);
      const recovered=(await client.query(`update speaking_topic_targets
        set status='RETRY_WAIT',attempt_count=attempt_count+1,next_attempt_at=now(),
          last_error_code='STALE_ATTEMPT_RECOVERED'
        where id=any($1::uuid[]) and status='GENERATING'
        returning id,target_type`,[targetIds])).rows;
      await client.query("commit");
      return { recovered: recovered.length, stale_minutes: safeMinutes, targets: recovered };
    } catch(error) { await client.query("rollback"); throw error; }
  });
}

export async function saveGeneratedTarget({ batchKey, target, topics, usage = {} }) {
  return withSupabaseClient(async (client) => {
    await client.query("begin");
    try {
      let nextPosition=1;
      if(target.target_type==="group"){
        nextPosition=Number((await client.query("select coalesce(max(position),0)::int position from speaking_group_cycle_topics where target_id=$1",[target.id])).rows[0]?.position||0)+1;
      }
      for (let index=0; index<topics.length; index+=1) {
        const topic=topics[index];
        const position=target.target_type==="group"?nextPosition+index:index+1;
        const inserted=(await client.query(`insert into speaking_topics(target_id,position,title,learner_content,teacher_sections,theme,fingerprint,history_metadata)
          values($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb) returning *`,
          [target.id,position,topic.title,JSON.stringify(topic.learner_content),JSON.stringify(topic.teacher_sections),topic.theme,topic.fingerprint,JSON.stringify(topic.history_metadata||{})])).rows[0];
        if(target.target_type==="group"){
          await client.query(`insert into speaking_group_topic_progress(topic_id,student_id,status,level_snapshot,profile_approved_at_snapshot,first_offered_at,last_offered_at,created_at,updated_at)
            values($1,$2,'ACTIVE',$3,$4,now(),now(),now(),now())`,[inserted.id,target.student_id,clean(target.curriculum_snapshot?.level).toUpperCase(),target.profile_approved_at_snapshot||null]);
          await client.query(`insert into speaking_group_cycle_topics(target_id,topic_id,position,carried_forward)
            values($1,$2,$3,false)`,[target.id,inserted.id,position]);
        }
      }
      if(target.target_type==="group"){
        const count=Number((await client.query("select count(*)::int count from speaking_group_cycle_topics where target_id=$1",[target.id])).rows[0]?.count||0);
        if(count!==3)throw new Error(`Group target ${target.id} has ${count} active topics instead of 3.`);
      }
      await client.query("update speaking_topic_targets set status='READY',attempt_count=attempt_count+1,next_attempt_at=null,last_error_code=null where id=$1",[target.id]);
      await client.query(`update speaking_topic_generation_attempts set status='SUCCEEDED',completed_at=now(),input_tokens=$3,output_tokens=$4,reasoning_tokens=$5,total_tokens=$6 where batch_key=$1 and target_id=$2`,
        [batchKey,target.id,usage.prompt_tokens||usage.input_tokens||0,usage.completion_tokens||usage.output_tokens||0,usage.reasoning_tokens||0,usage.total_tokens||0]);
      await client.query("commit");
    } catch(error){await client.query("rollback");throw error;}
  });
}

export async function failGeneratedTarget({ batchKey, targetId, retryMinutes, code, summary }) {
  return withSupabaseClient(async (client) => {
    const next=retryDate(retryMinutes);
    await client.query("update speaking_topic_targets set status='RETRY_WAIT',attempt_count=attempt_count+1,next_attempt_at=$2,last_error_code=$3 where id=$1",[targetId,next,code]);
    await client.query(`update speaking_topic_generation_attempts set status=$3,completed_at=now(),retry_after=$4,failure_code=$5,failure_summary=$6 where batch_key=$1 and target_id=$2`,
      [batchKey,targetId,code === "INVALID_RESPONSE" ? "INVALID_RESPONSE" : "FAILED_RETRYABLE",next,code,clean(summary).slice(0,500)]);
  });
}

export function createBatchKey() { return crypto.randomUUID(); }

export async function listOpenCycles() {
  return withSupabaseClient(async (client) => (await client.query(`select * from speaking_topic_cycles where status<>'COMPLETED' order by cycle_date`)).rows);
}

export async function queueDueGroupEmails({ cycleId, scheduledFor }) {
  return withSupabaseClient(async (client) => {
    const rows=(await client.query(`
      select t.*,s.email student_email,s.full_name student_name
      from speaking_topic_targets t join students s on s.id=t.student_id
      where t.cycle_id=$1 and t.target_type='group' and t.status in ('READY','PROFILE_MISSING')
        and not exists(select 1 from speaking_topic_email_deliveries d where d.target_id=t.id)
      order by s.full_name
    `,[cycleId])).rows;
    for(const row of rows){
      const kind=row.status==='PROFILE_MISSING'?'PROFILE_REMINDER':'TOPICS';
      const sourceType=kind==='TOPICS'?'SPEAKING_GROUP_TOPICS':'SPEAKING_PROFILE_REMINDER';
      await client.query("begin");
      try{
        if(kind==='TOPICS'){
          const topicCount=Number((await client.query("select count(*)::int count from speaking_group_cycle_topics where target_id=$1",[row.id])).rows[0]?.count||0);
          if(topicCount!==3)throw new Error(`Group target ${row.id} cannot be emailed with ${topicCount} topics.`);
        }
        const delivery=(await client.query(`insert into speaking_topic_email_deliveries(target_id,student_id,delivery_kind,idempotency_key,scheduled_for)
          values($1,$2,$3,$4,$5) returning *`,[row.id,row.student_id,kind,`speaking:${row.id}:${kind.toLowerCase()}`,scheduledFor])).rows[0];
        const email=(await client.query(`insert into email_queue(scheduled_for,source_type,source_id,recipient_role,recipient_email,recipient_name,student_id,status,idempotency_key,subject,body_html,body_text,payload_json)
          values($1,$2,$3,'student',$4,$5,$6,'QUEUED',$7,null,null,null,null) returning *`,
          [scheduledFor,sourceType,delivery.id,row.student_email,studentFacingName(row.student_name,row.student_email),row.student_id,`speaking:${row.id}:${kind.toLowerCase()}`])).rows[0];
        await client.query("update speaking_topic_email_deliveries set email_queue_id=$2,queued_at=now() where id=$1",[delivery.id,email.id]);
        if(kind==='TOPICS')await client.query(`update speaking_group_topic_progress progress set delivery_count=delivery_count+1,last_offered_at=now(),updated_at=now()
          from speaking_group_cycle_topics map where map.target_id=$1 and map.topic_id=progress.topic_id`,[row.id]);
        await client.query("commit");
      }catch(error){await client.query("rollback");if(error.code!=="23505")throw error;}
    }
    return { queued: rows.length };
  });
}

export async function loadSpeakingEmailSource(sourceType, sourceId, queuePayload = null) {
  return withSupabaseClient(async (client) => {
    if(sourceType==='SPEAKING_TEACHER_MATERIALS'){
      const payload=typeof queuePayload==='string'?JSON.parse(queuePayload):queuePayload;
      const jobIds=Array.isArray(payload?.document_job_ids)?payload.document_job_ids:[];
      if(!jobIds.length||!jobIds.includes(sourceId))throw new Error("Speaking teacher bundle has no valid document-job snapshot.");
      const jobs=(await client.query(`select * from speaking_teacher_document_jobs where id=any($1::uuid[])`,[jobIds])).rows;
      if(jobs.length!==new Set(jobIds).size)throw new Error("A speaking teacher bundle document no longer exists.");
      if(jobs.some((job)=>!['PDF_READY','EMAIL_QUEUED','COMPLETED'].includes(job.status)||!clean(job.pdf_drive_url)||!clean(job.pdf_filename))){
        throw new Error("A speaking teacher bundle document is not ready.");
      }
      const liveById=new Map(jobs.map((job)=>[job.id,job]));
      return{
        ...payload,
        documents:(payload.documents||[]).map((document)=>{
          const live=liveById.get(document.job_id);
          if(!live)throw new Error("Speaking teacher bundle metadata does not match its document jobs.");
          return{...document,pdf_drive_url:live.pdf_drive_url,pdf_filename:live.pdf_filename};
        })
      };
    }
    const target=(await client.query(`select t.*,d.email_queue_id,s.full_name student_name,s.email student_email,s.whatsapp_number,s.phone
      from speaking_topic_email_deliveries d
      join speaking_topic_targets t on t.id=d.target_id
      join students s on s.id=t.student_id
      where d.id=$1`,[sourceId])).rows[0];
    if(!target)return null;
    if(sourceType==='SPEAKING_GROUP_TOPICS'){
      if(target.target_type!=='group')throw new Error("A group speaking-topic email must reference a group target.");
      target.topics=(await client.query(`select topic.id,map.target_id,map.position,topic.title,topic.learner_content,topic.teacher_sections,topic.theme,topic.fingerprint,topic.history_metadata,topic.generated_at,topic.created_at,topic.updated_at
        from speaking_group_cycle_topics map join speaking_topics topic on topic.id=map.topic_id
        where map.target_id=$1 order by map.position`,[target.id])).rows;
      if(target.topics.length!==3)throw new Error(`Group target ${target.id} cannot be emailed with ${target.topics.length} topics.`);
      const token=createSpeakingTopicResponseToken();
      await client.query(`insert into speaking_group_topic_response_sessions(target_id,student_id,access_token_hash,status,version,created_at,updated_at)
        values($1,$2,$3,'OPEN',1,now(),now())
        on conflict(target_id) do update set access_token_hash=excluded.access_token_hash,updated_at=now()`,[target.id,target.student_id,token.hash]);
      target.topic_response_url=speakingTopicResponseUrl(token.raw);
    }else if(sourceType==='SPEAKING_PROFILE_REMINDER'){
      if(target.target_type!=='group')throw new Error("A speaking-profile reminder must reference a group target.");
      target.topics=[];
    }else target.topics=(await client.query("select * from speaking_topics where target_id=$1 order by position",[target.id])).rows;
    return target;
  });
}

export async function groupEmailsComplete(cycleId) {
  return withSupabaseClient(async (client) => {
    const row=(await client.query(`select count(*)::int expected,count(*) filter(where eq.status='SENT')::int sent
      from speaking_topic_targets t left join speaking_topic_email_deliveries d on d.target_id=t.id left join email_queue eq on eq.id=d.email_queue_id
      where t.cycle_id=$1 and t.target_type='group'`,[cycleId])).rows[0];
    return row.expected===row.sent;
  });
}

export async function markCycleRoutingError(cycleId,levels){
  const normalised=[...new Set((levels||[]).map((level)=>clean(level).toUpperCase()).filter(Boolean))];
  return withSupabaseClient(async(client)=>(await client.query(
    `update speaking_topic_cycles set status='BLOCKED',last_error_code='UNROUTED_GROUP_LEVELS',updated_at=now() where id=$1 returning *`,
    [cycleId]
  )).rows[0]||{id:cycleId,unrouted_levels:normalised});
}

export async function clearCycleRoutingError(cycleId){
  return withSupabaseClient(async(client)=>(await client.query(
    `update speaking_topic_cycles set status=case when status='BLOCKED' and last_error_code='UNROUTED_GROUP_LEVELS' then 'READY_FOR_TEACHER_BUILD' else status end,last_error_code=case when last_error_code='UNROUTED_GROUP_LEVELS' then null else last_error_code end,updated_at=now() where id=$1 returning *`,
    [cycleId]
  )).rows[0]||null);
}

export async function loadDocumentCandidates({ cycleId, scope, teacherId = null, onlyUndocumented = false }) {
  return withSupabaseClient(async (client) => {
    if(scope==='group') return (await client.query(`select t.*,s.full_name,s.whatsapp_number,s.phone,e.level from speaking_topic_targets t join students s on s.id=t.student_id join enrollments e on e.id=t.enrollment_id where t.cycle_id=$1 and t.target_type='group' and t.status in('READY','PROFILE_MISSING') order by case upper(e.level) when 'A1' then 1 when 'A2' then 2 when 'B1' then 3 when 'B2' then 4 else 9 end,s.full_name`,[cycleId])).rows;
    const privateRows=(await client.query(`select t.*,s.full_name,s.whatsapp_number,s.phone,e.level from speaking_topic_targets t join students s on s.id=t.student_id join enrollments e on e.id=t.enrollment_id where t.cycle_id=$1 and t.target_type='private' and t.teacher_id=$2 ${onlyUndocumented?"and not exists(select 1 from speaking_teacher_document_targets dt join speaking_teacher_document_jobs j on j.id=dt.document_job_id where dt.target_id=t.id and j.status in('EMAIL_QUEUED','COMPLETED'))":""} order by case upper(e.level) when 'A1' then 1 when 'A2' then 2 when 'B1' then 3 when 'B2' then 4 else 9 end,s.full_name`,[cycleId,teacherId])).rows;
    const ielts=(await client.query(`select t.* from speaking_topic_targets t where t.cycle_id=$1 and t.target_type='ielts_shared' and exists(select 1 from enrollments e join students s on s.id=e.student_id where e.teacher_id=$2 and e.active is true and upper(e.status)='ACTIVE' and s.active is true and upper(s.status)='ACTIVE' and lower(s.student_type)='ielts') limit 1`,[cycleId,teacherId])).rows[0]||null;
    const ieltsStudents=(await client.query(`select s.full_name,s.whatsapp_number,s.phone from enrollments e join students s on s.id=e.student_id where e.teacher_id=$1 and e.active is true and upper(e.status)='ACTIVE' and s.active is true and upper(s.status)='ACTIVE' and lower(s.student_type)='ielts' order by s.full_name`,[teacherId])).rows;
    return { privateRows, ielts, ieltsStudents };
  });
}

export async function listAssignedTeachersForCycle(cycleId) {
  return withSupabaseClient(async(client)=>(await client.query(`select distinct t.id,t.full_name,t.email from teachers t where t.active is true and upper(t.status)='ACTIVE' and (exists(select 1 from speaking_topic_targets st where st.cycle_id=$1 and st.target_type='private' and st.teacher_id=t.id) or exists(select 1 from enrollments e join students s on s.id=e.student_id where e.teacher_id=t.id and e.active is true and upper(e.status)='ACTIVE' and s.active is true and upper(s.status)='ACTIVE' and lower(s.student_type)='ielts')) order by t.full_name`,[cycleId])).rows);
}

async function loadTopicsForTargets_(client,targetIds){
  if(!targetIds.length)return[];
  return (await client.query(`select * from (
    select topic.id,map.target_id,map.position,topic.title,topic.learner_content,topic.teacher_sections,topic.theme,topic.fingerprint,topic.history_metadata,topic.generated_at,topic.created_at,topic.updated_at
    from speaking_group_cycle_topics map
    join speaking_topics topic on topic.id=map.topic_id
    where map.target_id=any($1::uuid[])
    union all
    select topic.id,topic.target_id,topic.position,topic.title,topic.learner_content,topic.teacher_sections,topic.theme,topic.fingerprint,topic.history_metadata,topic.generated_at,topic.created_at,topic.updated_at
    from speaking_topics topic
    join speaking_topic_targets target on target.id=topic.target_id
    where topic.target_id=any($1::uuid[]) and target.target_type<>'group'
  ) selected order by target_id,position`,[targetIds])).rows;
}

export async function loadTopicsForTargets(targetIds) {
  if(!targetIds.length)return [];
  return withSupabaseClient((client)=>loadTopicsForTargets_(client,targetIds));
}

export async function createDocumentJob({ cycleId, scope, teacherId, audience, recipientCount, partNumber, totalParts, rangeLabel, targetIds }) {
  return withSupabaseClient(async(client)=>{
    await client.query("begin");
    try{
      if(scope==='assigned_teacher') await client.query("update speaking_teacher_document_jobs set total_parts=greatest(total_parts,$3) where cycle_id=$1 and teacher_id=$2",[cycleId,teacherId,totalParts]);
      const job=(await client.query(`insert into speaking_teacher_document_jobs(cycle_id,document_scope,teacher_id,audience_snapshot,recipient_count,part_number,total_parts,entry_range_label,status)
        values($1,$2,$3,$4::jsonb,$5,$6,$7,$8,'PENDING') returning *`,[cycleId,scope,teacherId||null,JSON.stringify(audience),recipientCount,partNumber,totalParts,rangeLabel])).rows[0];
      for(let i=0;i<targetIds.length;i+=1) await client.query("insert into speaking_teacher_document_targets(document_job_id,target_id,display_order) values($1,$2,$3)",[job.id,targetIds[i],i+1]);
      await client.query("commit");return job;
    }catch(error){await client.query("rollback");if(error.code==='23505')return null;throw error;}
  });
}

export async function listPendingDocumentJobs({retryMinutes=5}={}){return withSupabaseClient(async(client)=>(await client.query("select * from speaking_teacher_document_jobs where status='PENDING' or (status='RETRY_WAIT' and updated_at<=now()-($1::int*interval '1 minute')) order by created_at limit 10",[retryMinutes])).rows);}
export async function loadDocumentJobBundle(jobId){return withSupabaseClient(async(client)=>{
  const job=(await client.query("select * from speaking_teacher_document_jobs where id=$1",[jobId])).rows[0];if(!job)return null;
  const cycle=(await client.query("select * from speaking_topic_cycles where id=$1",[job.cycle_id])).rows[0];
  const rows=(await client.query(`select t.*,s.full_name,s.whatsapp_number,s.phone,e.level from speaking_teacher_document_targets dt join speaking_topic_targets t on t.id=dt.target_id left join students s on s.id=t.student_id left join enrollments e on e.id=t.enrollment_id where dt.document_job_id=$1 order by dt.display_order`,[jobId])).rows;
  const topics=rows.length?await loadTopicsForTargets_(client,rows.map(r=>r.id)):[];
  const ielts=rows.find(r=>r.target_type==='ielts_shared')||null;
  const ieltsStudents=job.teacher_id?(await client.query(`select s.full_name,s.whatsapp_number,s.phone from enrollments e join students s on s.id=e.student_id where e.teacher_id=$1 and e.active is true and upper(e.status)='ACTIVE' and s.active is true and upper(s.status)='ACTIVE' and lower(s.student_type)='ielts' order by s.full_name`,[job.teacher_id])).rows:[];
  return{job,cycle,rows,topics,ielts,ieltsStudents};
});}
export async function documentJobState({cycleId,teacherId=null,scope}){return withSupabaseClient(async(client)=>{
  const result=await client.query(`select count(*)::int count,coalesce(max(part_number),0)::int max_part from speaking_teacher_document_jobs where cycle_id=$1 and document_scope=$2 and teacher_id is not distinct from $3`,[cycleId,scope,teacherId]);return result.rows[0];
});}
export async function targetDocumented({cycleId,teacherId,targetId}){return withSupabaseClient(async(client)=>Boolean((await client.query(`select 1 from speaking_teacher_document_targets dt join speaking_teacher_document_jobs j on j.id=dt.document_job_id where j.cycle_id=$1 and j.teacher_id=$2 and dt.target_id=$3 limit 1`,[cycleId,teacherId,targetId])).rowCount));}
export async function updateDocumentJob(jobId, updates={}){return withSupabaseClient(async(client)=>(await client.query(`update speaking_teacher_document_jobs set status=coalesce($2,status),payload_sha256=coalesce($3,payload_sha256),pdf_filename=coalesce($4,pdf_filename),pdfmonkey_document_id=coalesce($5,pdfmonkey_document_id),pdfmonkey_status=coalesce($6,pdfmonkey_status),pdf_download_url=coalesce($7,pdf_download_url),google_drive_file_id=coalesce($8,google_drive_file_id),pdf_drive_url=coalesce($9,pdf_drive_url),render_requested_at=coalesce($10,render_requested_at),rendered_at=coalesce($11,rendered_at),email_queued_at=coalesce($12,email_queued_at),completed_at=coalesce($13,completed_at),last_error_code=$14,last_error_summary=$15 where id=$1 returning *`,[jobId,updates.status||null,updates.payloadSha||null,updates.filename||null,updates.documentId||null,updates.pdfStatus||null,updates.downloadUrl||null,updates.driveFileId||null,updates.driveUrl||null,updates.renderRequestedAt||null,updates.renderedAt||null,updates.emailQueuedAt||null,updates.completedAt||null,updates.errorCode||null,updates.errorSummary||null])).rows[0]);}

function speakingLevelRank(level){
  const order=["A1","A2","B1","B2"];
  const index=order.indexOf(clean(level).toUpperCase());
  return index<0?99:index;
}

export function buildTeacherRecipientBundles({jobs,teacherDirectory=[]}){
  const directory=new Map(teacherDirectory.map((teacher)=>[clean(teacher.email).toLowerCase(),teacher]));
  const bundles=new Map();
  const recipient=(email)=>{
    const key=clean(email).toLowerCase();
    if(!key)throw new Error("A speaking teacher document has an empty recipient email.");
    if(!bundles.has(key)){
      const teacher=directory.get(key)||{};
      bundles.set(key,{recipient_email:key,recipient_name:clean(teacher.full_name),teacher_id:teacher.id||null,documents:[]});
    }
    return bundles.get(key);
  };

  for(const job of jobs){
    const audience=job.audience_snapshot||{};
    if(job.document_scope==="group"){
      const emails=Array.isArray(audience.recipient_emails)
        ? [...new Set(audience.recipient_emails.map((email)=>clean(email).toLowerCase()).filter(Boolean))]
        : [];
      if(!emails.length)throw new Error(`Group speaking document ${job.id} has no routed recipients.`);
      const document={
        job_id:job.id,
        material_type:"GROUP",
        level:clean(audience.group_level).toUpperCase(),
        part_number:Number(job.part_number),
        total_parts:Number(job.total_parts),
        student_count:Number(audience.student_count||0),
        coverage_start:clean(audience.alphabetical_start),
        coverage_end:clean(audience.alphabetical_end),
        pdf_drive_url:clean(job.pdf_drive_url),
        pdf_filename:clean(job.pdf_filename)
      };
      for(const email of emails)recipient(email).documents.push(document);
    }else{
      const bundle=recipient(audience.teacher_email);
      if(clean(audience.teacher_name))bundle.recipient_name=clean(audience.teacher_name);
      bundle.teacher_id=job.teacher_id||bundle.teacher_id;
      bundle.documents.push({
        job_id:job.id,
        material_type:"ASSIGNED",
        has_private:Boolean(audience.has_private),
        has_ielts:Boolean(audience.has_ielts),
        private_student_names:Array.isArray(audience.private_student_names)?audience.private_student_names:[],
        ielts_student_names:Array.isArray(audience.ielts_student_names)?audience.ielts_student_names:[],
        pdf_drive_url:clean(job.pdf_drive_url),
        pdf_filename:clean(job.pdf_filename)
      });
    }
  }

  for(const bundle of bundles.values()){
    bundle.documents=[...new Map(bundle.documents.map((document)=>[document.job_id,document])).values()].sort((a,b)=>{
      if(a.material_type!==b.material_type)return a.material_type==="GROUP"?-1:1;
      if(a.material_type==="GROUP")return speakingLevelRank(a.level)-speakingLevelRank(b.level)||a.part_number-b.part_number;
      return 0;
    });
  }
  return [...bundles.values()].sort((a,b)=>a.recipient_email.localeCompare(b.recipient_email));
}

export async function queueReadyTeacherDocumentBundles({cycleId}){
  return withSupabaseClient(async(client)=>{
    await client.query("begin");
    try{
      await client.query("select pg_advisory_xact_lock(hashtext($1))",[`speaking-teacher-bundles:${cycleId}`]);
      const cycle=(await client.query("select *, to_char(cycle_date, 'YYYY-MM-DD') as cycle_date_iso from speaking_topic_cycles where id=$1::uuid",[cycleId])).rows[0];
      if(!cycle){await client.query("commit");return{queued:0,status:"CYCLE_NOT_FOUND"};}
      const jobs=(await client.query("select * from speaking_teacher_document_jobs where cycle_id=$1::uuid order by document_scope,part_number,id",[cycleId])).rows;
      if(!jobs.length){await client.query("commit");return{queued:0,status:"NO_TEACHER_DOCUMENTS"};}
      const groupLevels=(await client.query(`select distinct upper(coalesce(curriculum_snapshot->>'level','')) level from speaking_topic_targets where cycle_id=$1::uuid and target_type='group' order by 1`,[cycleId])).rows.map((row)=>row.level);
      for(const level of groupLevels){
        const levelJobs=jobs.filter((job)=>job.document_scope==="group"&&clean(job.audience_snapshot?.group_level).toUpperCase()===level);
        const total=Number(levelJobs[0]?.total_parts||0);
        if(!levelJobs.length||levelJobs.length!==total||new Set(levelJobs.map((job)=>Number(job.part_number))).size!==total){
          await client.query("commit");
          return{queued:0,status:"WAITING_FOR_COMPLETE_DOCUMENT_SET",missing_group_level:level};
        }
      }

      if(cycle.cycle_day==="MONDAY"){
        const expectedTeachers=(await client.query(`select distinct teacher.id from teachers teacher where teacher.active is true and upper(teacher.status)='ACTIVE' and (exists(select 1 from speaking_topic_targets target where target.cycle_id=$1::uuid and target.target_type='private' and target.teacher_id=teacher.id) or (exists(select 1 from speaking_topic_targets shared where shared.cycle_id=$1::uuid and shared.target_type='ielts_shared') and exists(select 1 from enrollments enrollment join students student on student.id=enrollment.student_id where enrollment.teacher_id=teacher.id and enrollment.active is true and upper(enrollment.status)='ACTIVE' and student.active is true and upper(student.status)='ACTIVE' and lower(student.student_type)='ielts')))`,[cycleId])).rows.map((row)=>row.id);
        const documented=new Set(jobs.filter((job)=>job.document_scope==="assigned_teacher").map((job)=>job.teacher_id));
        const missing=expectedTeachers.filter((teacherId)=>!documented.has(teacherId));
        if(missing.length){await client.query("commit");return{queued:0,status:"WAITING_FOR_COMPLETE_DOCUMENT_SET",missing_teacher_ids:missing};}
      }

      const routedEmails=[...new Set(jobs.flatMap((job)=>{
        if(job.document_scope==="group"&&Array.isArray(job.audience_snapshot?.recipient_emails))return job.audience_snapshot.recipient_emails;
        if(job.document_scope==="assigned_teacher")return[job.audience_snapshot?.teacher_email];
        return[];
      }).map((email)=>clean(email).toLowerCase()).filter(Boolean))];
      const teacherDirectory=routedEmails.length
        ? (await client.query("select id,full_name,lower(trim(email)) email from teachers where lower(trim(email))=any($1::text[])",[routedEmails])).rows
        : [];
      const bundles=buildTeacherRecipientBundles({jobs,teacherDirectory});
      const queueRows=[];
      const waitingBundles=[];
      const queuedJobIds=new Set();
      const liveJobs=new Map(jobs.map((job)=>[job.id,job]));
      for(const bundle of bundles){
        const waitingJobIds=bundle.documents.map((document)=>liveJobs.get(document.job_id)).filter((job)=>!["PDF_READY","EMAIL_QUEUED","COMPLETED"].includes(job?.status)||!clean(job?.pdf_drive_url)||!clean(job?.pdf_filename)).map((job)=>job?.id).filter(Boolean);
        if(waitingJobIds.length){waitingBundles.push({recipient_email:bundle.recipient_email,waiting_job_ids:waitingJobIds});continue;}
        const anchor=bundle.documents.find((document)=>document.material_type==="GROUP")||bundle.documents[0];
        const idempotencyKey=`speaking-teacher-bundle:${cycleId}:${bundle.recipient_email}`;
        const payload=buildTeacherBundleQueuePayload({cycle,cycleId,bundle});
        const inserted=await client.query(`insert into email_queue(scheduled_for,source_type,source_id,recipient_role,recipient_email,recipient_name,teacher_id,status,idempotency_key,subject,body_html,body_text,payload_json,pdf_drive_url,pdf_filename)
          values(now(),'SPEAKING_TEACHER_MATERIALS',$1::uuid,'teacher',$2,$3,$4::uuid,'QUEUED',$5,null,null,null,$6::jsonb,null,null)
          on conflict(idempotency_key) do nothing
          returning id,status,attempt_count,next_attempt_at,error_code,error_message`,[anchor.job_id,bundle.recipient_email,bundle.recipient_name||null,bundle.teacher_id,idempotencyKey,JSON.stringify(payload)]);
        const queueRow=inserted.rows[0]||(await client.query("select id,status,attempt_count,next_attempt_at,error_code,error_message from email_queue where idempotency_key=$1",[idempotencyKey])).rows[0];
        queueRows.push({...queueRow,recipient_email:bundle.recipient_email,document_count:bundle.documents.length});
        for(const document of bundle.documents)queuedJobIds.add(document.job_id);
      }
      if(queuedJobIds.size)await client.query(`update speaking_teacher_document_jobs set status=case when status='COMPLETED' then status else 'EMAIL_QUEUED' end,email_queued_at=coalesce(email_queued_at,now()),updated_at=now() where id=any($1::uuid[])`,[[...queuedJobIds]]);
      await client.query("commit");
      const hasTerminalFailure=queueRows.some((row)=>row.status==="FAILED");
      const hasRetryWaiting=queueRows.some((row)=>row.status==="FAILED_RETRYABLE");
      const status=waitingBundles.length
        ? "WAITING_FOR_RECIPIENT_PDFS"
        : hasTerminalFailure
          ? "TEACHER_BUNDLE_DELIVERY_FAILED"
          : hasRetryWaiting
            ? "TEACHER_BUNDLE_RETRY_WAIT"
            : "TEACHER_BUNDLES_READY";
      return{queued:queueRows.filter((row)=>row.status==="QUEUED").length,status,bundle_count:bundles.length,bundles:queueRows,waiting_bundles:waitingBundles};
    }catch(error){await client.query("rollback");throw error;}
  });
}

export async function markCycleCompletedIfDone(cycleId){return withSupabaseClient(async(client)=>(await client.query(`
  update speaking_topic_cycles c set status='COMPLETED',completed_at=now()
  where c.id=$1
    and not exists(select 1 from speaking_topic_targets t where t.cycle_id=c.id and t.status not in('READY','PROFILE_MISSING','BLOCKED'))
    and not exists(select 1 from speaking_topic_targets t left join speaking_topic_email_deliveries d on d.target_id=t.id left join email_queue q on q.id=d.email_queue_id where t.cycle_id=c.id and t.target_type='group' and coalesce(q.status,'')<>'SENT')
    and (not exists(select 1 from speaking_topic_targets t where t.cycle_id=c.id and t.target_type='group') or exists(select 1 from speaking_teacher_document_jobs j where j.cycle_id=c.id and j.document_scope='group'))
    and not exists(select 1 from speaking_teacher_document_jobs j where j.cycle_id=c.id and j.status not in('COMPLETED','BLOCKED'))
    and not exists(
      select 1 from teachers teacher
      where teacher.active is true and upper(teacher.status)='ACTIVE'
        and (exists(select 1 from speaking_topic_targets st where st.cycle_id=c.id and st.target_type='private' and st.teacher_id=teacher.id)
          or (exists(select 1 from speaking_topic_targets shared where shared.cycle_id=c.id and shared.target_type='ielts_shared')
            and exists(select 1 from enrollments e join students s on s.id=e.student_id where e.teacher_id=teacher.id and e.active is true and upper(e.status)='ACTIVE' and s.active is true and upper(s.status)='ACTIVE' and lower(s.student_type)='ielts')))
        and not exists(select 1 from speaking_teacher_document_jobs j where j.cycle_id=c.id and j.teacher_id=teacher.id)
    )
  returning *`,[cycleId])).rows[0]||null);}
