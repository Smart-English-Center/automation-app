import pg from "pg";

const { Pool } = pg;

let pool = null;

function shouldUseSsl_() {
  const sslMode = String(process.env.PGSSLMODE || "").trim().toLowerCase();
  const databaseUrl = String(process.env.DATABASE_URL || "").trim().toLowerCase();

  if (sslMode === "disable") return false;
  if (sslMode === "require" || sslMode === "prefer") return true;

  return databaseUrl.includes("supabase") || databaseUrl.includes("pooler.supabase");
}

export function isSupabaseConfigured() {
  return Boolean(String(process.env.DATABASE_URL || "").trim());
}

export function getSupabasePool() {
  if (!isSupabaseConfigured()) {
    throw new Error("DATABASE_URL is not configured.");
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.SUPABASE_POOL_MAX || 5),
      idleTimeoutMillis: Number(process.env.SUPABASE_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.SUPABASE_CONNECTION_TIMEOUT_MS || 15000),
      ssl: shouldUseSsl_() ? { rejectUnauthorized: false } : false
    });
  }

  return pool;
}

export async function withSupabaseClient(callback) {
  const client = await getSupabasePool().connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function closeSupabasePool() {
  if (!pool) return;

  await pool.end();
  pool = null;
}
