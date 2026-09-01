import { describe, expect, it, vi } from "vitest";
import {
  shouldVerifySearchBackedAnswer,
  verifySearchBackedAnswer,
} from "./chat-stream-factuality";

describe("shouldVerifySearchBackedAnswer", () => {
  it("requires evidence and skips translation or file generation", () => {
    expect(
      shouldVerifySearchBackedAnswer({
        translationMode: false,
        sourceCount: 1,
        sourceText: "[1] evidence",
        generatesFile: false,
      }),
    ).toBe(true);
    expect(
      shouldVerifySearchBackedAnswer({
        translationMode: false,
        sourceCount: 1,
        sourceText: "[1] evidence",
        generatesFile: true,
      }),
    ).toBe(false);
  });
});

describe("verifySearchBackedAnswer", () => {
  it("applies a validated correction and emits the final report", async () => {
    const emit = vi.fn();
    const controller = new AbortController();
    const streamText = vi.fn().mockResolvedValue(
      JSON.stringify({
        claims: [
          {
            claim: "旧値は10です。",
            verdict: "contradicted",
            sourceIds: [1],
            reason: "根拠では12",
          },
        ],
        operations: [{ find: "旧値は10です。", replacement: "新値は12です。" }],
      }),
    );

    const result = await verifySearchBackedAnswer({
      client: {} as never,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      question: "値は？",
      answer: "旧値は10です。",
      sourceText: "[1] 新値は12です。",
      sourceCount: 1,
      signal: controller.signal,
      clientGone: () => false,
      emit,
      streamText,
      withTimeout: (create) => create(controller.signal),
    });

    expect(result.content).toBe("新値は12です。");
    expect(result.factuality.corrected).toBe(true);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ status: "revising" }),
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ factuality: result.factuality }),
    );
  });
});
