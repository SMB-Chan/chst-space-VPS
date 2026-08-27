import { describe, expect, it } from "vitest";
import {
  TOKEN_PLAN_QUOTA_RESPONSE_HEADERS,
  assessAlibabaLargeTurnQuota,
  estimateAlibabaTokenPlanTurn,
  tokenPlanQuotaHeaders,
} from "./tokenPlanQuotaPreflightGuard";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ALIBABA_TOKEN_PLAN_WARN_LARGE_TURN_REMAINING_PERCENT: "35",
    ALIBABA_TOKEN_PLAN_BLOCK_LARGE_TURN_REMAINING_PERCENT: "20",
    ...overrides,
  };
}

describe("Token Plan large-turn estimation", () => {
  it("keeps an ordinary short Qwen turn out of the early preflight", () => {
    expect(
      estimateAlibabaTokenPlanTurn({
        rootModelId: "qwen3.8-max",
        reasoningLevel: "medium",
        content: "短い質問です",
      }),
    ).toMatchObject({ large: false, tokenPlanCalls: 1 });
  });

  it("classifies long high-reasoning Qwen context as large", () => {
    const result = estimateAlibabaTokenPlanTurn({
      rootModelId: "qwen3.8-max",
      reasoningLevel: "high",
      content: "x".repeat(5_000),
    });
    expect(result.large).toBe(true);
    expect(result.reasons).toContain("high-reasoning-context");
  });

  it("classifies explicit file generation as a large multi-step turn", () => {
    const result = estimateAlibabaTokenPlanTurn({
      rootModelId: "deepseek-v4-pro",
      reasoningLevel: "medium",
      content: "この内容を報告書にして",
      fileFormat: "pdf",
    });
    expect(result.large).toBe(true);
    expect(result.reasons).toContain("file-generation");
  });

  it("reserves more headroom for two Token Plan models in one turn", () => {
    const result = estimateAlibabaTokenPlanTurn({
      rootModelId: "qwen3.8-max",
      auditModelId: "glm-5.2",
      content: "検証して答えて",
    });
    expect(result.large).toBe(true);
    expect(result.tokenPlanCalls).toBe(2);
    expect(result.reasons).toContain("multi-model-turn");
  });

  it("does not treat a regular OpenAI root plus Alibaba audit as an early-blocking large root turn", () => {
    const result = estimateAlibabaTokenPlanTurn({
      rootModelId: "gpt-5.6-terra",
      auditModelId: "qwen3.8-flash",
      content: "短い質問",
    });
    expect(result.tokenPlanCalls).toBe(1);
    expect(result.large).toBe(false);
  });

  it("classifies multiple image attachments as large for a Token Plan vision model", () => {
    const result = estimateAlibabaTokenPlanTurn({
      rootModelId: "qwen3.8-flash",
      content: "比較して",
      attachments: [
        { kind: "image", name: "a.png" },
        { kind: "image", name: "b.png" },
      ],
    });
    expect(result.large).toBe(true);
    expect(result.imageAttachmentCount).toBe(2);
    expect(result.reasons).toContain("multi-image");
  });
});

describe("Token Plan large-turn quota decision", () => {
  it("blocks a large turn before downstream work when remaining quota is below the reserve", () => {
    const result = assessAlibabaLargeTurnQuota(
      { checkedAt: new Date().toISOString(), weeklyRemainingPercent: 18 },
      env(),
    );
    expect(result.decision).toBe("block");
    expect(result.limitingWindow).toBe("1-week");
  });

  it("warns in the reserve band without blocking", () => {
    const result = assessAlibabaLargeTurnQuota(
      { checkedAt: new Date().toISOString(), weeklyRemainingPercent: 30 },
      env(),
    );
    expect(result.decision).toBe("warn");
  });

  it("uses the stricter active window", () => {
    const result = assessAlibabaLargeTurnQuota(
      {
        checkedAt: new Date().toISOString(),
        weeklyRemainingPercent: 60,
        fiveHourRemainingPercent: 12,
      },
      env(),
    );
    expect(result.decision).toBe("block");
    expect(result.limitingWindow).toBe("5-hour");
    expect(result.remainingPercent).toBe(12);
  });

  it("lets operators tune the large-turn reserve", () => {
    const result = assessAlibabaLargeTurnQuota(
      { checkedAt: new Date().toISOString(), weeklyRemainingPercent: 27 },
      env({ ALIBABA_TOKEN_PLAN_BLOCK_LARGE_TURN_REMAINING_PERCENT: "30" }),
    );
    expect(result.decision).toBe("block");
  });

  it("returns unknown when provider telemetry is unavailable", () => {
    expect(assessAlibabaLargeTurnQuota(null, env()).decision).toBe("unknown");
  });
});

describe("Token Plan browser-safe quota headers", () => {
  it("exposes remaining percentages and reset timestamps without provider credentials", () => {
    const headers = tokenPlanQuotaHeaders({
      checkedAt: "2026-08-28T00:00:00.000Z",
      weeklyRemainingPercent: 67.25,
      weeklyResetAt: "2026-09-03T12:00:00.000Z",
      fiveHourRemainingPercent: 42.5,
      fiveHourResetAt: "2026-08-28T04:00:00.000Z",
    });
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.weeklyRemaining]).toBe("67.3");
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.fiveHourRemaining]).toBe("42.5");
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.weeklyReset]).toBe("2026-09-03T12:00:00.000Z");
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.fiveHourReset]).toBe("2026-08-28T04:00:00.000Z");
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.limitingWindow]).toBe("5-hour");
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.limitingRemaining]).toBe("42.5");
    expect(Object.keys(headers).some((name) => /token|authorization|key/i.test(name.replace("Token-Plan", "")))).toBe(false);
  });

  it("returns no telemetry headers when quota is unavailable", () => {
    expect(tokenPlanQuotaHeaders(null)).toEqual({});
  });
});