import { describe, expect, it, vi } from "vitest";
import { ENSURE_MESSAGES_SCHEMA_SQL, ensureMessageSchema } from "./ensure-schema";

describe("ensureMessageSchema", () => {
  it("adds incrementally introduced message columns if they are missing", () => {
    expect(ENSURE_MESSAGES_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS audit_content text");
    expect(ENSURE_MESSAGES_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS audit_model_id text");
    expect(ENSURE_MESSAGES_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS model_id text");
    expect(ENSURE_MESSAGES_SCHEMA_SQL).toContain("ADD COLUMN IF NOT EXISTS sources text");
  });

  it("runs the SQL through the provided query function", async () => {
    const query = vi.fn().mockResolvedValue(undefined);
    await ensureMessageSchema(query);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(ENSURE_MESSAGES_SCHEMA_SQL);
  });
});
