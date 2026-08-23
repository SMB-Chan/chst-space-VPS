import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { logger } from "../lib/logger";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 20;
const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_LEASE_TTL_MS = 90_000;

export type SharedAiUsageRejectionReason = "rate" | "concurrent";

export interface SharedAiUsageAcquireInput {
  userId: string;
  nowMs: number;
  windowMs: number;
  maxRequests: number;
  maxConcurrent: number;
  leaseTtlMs: number;
}

export type SharedAiUsageAcquireResult =
  | { allowed: true; leaseId?: string }
  | {
      allowed: false;
      reason: SharedAiUsageRejectionReason;
      retryAfterSeconds: number;
    };

export interface SharedAiUsageStore {
  acquire(input: SharedAiUsageAcquireInput): Promise<SharedAiUsageAcquireResult>;
  renewLease(input: {
    userId: string;
    leaseId: string;
    nowMs: number;
    leaseTtlMs: number;
  }): Promise<boolean>;
  releaseLease(input: { userId: string; leaseId: string }): Promise<void>;
}

export interface SharedAiUsageGuardOptions {
  windowMs?: number;
  maxRequests?: number;
  maxConcurrent?: number;
  leaseTtlMs?: number;
  now?: () => number;
  store?: SharedAiUsageStore;
  /** Tests and specialized callers can disable the heartbeat. */
  renewLeases?: boolean;
}

export interface SharedAiUsageMetrics {
  admitted: number;
  rejectedRate: number;
  rejectedConcurrent: number;
  backendFailures: number;
  releaseFailures: number;
  renewFailures: number;
}

const metrics: SharedAiUsageMetrics = {
  admitted: 0,
  rejectedRate: 0,
  rejectedConcurrent: 0,
  backendFailures: 0,
  releaseFailures: 0,
  renewFailures: 0,
};

export function getSharedAiUsageMetrics(): SharedAiUsageMetrics {
  return { ...metrics };
}

export function resetSharedAiUsageMetricsForTests(): void {
  for (const key of Object.keys(metrics) as (keyof SharedAiUsageMetrics)[]) {
    metrics[key] = 0;
  }
}

function normalizeNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("AI usage limits must be non-negative integers");
  }
  return value;
}

function normalizePositive(value: number | undefined, fallback: number, label: string): number {
  const normalized = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function envNonNegative(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function envPositive(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function retryAfterSeconds(targetMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil(Math.max(1, targetMs - nowMs) / 1000));
}

/**
 * PostgreSQL is the authoritative shared store. All decisions for one user are
 * serialized with an advisory transaction lock so independent Autoscale
 * processes observe the same quota and concurrency state.
 */
export class PostgresSharedAiUsageStore implements SharedAiUsageStore {
  async acquire(input: SharedAiUsageAcquireInput): Promise<SharedAiUsageAcquireResult> {
    if (input.maxRequests === 0 && input.maxConcurrent === 0) {
      return { allowed: true };
    }

    const { pool } = await import("@workspace/db");
    const client = await pool.connect();
    const now = new Date(input.nowMs);
    const lockKey = `chat-space:ai-usage:${input.userId}`;

    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
        [lockKey],
      );

      if (input.maxConcurrent > 0) {
        await client.query(
          "DELETE FROM ai_usage_leases WHERE user_id = $1 AND expires_at <= $2",
          [input.userId, now],
        );
        const active = await client.query<{
          active_count: number;
          earliest_expiry: Date | null;
        }>(
          `SELECT COUNT(*)::int AS active_count, MIN(expires_at) AS earliest_expiry
             FROM ai_usage_leases
            WHERE user_id = $1 AND expires_at > $2`,
          [input.userId, now],
        );
        const row = active.rows[0];
        if ((row?.active_count ?? 0) >= input.maxConcurrent) {
          const earliestMs = row?.earliest_expiry
            ? new Date(row.earliest_expiry).getTime()
            : input.nowMs + 1_000;
          await client.query("COMMIT");
          return {
            allowed: false,
            reason: "concurrent",
            retryAfterSeconds: retryAfterSeconds(earliestMs, input.nowMs),
          };
        }
      }

      if (input.maxRequests > 0) {
        const windowStartMs = Math.floor(input.nowMs / input.windowMs) * input.windowMs;
        const windowEndMs = windowStartMs + input.windowMs;
        const current = await client.query<{
          window_start_ms: string;
          request_count: number;
        }>(
          `SELECT window_start_ms, request_count
             FROM ai_usage_windows
            WHERE user_id = $1
              AND window_start_ms = $2
            FOR UPDATE`,
          [input.userId, windowStartMs],
        );
        const row = current.rows[0];
        let requestCount = row?.request_count ?? 0;

        if (!row) {
          // Legacy deployments keyed windows by (user_id, window_start_ms),
          // while current deployments keep one row per user. Deleting only
          // this user's expired windows before inserting the current one is
          // safe under both schemas and avoids a primary-key rewrite.
          await client.query(
            "DELETE FROM ai_usage_windows WHERE user_id = $1",
            [input.userId],
          );
          await client.query(
            `INSERT INTO ai_usage_windows (user_id, window_start_ms, request_count, updated_at)
             VALUES ($1, $2, 0, now())`,
            [input.userId, windowStartMs],
          );
          requestCount = 0;
        }

        if (requestCount >= input.maxRequests) {
          await client.query("COMMIT");
          return {
            allowed: false,
            reason: "rate",
            retryAfterSeconds: retryAfterSeconds(windowEndMs, input.nowMs),
          };
        }

        await client.query(
          `UPDATE ai_usage_windows
              SET request_count = request_count + 1, updated_at = now()
            WHERE user_id = $1
              AND window_start_ms = $2`,
          [input.userId, windowStartMs],
        );
      }

      let leaseId: string | undefined;
      if (input.maxConcurrent > 0) {
        leaseId = randomUUID();
        await client.query(
          `INSERT INTO ai_usage_leases (lease_id, user_id, expires_at)
           VALUES ($1, $2, $3)`,
          [leaseId, input.userId, new Date(input.nowMs + input.leaseTtlMs)],
        );
      }

      await client.query("COMMIT");
      return leaseId ? { allowed: true, leaseId } : { allowed: true };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original backend error.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async renewLease(input: {
    userId: string;
    leaseId: string;
    nowMs: number;
    leaseTtlMs: number;
  }): Promise<boolean> {
    const { pool } = await import("@workspace/db");
    const result = await pool.query(
      `UPDATE ai_usage_leases
          SET expires_at = $3
        WHERE lease_id = $1
          AND user_id = $2
          AND expires_at > $4`,
      [
        input.leaseId,
        input.userId,
        new Date(input.nowMs + input.leaseTtlMs),
        new Date(input.nowMs),
      ],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async releaseLease(input: { userId: string; leaseId: string }): Promise<void> {
    const { pool } = await import("@workspace/db");
    await pool.query(
      "DELETE FROM ai_usage_leases WHERE lease_id = $1 AND user_id = $2",
      [input.leaseId, input.userId],
    );
  }
}

/**
 * Shared, authenticated-user limiter for expensive AI/SSE routes. The request
 * body has not been parsed yet when this runs, so a rejected large attachment
 * cannot force the expensive JSON allocation first.
 */
export function createSharedAiUsageGuard(
  options: SharedAiUsageGuardOptions = {},
): RequestHandler {
  const windowMs = normalizePositive(options.windowMs, DEFAULT_WINDOW_MS, "AI usage window");
  const maxRequests = normalizeNonNegative(options.maxRequests, DEFAULT_MAX_REQUESTS);
  const maxConcurrent = normalizeNonNegative(options.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const leaseTtlMs = normalizePositive(
    options.leaseTtlMs,
    DEFAULT_LEASE_TTL_MS,
    "AI concurrency lease TTL",
  );
  const now = options.now ?? Date.now;
  const store = options.store ?? new PostgresSharedAiUsageStore();
  const renewLeases = options.renewLeases ?? true;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    let decision: SharedAiUsageAcquireResult;
    try {
      decision = await store.acquire({
        userId,
        nowMs: now(),
        windowMs,
        maxRequests,
        maxConcurrent,
        leaseTtlMs,
      });
    } catch (error) {
      metrics.backendFailures += 1;
      logger.error({ err: error }, "Shared AI usage limiter backend failed");
      res.setHeader("Retry-After", "1");
      res.status(503).json({
        error: "AI利用制御サービスに接続できません。少し待ってから再試行してください。",
      });
      return;
    }

    if (!decision.allowed) {
      if (decision.reason === "concurrent") metrics.rejectedConcurrent += 1;
      else metrics.rejectedRate += 1;
      res.setHeader("Retry-After", String(decision.retryAfterSeconds));
      if (decision.reason === "concurrent") {
        res.status(429).json({
          error: `同時に実行できるAI生成は${maxConcurrent}件までです。実行中の応答が完了してから再試行してください。`,
        });
      } else {
        res.status(429).json({
          error: `AI生成の利用回数が上限（${maxRequests}件/${Math.round(windowMs / 1000)}秒）に達しました。しばらくしてから再試行してください。`,
        });
      }
      return;
    }

    metrics.admitted += 1;
    const leaseId = decision.leaseId;
    let released = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    const release = (): void => {
      if (released) return;
      released = true;
      if (heartbeat) clearInterval(heartbeat);
      if (!leaseId) return;
      void store.releaseLease({ userId, leaseId }).catch((error) => {
        metrics.releaseFailures += 1;
        logger.warn({ err: error }, "Failed to release shared AI usage lease");
      });
    };

    if (leaseId && renewLeases) {
      const heartbeatMs = Math.max(250, Math.min(30_000, Math.floor(leaseTtlMs / 3)));
      heartbeat = setInterval(() => {
        if (released) return;
        void store
          .renewLease({ userId, leaseId, nowMs: now(), leaseTtlMs })
          .then((renewed) => {
            if (!renewed) {
              metrics.renewFailures += 1;
              logger.warn("Shared AI usage lease expired before renewal");
            }
          })
          .catch((error) => {
            metrics.renewFailures += 1;
            logger.warn({ err: error }, "Failed to renew shared AI usage lease");
          });
      }, heartbeatMs);
      heartbeat.unref?.();
    }

    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

export const sharedAiUsageGuard = createSharedAiUsageGuard({
  maxRequests: envNonNegative("AI_REQUESTS_PER_MINUTE", DEFAULT_MAX_REQUESTS),
  maxConcurrent: envNonNegative("AI_MAX_CONCURRENT_REQUESTS", DEFAULT_MAX_CONCURRENT),
  leaseTtlMs: envPositive("AI_CONCURRENCY_LEASE_TTL_MS", DEFAULT_LEASE_TTL_MS),
});
