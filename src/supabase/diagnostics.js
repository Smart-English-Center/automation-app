import { isSupabaseConfigured, withSupabaseClient } from "./client.js";

const FINAL_TABLES = [
  "students",
  "teachers",
  "enrollments",
  "task_catalog",
  "google_response_sources",
  "submission_import_events",
  "submission_inbox",
  "quiz_scores",
  "audio_assets",
  "transcripts",
  "ai_drafts",
  "grammar_context",
  "job_queue",
  "job_attempts",
  "worker_heartbeats",
  "worker_settings",
  "errors",
  "ai_batches",
  "ai_batch_items",
  "final_feedback",
  "email_queue",
  "email_events",
  "email_suppressions",
  "email_templates",
  "email_settings",
  "student_broadcast_messages",
  "student_broadcast_runs",
  "student_broadcast_items",
  "teacher_digest_runs",
  "teacher_digest_pdf_jobs",
];

function emptyDiagnostic_(message) {
  return { ok: false, configured: false, message, checked_at: new Date().toISOString() };
}

export async function getSupabaseHealth() {
  if (!isSupabaseConfigured()) return emptyDiagnostic_("DATABASE_URL is not configured.");
  return withSupabaseClient(async (client) => {
    const result = await client.query(`select now() as database_time, current_database() as database_name, current_schema() as schema_name, current_user as database_user, version() as postgres_version`);
    return { ok: true, configured: true, ...result.rows[0], checked_at: new Date().toISOString() };
  });
}

export async function getSupabaseTableCounts() {
  if (!isSupabaseConfigured()) return emptyDiagnostic_("DATABASE_URL is not configured.");
  return withSupabaseClient(async (client) => {
    const rows = [];
    for (const table of FINAL_TABLES) {
      const exists = await client.query(`select to_regclass($1) as table_name`, [`public.${table}`]);
      if (!exists.rows[0]?.table_name) {
        rows.push({ table_name: table, exists: false, row_count: null });
        continue;
      }
      const count = await client.query(`select count(*)::integer as row_count from public.${table}`);
      rows.push({ table_name: table, exists: true, row_count: count.rows[0]?.row_count ?? 0 });
    }
    return { ok: true, configured: true, tables: rows, checked_at: new Date().toISOString() };
  });
}

export async function getSupabaseDiagnosticReport() {
  const health = await getSupabaseHealth();
  const counts = await getSupabaseTableCounts();
  return { ok: Boolean(health.ok && counts.ok), health, counts, checked_at: new Date().toISOString() };
}
