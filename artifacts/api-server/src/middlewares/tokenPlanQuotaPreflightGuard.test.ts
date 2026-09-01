import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOKEN_PLAN_QUOTA_RESPONSE_HEADERS,
  assessAlibabaLargeTurnQuota,
  estimateAlibabaTokenPlanTurn,
  shouldBlockWithoutQuotaTelemetry,
  tokenPlanQuotaHeaders,
  tokenPlanQuotaPreflightGuard,
  tokenPlanQuotaStatusHeaders,
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
    expect(shouldBlockWithoutQuotaTelemetry(result)).toBe(false);
  });

  it("still requires telemetry for a long audited Token Plan turn", () => {
    const result = estimateAlibabaTokenPlanTurn({
      rootModelId: "qwen3.8-max",
      auditModelId: "glm-5.2",
      content: "x".repeat(20_000),
    });
    expect(result.reasons).toEqual(
      expect.arrayContaining(["long-context", "multi-model-turn"]),
    );
    expect(shouldBlockWithoutQuotaTelemetry(result)).toBe(true);
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
      {
        checkedAt: new Date().toISOString(),
        weeklyRemainingPercent: 18,
        fiveHourRemainingPercent: 80,
      },
      env(),
    );
    expect(result.decision).toBe("block");
    expect(result.limitingWindow).toBe("1-week");
  });

  it("warns in the reserve band without blocking", () => {
    const result = assessAlibabaLargeTurnQuota(
      {
        checkedAt: new Date().toISOString(),
        weeklyRemainingPercent: 30,
        fiveHourRemainingPercent: 80,
      },
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
      {
        checkedAt: new Date().toISOString(),
        weeklyRemainingPercent: 27,
        fiveHourRemainingPercent: 80,
      },
      env({ ALIBABA_TOKEN_PLAN_BLOCK_LARGE_TURN_REMAINING_PERCENT: "30" }),
    );
    expect(result.decision).toBe("block");
  });

  it("returns unknown when provider telemetry is unavailable", () => {
    expect(assessAlibabaLargeTurnQuota(null, env()).decision).toBe("unknown");
  });

  it("returns unknown when one required quota window is missing", () => {
    expect(
      assessAlibabaLargeTurnQuota(
        { checkedAt: new Date().toISOString(), weeklyRemainingPercent: 80 },
        env(),
      ).decision,
    ).toBe("unknown");
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
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.weeklyRemaining]).toBe(
      "67.3",
    );
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.fiveHourRemaining]).toBe(
      "42.5",
    );
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.weeklyReset]).toBe(
      "2026-09-03T12:00:00.000Z",
    );
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.fiveHourReset]).toBe(
      "2026-08-28T04:00:00.000Z",
    );
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.limitingWindow]).toBe(
      "5-hour",
    );
    expect(headers[TOKEN_PLAN_QUOTA_RESPONSE_HEADERS.limitingRemaining]).toBe(
      "42.5",
    );
    expect(
      Object.keys(headers).some((name) =>
        /token|authorization|key/i.test(name.replace("Token-Plan", "")),
      ),
    ).toBe(false);
  });

  it("returns no telemetry headers when quota is unavailable", () => {
    expect(tokenPlanQuotaHeaders(null)).toEqual({});
  });

  it("returns no headers when either required quota window is missing", () => {
    expect(
      tokenPlanQuotaHeaders({
        checkedAt: new Date().toISOString(),
        weeklyRemainingPercent: 80,
      }),
    ).toEqual({});
  });
});

function mockRes(): {
  res: {
    status: ReturnType<typeof vi.fn>;
    json: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
  };
  next: ReturnType<typeof vi.fn>;
} {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn(),
  };
  const next = vi.fn();
  return { res, next };
}

describe("tokenPlanQuotaPreflightGuard middleware integration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.stubEnv("ALIBABA_TOKEN_PLAN_QUOTA_GUARD", "1");
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-sp-test-token-plan-key");
    vi.stubEnv("ALIBABA_TOKEN_PLAN_WARN_LARGE_TURN_REMAINING_PERCENT", "35");
    vi.stubEnv("ALIBABA_TOKEN_PLAN_BLOCK_LARGE_TURN_REMAINING_PERCENT", "20");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("passes through immediately for non-Token-Plan keys", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-regular-model-studio-key");
    const { res, next } = mockRes();
    const req = {
      body: { modelId: "qwen3.8-max", content: "x".repeat(5000) },
      query: {},
    } as never;
    await tokenPlanQuotaPreflightGuard(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("passes through for small turns without querying quota", async () => {
    const { res, next } = mockRes();
    const req = {
      body: { modelId: "qwen3.8-max", content: "短い質問" },
      query: {},
    } as never;
    await tokenPlanQuotaPreflightGuard(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 503 for large turns when quota telemetry is unavailable", async () => {
    vi.doMock("../lib/alibaba-token-plan-usage", async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import("../lib/alibaba-token-plan-usage")
        >();
      return {
        ...actual,
        getAlibabaTokenPlanUsage: vi.fn().mockResolvedValue(null),
      };
    });
    const { res, next } = mockRes();
    const req = {
      body: { modelId: "qwen3.8-max", content: "x".repeat(5000) },
      query: { reasoning: "high" },
    } as never;
    await tokenPlanQuotaPreflightGuard(req, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("残量を確認できない"),
      }),
    );
  });

  it("allows a short two-model audit when optional quota telemetry is unavailable", async () => {
    vi.stubEnv("ALIBABA_CONSOLE_ACCESS_TOKEN", "");
    const { res, next } = mockRes();
    const req = {
      body: { modelId: "qwen3.8-max", content: "短い質問" },
      query: { auditModel: "glm-5.2", reasoning: "medium" },
    } as never;
    await tokenPlanQuotaPreflightGuard(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it("passes through for large turns when fail-open override is enabled and telemetry is unavailable", async () => {
    vi.stubEnv("ALIBABA_TOKEN_PLAN_QUOTA_FAIL_OPEN", "1");
    vi.doMock("../lib/alibaba-token-plan-usage", async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import("../lib/alibaba-token-plan-usage")
        >();
      return {
        ...actual,
        getAlibabaTokenPlanUsage: vi.fn().mockResolvedValue(null),
      };
    });
    const { res, next } = mockRes();
    const req = {
      body: { modelId: "qwen3.8-max", content: "x".repeat(5000) },
      query: { reasoning: "high" },
    } as never;
    await tokenPlanQuotaPreflightGuard(req, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe("tokenPlanQuotaStatusHeaders middleware integration", () => {
  beforeEach(() => {
    vi.stubEnv("ALIBABA_TOKEN_PLAN_QUOTA_GUARD", "1");
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-sp-test-token-plan-key");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("skips quota headers for non-Token-Plan keys", async () => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-regular-key");
    const { res, next } = mockRes();
    await tokenPlanQuotaStatusHeaders({} as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it("calls next without setting headers when telemetry throws", async () => {
    vi.doMock("../lib/alibaba-token-plan-usage", async (importOriginal) => {
      const actual =
        await importOriginal<
          typeof import("../lib/alibaba-token-plan-usage")
        >();
      return {
        ...actual,
        getAlibabaTokenPlanUsage: vi
          .fn()
          .mockRejectedValue(new Error("network")),
      };
    });
    const { res, next } = mockRes();
    await tokenPlanQuotaStatusHeaders({} as never, res as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});
