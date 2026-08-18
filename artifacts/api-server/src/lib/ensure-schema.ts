export const ENSURE_MESSAGES_SCHEMA_SQL = `
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sources text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS audit_content text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS audit_model_id text;
`.trim();

export async function ensureMessageSchema(
  query: (sql: string) => Promise<unknown>,
): Promise<void> {
  await query(ENSURE_MESSAGES_SCHEMA_SQL);
}
