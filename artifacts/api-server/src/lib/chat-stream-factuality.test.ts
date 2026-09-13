import { describe, expect, it, vi } from "vitest";
import {
  hasVerifiableDataClaims,
  isLowRiskAnswer,
  riskGateEnabled,
  shouldVerifySearchBackedAnswer,
  verifySearchBackedAnswer,
} from "./chat-stream-factuality";

describe("risk gate", () => {
  it("flags numeric, date, currency, and quantity markers as data claims", () => {
    expect(hasVerifiableDataClaims("売上は100億円です。")).toBe(true);
    expect(hasVerifiableDataClaims("2026年に発表された")).toBe(true);
    expect(hasVerifiableDataClaims("占有率は50％")).toBe(true);
    expect(hasVerifiableDataClaims("価格は2ドル")).toBe(true);
    expect(hasVerifiableDataClaims("概念を説明する短い回答です。")).toBe(false);
  });

  it("treats short data-free drafts as low risk", () => {
    expect(isLowRiskAnswer("これは概念的な説明です。")).toBe(true);
    expect(isLowRiskAnswer("売上は100億円です。")).toBe(false);
    expect(isLowRiskAnswer(`${"あ".repeat(1300)}`)).toBe(false);
  });

  it("is enabled unless explicitly disabled", () => {
    expect(riskGateEnabled()).toBe(true);
    process.env.FACTUALITY_RISK_GATE = "off";
    expect(riskGateEnabled()).toBe(false);
    delete process.env.FACTUALITY_RISK_GATE;
    expect(riskGateEnabled()).toBe(true);
  });
});

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
