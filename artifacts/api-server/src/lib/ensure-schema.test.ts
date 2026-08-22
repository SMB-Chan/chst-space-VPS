import { describe, expect, it, vi } from "vitest";
import {
  ENSURE_AI_USAGE_SCHEMA_SQL,
  ENSURE_ASSETS_SCHEMA_SQL,
  ENSURE_MESSAGES_SCHEMA_SQL,
  ensureAiUsageSchema,
  ensureAssetsSchema,
  ensureMessageSchema,
} from "./ensure-schema";

describe("ensureMessageSchema", () => {
  it("adds incrementally introduced message columns if they are missing", () => {
    expect(ENSURE_MESSAGES_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS audit_content text");
    expect(ENSURE_MESSAGES_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS audit_model_id text");
    expect(ENSURE_MESSAGES_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS model_id text");
    expect(ENSURE_MESSAGES_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS sources text");
    expect(ENSURE_MESSAGES_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS asset_ids text");
  });

  it("runs the SQL through the provided query function", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    await ensureMessageSchema(query);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(ENSURE_MESSAGES_SCHEMA_SQL);
  });
});

describe("ensureAssetsSchema", () => {
  it("creates the assets and artifacts tables and indexes", () => {
    expect(ENSURE_ASSETS_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS assets");
    expect(ENSURE_ASSETS_SCHEMA_SQL).toContain("assets_conversation_id_idx");
    expect(ENSURE_ASSETS_SCHEMA_SQL).toContain("assets_message_id_idx");
    expect(ENSURE_ASSETS_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS artifacts");
    expect(ENSURE_ASSETS_SCHEMA_SQL).toContain("artifacts_conversation_id_idx");
  });

  it("cleans legacy orphan assets and migrates the message FK to cascade", () => {
    expect(ENSURE_ASSETS_SCHEMA_SQL).toContain("DELETE FROM assets WHERE message_id IS NULL");
    expect(ENSURE_ASSETS_SCHEMA_SQL).toContain("ON DELETE CASCADE");
    expect(ENSURE_ASSETS_SCHEMA_SQL).toContain("assets_message_id_messages_id_fk");
    expect(ENSURE_ASSETS_SCHEMA_SQL).not.toContain("ON DELETE SET NULL");
  });

  it("runs the SQL through the provided query function", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    await ensureAssetsSchema(query);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(ENSURE_ASSETS_SCHEMA_SQL);
  });
});

describe("ensureAiUsageSchema", () => {
  it("creates shared fixed-window and expiring-lease tables", () => {
    expect(ENSURE_AI_USAGE_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS ai_usage_windows");
    expect(ENSURE_AI_USAGE_SCHEMA_SQL).toContain("CREATE TABLE IF NOT EXISTS ai_usage_leases");
    expect(ENSURE_AI_USAGE_SCHEMA_SQL).toContain("ai_usage_leases_user_expires_idx");
    expect(ENSURE_AI_USAGE_SCHEMA_SQL).toContain("DELETE FROM ai_usage_leases WHERE expires_at <= now()");
  });

  it("runs the SQL through the provided query function", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    await ensureAiUsageSchema(query);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(ENSURE_AI_USAGE_SCHEMA_SQL);
  });
});
