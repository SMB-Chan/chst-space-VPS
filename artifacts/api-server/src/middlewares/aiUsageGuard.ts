import type { NextFunction, Request, RequestHandler, Response } from "express";

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 20;
const DEFAULT_MAX_CONCURRENT = 2;

interface UsageState {
  starts: number[];
  active: number;
  lastSeen: number;
}

export interface AiUsageGuardOptions {
  /** Sliding-window duration. */
  windowMs?: number;
  /** Requests admitted per user per window. Set 0 to disable this limit. */
  maxRequests?: number;
  /** Simultaneous in-flight requests per user. Set 0 to disable this limit. */
  maxConcurrent?: number;
  /** Injectable monotonic-ish wall clock for tests. */
  now?: () => number;
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("AI usage limits must be non-negative integers");
  }
  return value;
}

function envLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return value;
}

/**
 * Per-process abuse guard for expensive AI/SSE endpoints.  This deliberately
 * runs before the large JSON parser.  Multi-instance deployments should put a
 * shared limiter (gateway/Redis) in front as well, because this map is local to
 * one Node.js process.
 */
export function createAiUsageGuard(options: AiUsageGuardOptions = {}): RequestHandler {
  const windowMs = normalizeLimit(options.windowMs, DEFAULT_WINDOW_MS);
  if (windowMs === 0) throw new Error("AI usage window must be greater than zero");
  const maxRequests = normalizeLimit(options.maxRequests, DEFAULT_MAX_REQUESTS);
  const maxConcurrent = normalizeLimit(options.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  const now = options.now ?? Date.now;
  const states = new Map<string, UsageState>();
  let lastSweep = 0;

  function prune(state: UsageState, timestamp: number): void {
    const cutoff = timestamp - windowMs;
    while (state.starts.length > 0 && state.starts[0] <= cutoff) state.starts.shift();
  }

  function sweep(timestamp: number): void {
    if (timestamp - lastSweep < windowMs) return;
    lastSweep = timestamp;
    for (const [userId, state] of states) {
      prune(state, timestamp);
      if (state.active === 0 && state.starts.length === 0) states.delete(userId);
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const timestamp = now();
    sweep(timestamp);
    const state = states.get(userId) ?? { starts: [], active: 0, lastSeen: timestamp };
    prune(state, timestamp);
    state.lastSeen = timestamp;
    states.set(userId, state);

    if (maxConcurrent > 0 && state.active >= maxConcurrent) {
      res.setHeader("Retry-After", "1");
      res.status(429).json({
        error: `同時に実行できるAI生成は${maxConcurrent}件までです。実行中の応答が完了してから再試行してください。`,
      });
      return;
    }

    if (maxRequests > 0 && state.starts.length >= maxRequests) {
      const retryMs = Math.max(1, state.starts[0] + windowMs - timestamp);
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(retryMs / 1000))));
      res.status(429).json({
        error: `AI生成の利用回数が上限（${maxRequests}件/${Math.round(windowMs / 1000)}秒）に達しました。しばらくしてから再試行してください。`,
      });
      return;
    }

    state.starts.push(timestamp);
    state.active += 1;
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      state.lastSeen = now();
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

export const aiUsageGuard = createAiUsageGuard({
  maxRequests: envLimit("AI_REQUESTS_PER_MINUTE", DEFAULT_MAX_REQUESTS),
  maxConcurrent: envLimit("AI_MAX_CONCURRENT_REQUESTS", DEFAULT_MAX_CONCURRENT),
});
