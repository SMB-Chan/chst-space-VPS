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
  message_id integer REFERENCES messages(id) ON DELETE SET NULL,
  filename text NOT NULL,
  mime_type text NOT NULL,
  size integer NOT NULL,
  data text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS assets_conversation_id_idx ON assets(conversation_id);
CREATE INDEX IF NOT EXISTS assets_message_id_idx ON assets(message_id);
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
