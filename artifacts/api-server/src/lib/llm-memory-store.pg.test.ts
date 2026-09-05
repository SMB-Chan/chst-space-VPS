import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureLlmMemoriesSchema } from "./ensure-schema";
const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;
const users = [
  `memory-test-a:${randomUUID()}`,
  `memory-test-b:${randomUUID()}`,
];
let pool: (typeof import("@workspace/db"))["pool"];
let store: typeof import("./llm-memory-store");
const input = (topic: string) => ({
  topic,
  content: `${topic}の内容`,
  kind: "user_statement" as const,
  category: "knowledge" as const,
});

describePostgres("PostgreSQL shared memory lifecycle", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    store = await import("./llm-memory-store");
    await ensureLlmMemoriesSchema((sql) => pool.query(sql));
    await ensureLlmMemoriesSchema((sql) => pool.query(sql)); // idempotent migration
  });
  afterAll(async () => {
    if (pool)
      await pool.query(
        "DELETE FROM llm_memories WHERE user_id = ANY($1::text[])",
        [users],
      );
  });

  it("shares facts across model callers while isolating every owner operation", async () => {
    const own = await store.storeMemory(users[0], input("isolation-keyword"));
    const other = await store.storeMemory(users[1], input("isolation-keyword"));
    expect(
      (await store.recallMemories(users[0], "isolation-keyword")).map(
        (e) => e.id,
      ),
    ).toEqual([own.id]);
    expect(await store.getMemory(users[0], other.id)).toBeNull();
    expect(
      await store.updateMemory(users[0], other.id, { content: "bad" }),
    ).toBeNull();
    expect(await store.forgetMemory(users[0], other.id)).toBe(false);
    expect(await store.invalidateMemory(users[0], other.id, "incorrect")).toBe(
      false,
    );
    expect(await store.supersedeMemory(users[0], own.id, other.id)).toBe(false);
    expect(await store.getMemoryHistory(users[0], other.id)).toEqual([]);
  });
  it("keeps inferred and legacy/unverified entries out of automatic recall", async () => {
    await store.storeMemory(users[0], {
      ...input("quarantine"),
      kind: "inference",
    });
    await store.storeMemory(users[0], {
      topic: "quarantine",
      content: "unknown origin",
    });
    expect(await store.recallMemories(users[0], "quarantine")).toHaveLength(0);
    expect(
      (await store.listMemories(users[0])).filter(
        (m) => m.topic === "quarantine",
      ),
    ).toHaveLength(2);
  });
  it("uses short default TTL for sourced facts and preserves complete provenance", async () => {
    const memory = await store.storeMemory(users[0], {
      ...input("sourced"),
      kind: "sourced_fact",
      source_url: "https://example.com/source",
      valid_as_of: "2026-01-01",
      source_ref: "document:42",
    });
    expect(Date.parse(memory.expires_at!) - Date.now()).toBeLessThanOrEqual(
      7 * 86400000,
    );
    const [recalled] = await store.recallMemories(users[0], "sourced");
    expect(recalled.valid_as_of).toBe("2026-01-01");
    expect(store.formatMemoriesForPrompt([recalled])).toContain("document:42");
    expect(recalled).not.toHaveProperty("user_id");
  });
  it("deduplicates concurrent identical writes without extending expiration", async () => {
    const entries = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.storeMemory(users[0], input("duplicate")),
      ),
    );
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(1);
    expect(new Set(entries.map((entry) => entry.expires_at)).size).toBe(1);
  });
  it("atomically records correction history and rejects stale concurrent revisions", async () => {
    const memory = await store.storeMemory(users[0], input("correction"));
    const results = await Promise.allSettled(
      ["correct-a", "correct-b"].map((content) =>
        store.updateMemory(users[0], memory.id, {
          content,
          expected_revision: 1,
          reason: "user correction",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const history = await store.getMemoryHistory(users[0], memory.id);
    expect(history).toHaveLength(1);
    expect(history[0].snapshot.content).toBe(memory.content);
    expect(history[0].snapshot).not.toHaveProperty("user_id");
    expect((await store.getMemory(users[0], memory.id))!.revision).toBe(2);
  });
  it("rolls back an invalid partial provenance edit without creating a revision", async () => {
    const memory = await store.storeMemory(users[0], {
      ...input("rollback"),
      kind: "sourced_fact",
      source_url: "https://example.com",
      valid_as_of: "2026-01-01",
    });
    await expect(
      store.updateMemory(users[0], memory.id, { source_url: null }),
    ).rejects.toThrow();
    expect((await store.getMemory(users[0], memory.id))!.source_url).toBe(
      "https://example.com",
    );
    expect(await store.getMemoryHistory(users[0], memory.id)).toHaveLength(0);
  });
  it("invalidates immediately and prevents resurrection through update", async () => {
    const memory = await store.storeMemory(users[0], input("incorrect-record"));
    expect(
      await store.invalidateMemory(users[0], memory.id, "incorrect", 1),
    ).toBe(true);
    expect(
      await store.recallMemories(users[0], "incorrect-record"),
    ).toHaveLength(0);
    await expect(
      store.updateMemory(users[0], memory.id, {
        expires_at: "2099-01-01T00:00:00Z",
      }),
    ).rejects.toThrow();
    expect(
      (await store.getMemory(users[0], memory.id))!.invalidation_reason,
    ).toBe("incorrect");
  });
  it("only supersedes distinct active owned memories and cannot create cycles", async () => {
    const old = await store.storeMemory(users[0], input("supersede-old"));
    const fresh = await store.storeMemory(users[0], input("supersede-new"));
    expect(await store.supersedeMemory(users[0], old.id, old.id)).toBe(false);
    expect(await store.supersedeMemory(users[0], old.id, fresh.id)).toBe(true);
    expect(await store.supersedeMemory(users[0], fresh.id, old.id)).toBe(false);
    expect(await store.recallMemories(users[0], "supersede-old")).toHaveLength(
      0,
    );
  });
  it("hard deletes the body and all revision snapshots", async () => {
    const memory = await store.storeMemory(users[0], input("delete-secret"));
    await store.updateMemory(users[0], memory.id, { content: "new-secret" });
    expect(await store.forgetMemory(users[0], memory.id)).toBe(true);
    expect(await store.getMemory(users[0], memory.id)).toBeNull();
    const revisions = await pool.query(
      "SELECT * FROM llm_memory_revisions WHERE memory_id = $1",
      [memory.id],
    );
    expect(revisions.rows).toHaveLength(0);
  });
  it("bounds revision history to ten snapshots", async () => {
    const memory = await store.storeMemory(
      users[0],
      input("bounded-revisions"),
    );
    for (let i = 0; i < 12; i++)
      await store.updateMemory(users[0], memory.id, {
        content: `revision-${i}`,
      });
    expect(await store.getMemoryHistory(users[0], memory.id)).toHaveLength(10);
  });
  it("excludes expired entries without maintenance and physically purges after retention", async () => {
    const expired = await store.storeMemory(
      users[0],
      input("retention-expired"),
    );
    const recent = await store.storeMemory(users[0], input("retention-recent"));
    await pool.query(
      "UPDATE llm_memories SET expires_at = now() - interval '31 days' WHERE id = $1",
      [expired.id],
    );
    await pool.query(
      "UPDATE llm_memories SET expires_at = now() - interval '1 day' WHERE id = $1",
      [recent.id],
    );
    expect(await store.recallMemories(users[0], "retention")).toHaveLength(0);
    const result = await store.runMemoryMaintenance(users[0]);
    expect(result.purged).toBeGreaterThanOrEqual(1);
    expect(await store.getMemory(users[0], expired.id)).toBeNull();
    expect(await store.getMemory(users[0], recent.id)).not.toBeNull();
  });
  it("cleans old invalidations, replacements and snapshots even for inactive owners", async () => {
    const old = await store.storeMemory(
      users[0],
      input("background-retention"),
    );
    const live = await store.storeMemory(users[0], input("live-retention"));
    await store.invalidateMemory(users[0], old.id, "incorrect");
    await store.updateMemory(users[0], live.id, { content: "current" });
    await pool.query(
      "UPDATE llm_memories SET invalidated_at = now() - interval '31 days' WHERE id = $1",
      [old.id],
    );
    await pool.query(
      "UPDATE llm_memory_revisions SET recorded_at = now() - interval '31 days' WHERE memory_id = $1",
      [live.id],
    );
    await store.purgeExpiredMemoryBatch();
    expect(await store.getMemory(users[0], old.id)).toBeNull();
    expect(await store.getMemory(users[0], live.id)).not.toBeNull();
    expect(
      (
        await pool.query(
          "SELECT * FROM llm_memory_revisions WHERE memory_id = $1",
          [live.id],
        )
      ).rows,
    ).toHaveLength(0);
  });
  it("retrieves Japanese and English and always carries stable preferences", async () => {
    const pref = await store.storeMemory(users[0], {
      ...input("回答形式"),
      content: "日本語で簡潔に",
      category: "preference",
    });
    const english = await store.storeMemory(users[0], input("hardware"));
    const japanese = await store.storeMemory(users[0], input("東京"));
    expect(
      (
        await store.findRelevantMemories(
          users[0],
          "hardwareについて説明してください",
        )
      ).map((e) => e.id),
    ).toContain(english.id);
    expect(
      (await store.findRelevantMemories(users[0], "東京の天気")).map(
        (e) => e.id,
      ),
    ).toContain(japanese.id);
    expect(
      (await store.findRelevantMemories(users[0], "こんにちは")).map(
        (e) => e.id,
      ),
    ).toContain(pref.id);
    const before = await store.getMemory(users[0], english.id);
    await store.recallMemories(users[0], "hardware");
    expect((await store.getMemory(users[0], english.id))!.expires_at).toBe(
      before!.expires_at,
    );
  });
  it("escapes literal wildcards in recall", async () => {
    const memory = await store.storeMemory(users[0], input("literal%_\\"));
    expect(
      (await store.recallMemories(users[0], "%_\\")).map((e) => e.id),
    ).toEqual([memory.id]);
  });
  it("keeps the active quota under concurrent inserts", async () => {
    await pool.query(
      `INSERT INTO llm_memories (id,user_id,topic,content,kind,expires_at,confidence)
      SELECT $1 || n::text, $2, 'capacity-fixture', 'fixture', 'user_statement', now() + interval '1 day', 0.01
      FROM generate_series(1,500) n`,
      [`cap-${randomUUID()}-`, users[0]],
    );
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.storeMemory(users[0], input(`capacity-new-${i}`)),
      ),
    );
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM llm_memories WHERE user_id=$1 AND invalidated_at IS NULL AND superseded_by IS NULL AND expires_at>now()`,
      [users[0]],
    );
    expect(count.rows[0].n).toBe(500);
  });
  it("deletes all records and snapshots only for the requested owner", async () => {
    await store.deleteAllMemories(users[0]);
    expect(await store.listMemories(users[0])).toHaveLength(0);
    expect((await store.listMemories(users[1])).length).toBeGreaterThan(0);
  });
});
