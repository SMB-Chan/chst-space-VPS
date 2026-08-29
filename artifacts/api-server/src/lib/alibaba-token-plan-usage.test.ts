import { describe, expect, it, vi } from "vitest";
import {
  AlibabaTokenPlanQuotaGuardError,
  MODEL_STUDIO_DASHSCOPE_BASE_URL,
  TOKEN_PLAN_DASHSCOPE_BASE_URL,
  assessAlibabaTokenPlanQuota,
  classifyAlibabaDashScopeKey,
  createAlibabaTokenPlanQuotaGuardedFetch,
  fetchAlibabaTokenPlanUsage,
  isHeavyAlibabaChatRequest,
  resolveAlibabaDashScopeBaseUrl,
} from "./alibaba-token-plan-usage";

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ALIBABA_TOKEN_PLAN_QUOTA_GUARD: "1",
    ALIBABA_CONSOLE_ACCESS_TOKEN: "console-secret",
    DASHSCOPE_API_KEY: "sk-sp-test",
    ...overrides,
  };
}

function quotaResponse(weeklyUsed: number, fiveHourUsed = 0.2) {
  return new Response(
    JSON.stringify({
      data: {
        DataV2: {
          success: true,
          data: {
            code: "SUCCESS",
            success: true,
            data: {
              per1WeekPercentage: weeklyUsed,
              per1WeekResetTime: 1_788_000_000_000,
              ...(fiveHourUsed !== undefined
                ? {
                    per5HourPercentage: fiveHourUsed,
                    per5HourResetTime: 1_787_980_000_000,
                  }
                : {}),
            },
          },
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("Alibaba Token Plan quota telemetry", () => {
  it("reads the provider's weekly percentage and reset time from the official console gateway shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(quotaResponse(0.33, 0.2));
    const snapshot = await fetchAlibabaTokenPlanUsage(env(), fetchImpl as typeof fetch);

    expect(snapshot?.weeklyUsedPercent).toBeCloseTo(33);
    expect(snapshot?.weeklyRemainingPercent).toBeCloseTo(67);
    expect(snapshot?.fiveHourRemainingPercent).toBeCloseTo(80);
    expect(snapshot?.weeklyResetAt).toMatch(/^2026-/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://bailian-singapore-cs.alibabacloud.com/cli/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage",
    );
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer console-secret");
    expect(String(init.body)).toContain("ap-southeast-1");
  });

  it("accepts percentage values already expressed on a 0-100 scale", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(quotaResponse(79.25));
    const snapshot = await fetchAlibabaTokenPlanUsage(env(), fetchImpl as typeof fetch);
    expect(snapshot?.weeklyRemainingPercent).toBeCloseTo(20.75);
  });

  it("rejects an incomplete response instead of exposing partial quota", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { per1WeekPercentage: 0.2 } }), { status: 200 }),
    );
    await expect(fetchAlibabaTokenPlanUsage(env(), fetchImpl as typeof fetch)).rejects.toThrow(
      "both quota windows",
    );
  });

  it("rejects non-success responses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    await expect(fetchAlibabaTokenPlanUsage(env(), fetchImpl as typeof fetch)).rejects.toThrow(
      "HTTP 503",
    );
  });

  it("aborts a quota request that exceeds the configured timeout", async () => {
    const fetchImpl = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new Error("aborted")),
            { once: true },
          );
        }),
    );
    await expect(
      fetchAlibabaTokenPlanUsage(env({ ALIBABA_TOKEN_PLAN_QUOTA_TIMEOUT_MS: "1" }), fetchImpl),
    ).rejects.toThrow();
  });

  it("returns null when the console credential is not configured", async () => {
    const fetchImpl = vi.fn();
    const snapshot = await fetchAlibabaTokenPlanUsage(
      env({ ALIBABA_CONSOLE_ACCESS_TOKEN: "" }),
      fetchImpl as typeof fetch,
    );
    expect(snapshot).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the stricter active window for the decision", () => {
    const assessment = assessAlibabaTokenPlanQuota(
      {
        checkedAt: new Date().toISOString(),
        weeklyRemainingPercent: 40,
        fiveHourRemainingPercent: 8,
      },
      true,
      env(),
    );
    expect(assessment.decision).toBe("block");
    expect(assessment.limitingWindow).toBe("5-hour");
    expect(assessment.remainingPercent).toBe(8);
  });

  it("warns rather than blocks normal requests when weekly headroom is low", () => {
    const assessment = assessAlibabaTokenPlanQuota(
      {
        checkedAt: new Date().toISOString(),
        weeklyRemainingPercent: 7,
        fiveHourRemainingPercent: 80,
      },
      false,
      env(),
    );
    expect(assessment.decision).toBe("warn");
  });

  it("treats a partial snapshot as unavailable", () => {
    const assessment = assessAlibabaTokenPlanQuota(
      { checkedAt: new Date().toISOString(), weeklyRemainingPercent: 7 },
      false,
      env(),
    );
    expect(assessment.decision).toBe("unknown");
  });

  it("lets operators tune the heavy-request floor", () => {
    const assessment = assessAlibabaTokenPlanQuota(
      {
        checkedAt: new Date().toISOString(),
        weeklyRemainingPercent: 18,
        fiveHourRemainingPercent: 80,
      },
      true,
      env({
        ALIBABA_TOKEN_PLAN_WARN_REMAINING_PERCENT: "30",
        ALIBABA_TOKEN_PLAN_BLOCK_HEAVY_REMAINING_PERCENT: "20",
      }),
    );
    expect(assessment.decision).toBe("block");
  });
});

describe("Alibaba heavy chat classification", () => {
  it("keeps normal short chat below the heavy threshold", () => {
    expect(
      isHeavyAlibabaChatRequest({
        model: "qwen3.8-max",
        messages: [{ role: "user", content: "短い質問です" }],
        extra_body: { enable_thinking: true, reasoning_effort: "medium" },
      }),
    ).toBe(false);
  });

  it("classifies long high-reasoning context as heavy", () => {
    expect(
      isHeavyAlibabaChatRequest({
        model: "qwen3.8-max",
        messages: [{ role: "user", content: "x".repeat(9_000) }],
        extra_body: { enable_thinking: true, reasoning_effort: "xhigh" },
      }),
    ).toBe(true);
  });

  it("classifies multiple vision inputs as heavy", () => {
    expect(
      isHeavyAlibabaChatRequest({
        model: "qwen3.8-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "compare" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
              { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
            ],
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("Alibaba quota-aware fetch", () => {
  it("blocks a heavy Token Plan chat request before invoking the model when remaining quota is critical", async () => {
    const modelFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const quotaFetch = vi.fn().mockResolvedValue(quotaResponse(0.95));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = quotaFetch as typeof fetch;
    try {
      const guarded = createAlibabaTokenPlanQuotaGuardedFetch(modelFetch as typeof fetch, env());
      await expect(
        guarded("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "qwen3.8-max",
            messages: [{ role: "user", content: "x".repeat(32_000) }],
          }),
        }),
      ).rejects.toBeInstanceOf(AlibabaTokenPlanQuotaGuardError);
      expect(modelFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not consult quota telemetry for non-Token-Plan keys", async () => {
    const modelFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const guarded = createAlibabaTokenPlanQuotaGuardedFetch(
      modelFetch as typeof fetch,
      env({ DASHSCOPE_API_KEY: "sk-regular" }),
    );
    await guarded("https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "qwen3.8-max", messages: [] }),
    });
    expect(modelFetch).toHaveBeenCalledTimes(1);
  });

  it("blocks a heavy request when quota telemetry is unavailable by default", async () => {
    const modelFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const quotaFetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = quotaFetch as typeof fetch;
    try {
      const guarded = createAlibabaTokenPlanQuotaGuardedFetch(modelFetch as typeof fetch, env());
      await expect(
        guarded("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "qwen3.8-max",
            messages: [{ role: "user", content: "x".repeat(32_000) }],
          }),
        }),
      ).rejects.toBeInstanceOf(AlibabaTokenPlanQuotaGuardError);
      expect(modelFetch).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows a small request when quota telemetry is unavailable", async () => {
    const modelFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const quotaFetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = quotaFetch as typeof fetch;
    try {
      const guarded = createAlibabaTokenPlanQuotaGuardedFetch(modelFetch as typeof fetch, env());
      await guarded("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "qwen3.8-max", messages: [{ role: "user", content: "short" }] }),
      });
      expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows a heavy request only with the explicit fail-open override", async () => {
    const modelFetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const quotaFetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = quotaFetch as typeof fetch;
    try {
      const guarded = createAlibabaTokenPlanQuotaGuardedFetch(
        modelFetch as typeof fetch,
        env({ ALIBABA_TOKEN_PLAN_QUOTA_FAIL_OPEN: "1" }),
      );
      await guarded("https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "qwen3.8-max",
          messages: [{ role: "user", content: "x".repeat(32_000) }],
        }),
      });
      expect(modelFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("Alibaba DashScope credential routing", () => {
  it.each([
    ["sk-sp-token-plan", "token-plan"],
    ["sk-regular-model-studio", "model-studio"],
    ["opaque-key", "unknown"],
    ["", "unknown"],
  ] as const)("classifies %s without exposing it", (key, expected) => {
    expect(classifyAlibabaDashScopeKey(key)).toBe(expected);
  });

  it("selects the Token Plan default for a Token Plan key", () => {
    expect(resolveAlibabaDashScopeBaseUrl({ DASHSCOPE_API_KEY: "sk-sp-token-plan" })).toBe(
      TOKEN_PLAN_DASHSCOPE_BASE_URL,
    );
  });

  it("selects the Model Studio default for a regular key", () => {
    expect(resolveAlibabaDashScopeBaseUrl({ DASHSCOPE_API_KEY: "sk-regular-model-studio" })).toBe(
      MODEL_STUDIO_DASHSCOPE_BASE_URL,
    );
  });

  it("accepts matching explicit endpoints", () => {
    expect(
      resolveAlibabaDashScopeBaseUrl({
        DASHSCOPE_API_KEY: "sk-sp-token-plan",
        DASHSCOPE_BASE_URL: `${TOKEN_PLAN_DASHSCOPE_BASE_URL}/`,
      }),
    ).toBe(TOKEN_PLAN_DASHSCOPE_BASE_URL);
    expect(
      resolveAlibabaDashScopeBaseUrl({
        DASHSCOPE_API_KEY: "sk-regular-model-studio",
        DASHSCOPE_BASE_URL: MODEL_STUDIO_DASHSCOPE_BASE_URL,
      }),
    ).toBe(MODEL_STUDIO_DASHSCOPE_BASE_URL);
  });

  it.each([
    ["sk-sp-token-plan", MODEL_STUDIO_DASHSCOPE_BASE_URL],
    ["sk-regular-model-studio", TOKEN_PLAN_DASHSCOPE_BASE_URL],
  ] as const)("fails closed for a known key/endpoint mismatch", (key, baseURL) => {
    expect(() => resolveAlibabaDashScopeBaseUrl({ DASHSCOPE_API_KEY: key, DASHSCOPE_BASE_URL: baseURL }))
      .toThrow();
  });

  it("fails closed for an unknown key format without including the key", () => {
    const key = "opaque-secret-value";
    expect(() => resolveAlibabaDashScopeBaseUrl({ DASHSCOPE_API_KEY: key })).toThrow(
      /unsupported key format/,
    );
    try {
      resolveAlibabaDashScopeBaseUrl({ DASHSCOPE_API_KEY: key });
    } catch (error) {
      expect(String(error)).not.toContain(key);
    }
  });
});