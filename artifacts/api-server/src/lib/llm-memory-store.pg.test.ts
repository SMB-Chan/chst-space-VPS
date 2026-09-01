import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLlmMemoriesSchema } from "./ensure-schema";

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;
const users = [
  `memory-test-a:${randomUUID()}`,
  `memory-test-b:${randomUUID()}`,
];
let pool: (typeof import("@workspace/db"))["pool"];
let memoryStore: typeof import("./llm-memory-store");

describePostgres("PostgreSQL LLM memory isolation", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    memoryStore = await import("./llm-memory-store");
    await ensureLlmMemoriesSchema((sql) => pool.query(sql));
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(
      "DELETE FROM llm_memories WHERE user_id = ANY($1::text[])",
      [users],
    );
  });

  it("never recalls, updates, forgets, or supersedes another user's memory", async () => {
    const own = await memoryStore.storeMemory(users[0], {
      topic: "shared-keyword",
      content: "owner A only",
    });
    const other = await memoryStore.storeMemory(users[1], {
      topic: "shared-keyword",
      content: "owner B only",
    });

    const recalled = await memoryStore.recallMemories(
      users[0],
      "shared-keyword",
    );
    expect(recalled.map((entry) => entry.id)).toContain(own.id);
    expect(recalled.map((entry) => entry.id)).not.toContain(other.id);
    expect(
      await memoryStore.updateMemory(users[0], other.id, {
        content: "cross-user update",
      }),
    ).toBeNull();
    expect(await memoryStore.forgetMemory(users[0], other.id)).toBe(false);
    expect(await memoryStore.supersedeMemory(users[0], own.id, other.id)).toBe(
      false,
    );
  });

  it("deletes memories for only the requested user", async () => {
    await memoryStore.deleteAllMemories(users[0]);
    expect(await memoryStore.getActiveMemorySummary(users[0])).toHaveLength(0);
    expect((await memoryStore.getActiveMemorySummary(users[1])).length).toBe(1);
  });
});
