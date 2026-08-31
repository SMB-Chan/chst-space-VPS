import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach } from "vitest";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  createSharedAiUsageGuard,
  getSharedAiUsageMetrics,
  resetSharedAiUsageMetricsForTests,
  type SharedAiUsageAcquireInput,
  type SharedAiUsageAcquireResult,
  type SharedAiUsageStore,
} from "./sharedAiUsageGuard";

class MockResponse extends EventEmitter {
  statusCode = 200;
  body: unknown;
  headers = new Map<string, string>();

  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), String(value));
    return this;
  }

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): this {
    this.body = body;
    return this;
  }
}

class MemorySharedStore implements SharedAiUsageStore {
  private windows = new Map<string, { windowStartMs: number; count: number }>();
  private leases = new Map<string, { userId: string; expiresAtMs: number }>();
  private sequence = 0;

  async acquire(
    input: SharedAiUsageAcquireInput,
  ): Promise<SharedAiUsageAcquireResult> {
    for (const [leaseId, lease] of this.leases) {
      if (lease.userId === input.userId && lease.expiresAtMs <= input.nowMs) {
        this.leases.delete(leaseId);
      }
    }

    if (input.maxConcurrent > 0) {
      const active = [...this.leases.values()]
        .filter(
          (lease) =>
            lease.userId === input.userId && lease.expiresAtMs > input.nowMs,
        )
        .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
      if (active.length >= input.maxConcurrent) {
        return {
          allowed: false,
          reason: "concurrent",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil(
              ((active[0]?.expiresAtMs ?? input.nowMs + 1_000) - input.nowMs) /
                1000,
            ),
          ),
        };
      }
    }

    if (input.maxRequests > 0) {
      const windowStartMs =
        Math.floor(input.nowMs / input.windowMs) * input.windowMs;
      const window = this.windows.get(input.userId);
      const current =
        window?.windowStartMs === windowStartMs
          ? window
          : { windowStartMs, count: 0 };
      this.windows.set(input.userId, current);
      if (current.count >= input.maxRequests) {
        return {
          allowed: false,
          reason: "rate",
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((windowStartMs + input.windowMs - input.nowMs) / 1000),
          ),
        };
      }
      current.count += 1;
    }

    if (input.maxConcurrent === 0) return { allowed: true };
    const leaseId = `lease-${++this.sequence}`;
    this.leases.set(leaseId, {
      userId: input.userId,
      expiresAtMs: input.nowMs + input.leaseTtlMs,
    });
    return { allowed: true, leaseId };
  }

  async renewLease(input: {
    userId: string;
    leaseId: string;
    nowMs: number;
    leaseTtlMs: number;
  }): Promise<boolean> {
    const lease = this.leases.get(input.leaseId);
    if (
      !lease ||
      lease.userId !== input.userId ||
      lease.expiresAtMs <= input.nowMs
    ) {
      return false;
    }
    lease.expiresAtMs = input.nowMs + input.leaseTtlMs;
    return true;
  }

  async releaseLease(input: {
    userId: string;
    leaseId: string;
  }): Promise<void> {
    const lease = this.leases.get(input.leaseId);
    if (lease?.userId === input.userId) this.leases.delete(input.leaseId);
  }
}

async function invoke(
  guard: RequestHandler,
  userId: string | undefined,
  response = new MockResponse(),
): Promise<{ response: MockResponse; nextCalls: number }> {
  let nextCalls = 0;
  await guard(
    { userId } as Request,
    response as unknown as Response,
    (() => {
      nextCalls += 1;
    }) as NextFunction,
  );
  return { response, nextCalls };
}

async function flushAsyncEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("createSharedAiUsageGuard", () => {
  beforeEach(() => resetSharedAiUsageMetricsForTests());

  it("requires an authenticated user before consulting the shared store", async () => {
    const result = await invoke(
      createSharedAiUsageGuard({
        store: new MemorySharedStore(),
        renewLeases: false,
      }),
      undefined,
    );
    expect(result.nextCalls).toBe(0);
    expect(result.response.statusCode).toBe(401);
  });

  it("shares concurrency across independent middleware instances and releases on close", async () => {
    const store = new MemorySharedStore();
    const firstGuard = createSharedAiUsageGuard({
      store,
      maxConcurrent: 1,
      maxRequests: 0,
      renewLeases: false,
    });
    const secondGuard = createSharedAiUsageGuard({
      store,
      maxConcurrent: 1,
      maxRequests: 0,
      renewLeases: false,
    });

    const first = await invoke(firstGuard, "shared-user");
    expect(first.nextCalls).toBe(1);

    const blocked = await invoke(secondGuard, "shared-user");
    expect(blocked.nextCalls).toBe(0);
    expect(blocked.response.statusCode).toBe(429);
    expect(blocked.response.headers.get("retry-after")).toBeTruthy();

    // `close` covers an aborted SSE request, where `finish` may never fire.
    first.response.emit("close");
    await flushAsyncEvents();
    expect((await invoke(secondGuard, "shared-user")).nextCalls).toBe(1);
  });

  it("uses a deterministic fixed request window shared by guard instances", async () => {
    const store = new MemorySharedStore();
    let timestamp = 1_000;
    const makeGuard = () =>
      createSharedAiUsageGuard({
        store,
        maxConcurrent: 0,
        maxRequests: 1,
        windowMs: 60_000,
        now: () => timestamp,
        renewLeases: false,
      });

    expect((await invoke(makeGuard(), "rate-user")).nextCalls).toBe(1);
    const blocked = await invoke(makeGuard(), "rate-user");
    expect(blocked.response.statusCode).toBe(429);
    expect(blocked.response.headers.get("retry-after")).toBe("59");

    timestamp = 60_001;
    expect((await invoke(makeGuard(), "rate-user")).nextCalls).toBe(1);
  });

  it("recovers stale concurrency leases after their TTL", async () => {
    const store = new MemorySharedStore();
    let timestamp = 1_000;
    const guard = createSharedAiUsageGuard({
      store,
      maxConcurrent: 1,
      maxRequests: 0,
      leaseTtlMs: 1_000,
      now: () => timestamp,
      renewLeases: false,
    });

    expect((await invoke(guard, "stale-user")).nextCalls).toBe(1);
    expect((await invoke(guard, "stale-user")).response.statusCode).toBe(429);

    timestamp = 2_001;
    expect((await invoke(guard, "stale-user")).nextCalls).toBe(1);
  });

  it("fails closed when the shared limiter backend is unavailable", async () => {
    const store: SharedAiUsageStore = {
      acquire: async () => {
        throw new Error("database unavailable");
      },
      renewLease: async () => false,
      releaseLease: async () => undefined,
    };
    const result = await invoke(
      createSharedAiUsageGuard({ store, renewLeases: false }),
      "user-1",
    );
    expect(result.nextCalls).toBe(0);
    expect(result.response.statusCode).toBe(503);
    expect(result.response.headers.get("retry-after")).toBe("1");
    expect(getSharedAiUsageMetrics().backendFailures).toBe(1);
  });
});
