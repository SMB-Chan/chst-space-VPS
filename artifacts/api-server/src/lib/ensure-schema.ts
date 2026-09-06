export const ENSURE_MESSAGES_SCHEMA_SQL = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sources text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS audit_content text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS audit_model_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS factuality text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS asset_ids text;
`.trim();

export const ENSURE_ASSETS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS artifacts (
  id serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE cascade,
  message_id integer REFERENCES messages(id) ON DELETE cascade,
  user_id text NOT NULL,
  filename text NOT NULL,
  mime text NOT NULL,
  size integer NOT NULL,
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS artifacts_user_id_created_at_idx ON artifacts(user_id, created_at);
CREATE INDEX IF NOT EXISTS artifacts_conversation_id_idx ON artifacts(conversation_id);
CREATE INDEX IF NOT EXISTS artifacts_message_id_idx ON artifacts(message_id);

CREATE TABLE IF NOT EXISTS assets (
  id serial PRIMARY KEY,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id integer REFERENCES messages(id) ON DELETE CASCADE,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size integer NOT NULL,
  data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS assets_conversation_id_idx ON assets(conversation_id);
CREATE INDEX IF NOT EXISTS assets_message_id_idx ON assets(message_id);

-- Assets created by the old two-phase persistence path could be left without
-- a message if chat persistence failed or the server crashed between steps.
-- They are unreachable from conversation history and should not consume quota.
DELETE FROM assets WHERE message_id IS NULL;

-- Existing deployments may still have a legacy message FK that nullifies the
-- reference on delete. Replace that legacy action with CASCADE when necessary;
-- new databases already have CASCADE from the CREATE TABLE above.
DO $$
DECLARE
  current_fk text;
  current_def text;
BEGIN
  SELECT conname, pg_get_constraintdef(oid)
    INTO current_fk, current_def
  FROM pg_constraint
  WHERE conrelid = 'assets'::regclass
    AND contype = 'f'
    AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (message_id)%'
  LIMIT 1;

  IF current_fk IS NOT NULL AND position('ON DELETE CASCADE' in current_def) = 0 THEN
    EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', current_fk);
    current_fk := NULL;
  END IF;

  IF current_fk IS NULL THEN
    ALTER TABLE assets
      ADD CONSTRAINT assets_message_id_messages_id_fk
      FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE;
  END IF;
END $$;
`.trim();

export const ENSURE_ALIBABA_VIDEO_JOBS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS alibaba_video_jobs (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  conversation_id integer NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_message_id integer NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  result_message_id integer REFERENCES messages(id) ON DELETE SET NULL,
  asset_id integer REFERENCES assets(id) ON DELETE SET NULL,
  provider_task_id text NOT NULL,
  provider_request_id text,
  idempotency_key text,
  model_id text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  failure_code text,
  failure_message text,
  attempt_count integer NOT NULL DEFAULT 0,
  next_poll_at timestamptz,
  last_polled_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  provider_expires_at timestamptz NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS alibaba_video_jobs_provider_task_id_uidx
  ON alibaba_video_jobs(provider_task_id);
ALTER TABLE alibaba_video_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key text;
UPDATE alibaba_video_jobs
SET idempotency_key = 'legacy-' || id::text
WHERE idempotency_key IS NULL;
ALTER TABLE alibaba_video_jobs ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS alibaba_video_jobs_user_idempotency_key_uidx
  ON alibaba_video_jobs(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS alibaba_video_jobs_user_created_at_idx
  ON alibaba_video_jobs(user_id, created_at);
CREATE INDEX IF NOT EXISTS alibaba_video_jobs_due_idx
  ON alibaba_video_jobs(status, next_poll_at);
CREATE INDEX IF NOT EXISTS alibaba_video_jobs_conversation_idx
  ON alibaba_video_jobs(conversation_id);

-- A crashed worker can leave a lease behind. Leases are deliberately finite;
-- clearing already-expired leases at startup makes due work immediately claimable.
UPDATE alibaba_video_jobs
SET lease_owner = NULL,
    lease_expires_at = NULL
WHERE lease_expires_at IS NOT NULL AND lease_expires_at <= now();
`.trim();

export const ENSURE_AI_USAGE_SCHEMA_SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS ai_usage_windows (
  user_id text PRIMARY KEY,
  window_start_ms bigint NOT NULL,
  request_count integer NOT NULL CHECK (request_count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- CREATE TABLE IF NOT EXISTS does not reconcile a legacy deployment.
-- Add and backfill incrementally introduced columns before enforcing their
-- current defaults and nullability so existing usage rows are preserved.
ALTER TABLE ai_usage_windows
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;
UPDATE ai_usage_windows SET updated_at = now() WHERE updated_at IS NULL;
ALTER TABLE ai_usage_windows ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE ai_usage_windows ALTER COLUMN updated_at SET NOT NULL;

CREATE TABLE IF NOT EXISTS ai_usage_leases (
  lease_id text PRIMARY KEY,
  user_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_usage_leases
  ADD COLUMN IF NOT EXISTS created_at timestamptz;
UPDATE ai_usage_leases SET created_at = now() WHERE created_at IS NULL;
ALTER TABLE ai_usage_leases ALTER COLUMN created_at SET DEFAULT now();
ALTER TABLE ai_usage_leases ALTER COLUMN created_at SET NOT NULL;

-- Older deployments used last_renewed_at without a default. Keep the column
-- for backwards compatibility, but make it nullable so current inserts do
-- not fail. Fresh databases do not have this legacy column.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'ai_usage_leases'
      AND column_name = 'last_renewed_at'
  ) THEN
    ALTER TABLE ai_usage_leases
      ALTER COLUMN last_renewed_at DROP NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ai_usage_leases_user_expires_idx
  ON ai_usage_leases(user_id, expires_at);

-- Crashed instances cannot release their lease. Expired rows are harmless but
-- clearing them at startup keeps the shared coordination table compact.
DELETE FROM ai_usage_leases WHERE expires_at <= now();

COMMIT;
`.trim();

export const ENSURE_LLM_MEMORIES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS llm_memories (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  topic text NOT NULL,
  content text NOT NULL,
  source_url text,
  learned_at timestamptz NOT NULL DEFAULT now(),
  valid_as_of date,
  expires_at timestamptz,
  confidence double precision NOT NULL DEFAULT 1.0,
  superseded_by text,
  access_count integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Existing memories have unknown provenance; do not silently promote them to facts.
ALTER TABLE llm_memories ALTER COLUMN confidence SET DEFAULT 0.5;
ALTER TABLE llm_memories ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'unverified';
ALTER TABLE llm_memories ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'knowledge';
ALTER TABLE llm_memories ADD COLUMN IF NOT EXISTS source_ref text;
ALTER TABLE llm_memories ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE llm_memories ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE llm_memories ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;
ALTER TABLE llm_memories ADD COLUMN IF NOT EXISTS invalidation_reason text;
-- Bound retention for legacy entries that did not have an expiry.
UPDATE llm_memories SET expires_at = learned_at + interval '180 days' WHERE expires_at IS NULL;
CREATE TABLE IF NOT EXISTS llm_memory_revisions (
  memory_id text NOT NULL REFERENCES llm_memories(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  snapshot jsonb NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, revision)
);
CREATE INDEX IF NOT EXISTS llm_memory_revisions_recorded_idx ON llm_memory_revisions(recorded_at);
CREATE INDEX IF NOT EXISTS llm_memories_retention_idx ON llm_memories(expires_at, invalidated_at);
CREATE INDEX IF NOT EXISTS llm_memories_user_topic_idx
  ON llm_memories(user_id, topic);
CREATE INDEX IF NOT EXISTS llm_memories_user_active_idx
  ON llm_memories(user_id, superseded_by, expires_at);
`.trim();

export async function ensureMessageSchema(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  await query(ENSURE_MESSAGES_SCHEMA_SQL);
}

export async function ensureAssetsSchema(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  await query(ENSURE_ASSETS_SCHEMA_SQL);
}

export async function ensureAlibabaVideoJobsSchema(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  await query(ENSURE_ALIBABA_VIDEO_JOBS_SCHEMA_SQL);
}

export async function ensureAiUsageSchema(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  await query(ENSURE_AI_USAGE_SCHEMA_SQL);
}

export async function ensureLlmMemoriesSchema(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  await query(ENSURE_LLM_MEMORIES_SCHEMA_SQL);
}

export const ENSURE_USER_USAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_usage_monthly (
  id serial PRIMARY KEY,
  user_id text NOT NULL,
  month text NOT NULL,
  model_id text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  requests integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_usage_monthly_user_month_model_uidx
  ON user_usage_monthly(user_id, month, model_id);
CREATE INDEX IF NOT EXISTS user_usage_monthly_month_idx
  ON user_usage_monthly(month);

CREATE TABLE IF NOT EXISTS user_budgets (
  user_id text PRIMARY KEY,
  monthly_budget_usd double precision,
  suspended boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`.trim();

export const ENSURE_USER_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS user_settings (
  user_id text PRIMARY KEY,
  data text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`.trim();

export async function ensureUserSettingsSchema(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  await query(ENSURE_USER_SETTINGS_SCHEMA_SQL);
}

export async function ensureUserUsageSchema(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  await query(ENSURE_USER_USAGE_SCHEMA_SQL);
}

export async function ensureChatSchema(): Promise<void> {
  const { db } = await import("@workspace/db");
  await ensureMessageSchema((sql) => db.execute(sql));
  await ensureAssetsSchema((sql) => db.execute(sql));
  await ensureAlibabaVideoJobsSchema((sql) => db.execute(sql));
  await ensureAiUsageSchema((sql) => db.execute(sql));
  await ensureLlmMemoriesSchema((sql) => db.execute(sql));
  await ensureUserUsageSchema((sql) => db.execute(sql));
  await ensureUserSettingsSchema((sql) => db.execute(sql));
}
