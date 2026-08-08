import { Pool } from "pg";

const DEFAULT_DB_HOST = "hr-portal-db.c5m4oagyag9k.eu-west-2.rds.amazonaws.com";
const DEFAULT_DB_PORT = 5432;
const DEFAULT_DB_USER = "postgres";
const DEFAULT_DB_NAME = "postgres";
const dbPassword = process.env.DB_PASSWORD;

if (typeof dbPassword !== "string" || dbPassword.length === 0) {
  throw new Error("DB_PASSWORD must be set to a non-empty string for PostgreSQL connections");
}

export const dbConfig = {
  host: process.env.DB_HOST || DEFAULT_DB_HOST,
  port: Number(process.env.DB_PORT || DEFAULT_DB_PORT),
  user: process.env.DB_USER || DEFAULT_DB_USER,
  password: dbPassword,
  database: process.env.DB_NAME || DEFAULT_DB_NAME,
  ssl: { rejectUnauthorized: false }
};

export const pool = new Pool(dbConfig);

const APP_STATE_KEYS = ["users", "sites", "staff", "templates", "instances", "docusignEnvelopes"];

export async function ensureDatabaseSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key text PRIMARY KEY,
      value jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id text PRIMARY KEY,
      action text NOT NULL,
      user_json jsonb,
      timestamp timestamptz NOT NULL,
      details jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
}

export async function loadPersistentState(defaultState) {
  const state = {
    ...defaultState,
    users: defaultState.users || [],
    sites: defaultState.sites || [],
    staff: defaultState.staff || [],
    templates: defaultState.templates || [],
    instances: defaultState.instances || [],
    docusignEnvelopes: defaultState.docusignEnvelopes || [],
    audit: defaultState.audit || []
  };

  const stateResult = await pool.query("SELECT key, value FROM app_state WHERE key = ANY($1::text[])", [APP_STATE_KEYS]);
  for (const row of stateResult.rows) {
    state[row.key] = row.value || state[row.key];
  }

  const auditResult = await pool.query(
    "SELECT id, action, user_json AS user, timestamp, details FROM audit_logs ORDER BY timestamp DESC LIMIT 1000"
  );
  state.audit = auditResult.rows.map((row) => ({
    id: row.id,
    action: row.action,
    user: row.user || null,
    timestamp: row.timestamp,
    details: row.details || {}
  }));

  return { state, hasData: stateResult.rowCount > 0 || auditResult.rowCount > 0 };
}

export async function persistPersistentState(state) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const key of APP_STATE_KEYS) {
      await client.query(
        `
          INSERT INTO app_state (key, value, updated_at)
          VALUES ($1, $2::jsonb, now())
          ON CONFLICT (key)
          DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `,
        [key, JSON.stringify(state[key] || [])]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function appendAuditLog(entry) {
  await pool.query(
    `
      INSERT INTO audit_logs (id, action, user_json, timestamp, details)
      VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)
      ON CONFLICT (id) DO NOTHING
    `,
    [entry.id, entry.action, JSON.stringify(entry.user || null), entry.timestamp, JSON.stringify(entry.details || {})]
  );
}