import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAiUsageSchema } from "../lib/ensure-schema";
import { PostgresSharedAiUsageStore } from "./sharedAiUsageGuard";

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

const testUsers = new Set<string>();
let pool: (typeof import("@workspace/db"))["pool"];

function testUser(label: string): string {
  const userId = `ai-usage-test:${label}:${randomUUID()}`;
  testUsers.add(userId);
  return userId;
}

describePostgres("PostgresSharedAiUsageStore", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    await ensureAiUsageSchema((sql) => pool.query(sql));
  });

  afterAll(async () => {
    if (!pool || testUsers.size === 0) return;
    const users = [...testUsers];
    await pool.query(
      "DELETE FROM ai_usage_leases WHERE user_id = ANY($1::text[])",
      [users],
    );
    await pool.query(
      "DELETE FROM ai_usage_windows WHERE user_id = ANY($1::text[])",
      [users],
    );
  });

  it("shares concurrency across independent store instances", async () => {
    const userId = testUser("concurrency");
    const nowMs = Date.now();
    const firstStore = new PostgresSharedAiUsageStore();
    const secondStore = new PostgresSharedAiUsageStore();
    const input = {
      userId,
      nowMs,
      windowMs: 60_000,
      maxRequests: 0,
      maxConcurrent: 1,
      leaseTtlMs: 30_000,
    };

    const [first, second] = await Promise.all([
      firstStore.acquire(input),
      secondStore.acquire(input),
    ]);
    const allowed = [first, second].filter((result) => result.allowed);
    const blocked = [first, second].filter((result) => !result.allowed);

    expect(allowed).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toEqual(
      expect.objectContaining({ allowed: false, reason: "concurrent" }),
    );

    const admitted = allowed[0];
    if (admitted?.allowed && admitted.leaseId) {
      await firstStore.releaseLease({ userId, leaseId: admitted.leaseId });
    }
    const afterRelease = await secondStore.acquire(input);
    expect(afterRelease.allowed).toBe(true);
    if (afterRelease.allowed && afterRelease.leaseId) {
      await secondStore.releaseLease({ userId, leaseId: afterRelease.leaseId });
    }
  });

  it("shares a deterministic fixed request window across store instances", async () => {
    const userId = testUser("rate");
    const nowMs = Math.floor(Date.now() / 60_000) * 60_000 + 1_000;
    const firstStore = new PostgresSharedAiUsageStore();
    const secondStore = new PostgresSharedAiUsageStore();
    const input = {
      userId,
      nowMs,
      windowMs: 60_000,
      maxRequests: 1,
      maxConcurrent: 0,
      leaseTtlMs: 30_000,
    };

    expect((await firstStore.acquire(input)).allowed).toBe(true);
    const blocked = await secondStore.acquire(input);
    expect(blocked).toEqual({
      allowed: false,
      reason: "rate",
      retryAfterSeconds: 59,
    });

    const nextWindow = await secondStore.acquire({
      ...input,
      nowMs: nowMs + 60_000,
    });
    expect(nextWindow.allowed).toBe(true);
  });

  it("supports legacy composite-key windows without duplicate-key rollover failures", async () => {
    const userId = testUser("legacy-composite-window");
    const currentWindowMs = Math.floor(Date.now() / 60_000) * 60_000;
    const store = new PostgresSharedAiUsageStore();

    await pool.query(
      "ALTER TABLE ai_usage_windows DROP CONSTRAINT ai_usage_windows_pkey",
    );
    await pool.query(
      `ALTER TABLE ai_usage_windows
       ADD CONSTRAINT ai_usage_windows_pkey PRIMARY KEY (user_id, window_start_ms)`,
    );

    try {
      await pool.query(
        `INSERT INTO ai_usage_windows
           (user_id, window_start_ms, request_count, updated_at)
         VALUES ($1, $2, 4, now()), ($1, $3, 7, now())`,
        [userId, currentWindowMs - 60_000, currentWindowMs],
      );

      const current = await store.acquire({
        userId,
        nowMs: currentWindowMs + 1_000,
        windowMs: 60_000,
        maxRequests: 20,
        maxConcurrent: 0,
        leaseTtlMs: 30_000,
      });
      expect(current.allowed).toBe(true);

      const currentRows = await pool.query<{
        window_start_ms: string;
        request_count: number;
      }>(
        `SELECT window_start_ms, request_count
           FROM ai_usage_windows
          WHERE user_id = $1
          ORDER BY window_start_ms`,
        [userId],
      );
      expect(currentRows.rows).toEqual([
        { window_start_ms: String(currentWindowMs - 60_000), request_count: 4 },
        { window_start_ms: String(currentWindowMs), request_count: 8 },
      ]);

      const next = await store.acquire({
        userId,
        nowMs: currentWindowMs + 61_000,
        windowMs: 60_000,
        maxRequests: 20,
        maxConcurrent: 0,
        leaseTtlMs: 30_000,
      });
      expect(next.allowed).toBe(true);

      const rolledRows = await pool.query<{
        window_start_ms: string;
        request_count: number;
      }>(
        `SELECT window_start_ms, request_count
           FROM ai_usage_windows
          WHERE user_id = $1`,
        [userId],
      );
      expect(rolledRows.rows).toEqual([
        { window_start_ms: String(currentWindowMs + 60_000), request_count: 1 },
      ]);
    } finally {
      await pool.query("DELETE FROM ai_usage_windows WHERE user_id = $1", [
        userId,
      ]);
      await pool.query(
        "ALTER TABLE ai_usage_windows DROP CONSTRAINT ai_usage_windows_pkey",
      );
      await pool.query(
        `ALTER TABLE ai_usage_windows
         ADD CONSTRAINT ai_usage_windows_pkey PRIMARY KEY (user_id)`,
      );
    }
  });
  it("recovers an abandoned concurrency lease after its TTL", async () => {
    const userId = testUser("stale");
    const nowMs = Date.now();
    const firstStore = new PostgresSharedAiUsageStore();
    const secondStore = new PostgresSharedAiUsageStore();
    const input = {
      userId,
      nowMs,
      windowMs: 60_000,
      maxRequests: 0,
      maxConcurrent: 1,
      leaseTtlMs: 1_000,
    };

    const first = await firstStore.acquire(input);
    expect(first.allowed).toBe(true);
    expect((await secondStore.acquire(input)).allowed).toBe(false);

    const recovered = await secondStore.acquire({
      ...input,
      nowMs: nowMs + 1_001,
    });
    expect(recovered.allowed).toBe(true);
    if (recovered.allowed && recovered.leaseId) {
      await secondStore.releaseLease({ userId, leaseId: recovered.leaseId });
    }
  });
});
