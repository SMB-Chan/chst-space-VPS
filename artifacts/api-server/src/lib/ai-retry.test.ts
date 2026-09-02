import { describe, expect, it } from "vitest";
import {
  getAiRetryAfterMs,
  getAiRetryDelayMs,
  getAiStreamRetryConfig,
  safeAiFailureFields,
  waitForAiRetry,
} from "./ai-retry";

describe("safeAiFailureFields", () => {
  it("classifies nested transport failures without exposing messages", () => {
    const error = Object.assign(new Error("Connection error."), {
      cause: Object.assign(new Error("other side closed"), {
        code: "ECONNRESET",
      }),
    });

    expect(safeAiFailureFields(error)).toEqual({
      failureKind: "connection-reset",
      transportCode: "ECONNRESET",
    });
  });

  it("preserves only safe upstream status and request identifiers", () => {
    const error = Object.assign(new Error("secret provider details"), {
      status: 503,
      request_id: "req_safe-123",
    });

    expect(safeAiFailureFields(error)).toEqual({
      failureKind: "upstream-5xx",
      upstreamStatus: 503,
      upstreamRequestId: "req_safe-123",
    });
  });
});

describe("AI stream retry policy", () => {
  it("uses bounded exponential backoff with jitter", () => {
    const config = { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 3_000 };
    expect(
      getAiRetryDelayMs(new Error("network error"), 1, config, () => 0),
    ).toBe(300);
    expect(
      getAiRetryDelayMs(new Error("network error"), 2, config, () => 1),
    ).toBe(800);
  });

  it("honors a bounded provider Retry-After header", () => {
    const error = Object.assign(new Error("upstream unavailable"), {
      status: 503,
      headers: new Headers({ "retry-after-ms": "1250" }),
    });
    expect(getAiRetryAfterMs(error)).toBe(1_250);
    expect(
      getAiRetryDelayMs(
        error,
        1,
        { maxAttempts: 3, baseDelayMs: 400, maxDelayMs: 3_000 },
        () => 0,
      ),
    ).toBe(1_250);
  });

  it("bounds environment configuration", () => {
    expect(
      getAiStreamRetryConfig({
        AI_STREAM_MAX_ATTEMPTS: "4",
        AI_STREAM_RETRY_BASE_MS: "250",
        AI_STREAM_RETRY_MAX_MS: "2000",
      }),
    ).toEqual({
      maxAttempts: 4,
      baseDelayMs: 250,
      maxDelayMs: 2_000,
    });
    expect(
      getAiStreamRetryConfig({
        AI_STREAM_MAX_ATTEMPTS: "99",
        AI_STREAM_RETRY_BASE_MS: "-1",
      }),
    ).toEqual({
      maxAttempts: 5,
      baseDelayMs: 750,
      maxDelayMs: 6_000,
    });
  });

  it("stops waiting when the request has already been cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(waitForAiRetry(10_000, controller.signal)).resolves.toBe(
      false,
    );
  });
});
