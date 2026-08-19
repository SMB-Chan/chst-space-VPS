import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { createAiUsageGuard } from "./aiUsageGuard";

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

function invoke(
  guard: ReturnType<typeof createAiUsageGuard>,
  userId: string | undefined,
  response = new MockResponse(),
): { response: MockResponse; nextCalls: number } {
  let nextCalls = 0;
  guard(
    { userId } as Request,
    response as unknown as Response,
    (() => {
      nextCalls += 1;
    }) as NextFunction,
  );
  return { response, nextCalls };
}

describe("createAiUsageGuard", () => {
  it("requires an authenticated user", () => {
    const result = invoke(createAiUsageGuard(), undefined);
    expect(result.nextCalls).toBe(0);
    expect(result.response.statusCode).toBe(401);
  });

  it("limits concurrent SSE requests and releases on finish", () => {
    const guard = createAiUsageGuard({ maxConcurrent: 1, maxRequests: 10 });
    const first = invoke(guard, "user-1");
    expect(first.nextCalls).toBe(1);

    const blocked = invoke(guard, "user-1");
    expect(blocked.nextCalls).toBe(0);
    expect(blocked.response.statusCode).toBe(429);
    expect(blocked.response.headers.get("retry-after")).toBe("1");

    first.response.emit("finish");
    expect(invoke(guard, "user-1").nextCalls).toBe(1);
  });

  it("enforces a sliding request window", () => {
    let timestamp = 1_000;
    const guard = createAiUsageGuard({
      maxConcurrent: 0,
      maxRequests: 2,
      windowMs: 60_000,
      now: () => timestamp,
    });

    const first = invoke(guard, "user-1");
    first.response.emit("finish");
    const second = invoke(guard, "user-1");
    second.response.emit("finish");
    expect(invoke(guard, "user-1").response.statusCode).toBe(429);

    timestamp += 60_001;
    expect(invoke(guard, "user-1").nextCalls).toBe(1);
  });

  it("isolates counters by user", () => {
    const guard = createAiUsageGuard({ maxConcurrent: 1, maxRequests: 10 });
    expect(invoke(guard, "user-1").nextCalls).toBe(1);
    expect(invoke(guard, "user-2").nextCalls).toBe(1);
  });
});
