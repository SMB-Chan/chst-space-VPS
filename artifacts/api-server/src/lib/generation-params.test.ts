import { describe, expect, it } from "vitest";
import {
  applyGenerationParams,
  applyNonReasoningGenerationParams,
  applySafeGenerationParams,
  isUnsupportedGenerationParam,
} from "./ai-clients";

describe("applyGenerationParams", () => {
  it("does not send reasoning_effort to gpt-5.6 models", () => {
    const opts: Record<string, unknown> = {};
    applyGenerationParams(opts, "gpt-5.6-terra", "openai", "medium");
    expect(opts.reasoning_effort).toBeUndefined();
    expect(opts.max_completion_tokens).toBe(8192);
  });

  it("sends reasoning_effort only for o-series", () => {
    const opts: Record<string, unknown> = {};
    applyGenerationParams(opts, "o4-mini", "openai", "high");
    expect(opts.reasoning_effort).toBe("high");
  });
});

describe("isUnsupportedGenerationParam", () => {
  it("detects OpenAI unsupported-parameter errors", () => {
    expect(
      isUnsupportedGenerationParam(
        Object.assign(new Error("Unsupported parameter: 'reasoning_effort'"), {
          status: 400,
        }),
      ),
    ).toBe(true);
  });
});

describe("applySafeGenerationParams", () => {
  it("strips extra_body and reasoning_effort", () => {
    const opts: Record<string, unknown> = {
      extra_body: { enable_thinking: true },
      reasoning_effort: "medium",
    };
    applySafeGenerationParams(opts, "dashscope");
    expect(opts.reasoning_effort).toBeUndefined();
    expect(opts.extra_body).toEqual({ incremental_output: true });
  });
});

describe("applyNonReasoningGenerationParams", () => {
  it("explicitly disables DashScope thinking for an empty-response retry", () => {
    const opts: Record<string, unknown> = {
      extra_body: { enable_thinking: true, thinking_budget: 8192 },
    };
    applyNonReasoningGenerationParams(opts, "dashscope");
    expect(opts.extra_body).toEqual({
      incremental_output: true,
      enable_thinking: false,
    });
  });

  it("removes OpenAI reasoning effort while preserving its token parameter", () => {
    const opts: Record<string, unknown> = {
      reasoning_effort: "high",
      max_tokens: 8192,
    };
    applyNonReasoningGenerationParams(opts, "openai");
    expect(opts.reasoning_effort).toBeUndefined();
    expect(opts.max_tokens).toBeUndefined();
    expect(opts.max_completion_tokens).toBe(8192);
  });
});
