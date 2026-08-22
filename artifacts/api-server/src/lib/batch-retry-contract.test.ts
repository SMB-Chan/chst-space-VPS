import { describe, expect, it, vi } from "vitest";
import {
  batchProcess,
  batchProcessWithSSE,
} from "@workspace/integrations-openai-ai-server/batch";

describe("batch retry contract", () => {
  it("retries rate-limit failures in batchProcess", async () => {
    let attempts = 0;

    const result = await batchProcess(
      ["item"],
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("429 rate limit");
        return "ok";
      },
      { retries: 3, minTimeout: 0, maxTimeout: 0 },
    );

    expect(attempts).toBe(3);
    expect(result).toEqual(["ok"]);
  });

  it("does not retry deterministic failures in batchProcess", async () => {
    let attempts = 0;

    await expect(
      batchProcess(
        ["item"],
        async () => {
          attempts += 1;
          throw new Error("validation failed");
        },
        { retries: 3, minTimeout: 0, maxTimeout: 0 },
      ),
    ).rejects.toBeInstanceOf(Error);

    expect(attempts).toBe(1);
  });

  it("retries rate-limit failures in the SSE path", async () => {
    let attempts = 0;
    const sendEvent = vi.fn();

    const result = await batchProcessWithSSE(
      ["item"],
      async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("RATELIMIT_EXCEEDED");
        return "ok";
      },
      sendEvent,
      { retries: 2, minTimeout: 0, maxTimeout: 0 },
    );

    expect(attempts).toBe(2);
    expect(result).toEqual(["ok"]);
    expect(sendEvent).toHaveBeenLastCalledWith({
      type: "complete",
      processed: 1,
      errors: 0,
    });
  });

  it("aborts non-rate-limit failures after one SSE attempt", async () => {
    let attempts = 0;
    const sendEvent = vi.fn();

    const result = await batchProcessWithSSE(
      ["item"],
      async () => {
        attempts += 1;
        throw new Error("validation failed");
      },
      sendEvent,
      { retries: 2, minTimeout: 0, maxTimeout: 0 },
    );

    expect(attempts).toBe(1);
    expect(result).toEqual([undefined]);
    expect(sendEvent).toHaveBeenLastCalledWith({
      type: "complete",
      processed: 1,
      errors: 1,
    });
  });
});
