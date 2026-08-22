export const ENSURE_MESSAGES_SCHEMA_SQL = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sources text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS audit_content text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS audit_model_id text;
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

-- Existing deployments may still have ON DELETE SET NULL. Change only that
-- legacy FK; new databases already have CASCADE from the CREATE TABLE above.
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

export async function ensureChatSchema(): Promise<void> {
  const { db } = await import("@workspace/db");
  await ensureMessageSchema((sql) => db.execute(sql));
  await ensureAssetsSchema((sql) => db.execute(sql));
}
