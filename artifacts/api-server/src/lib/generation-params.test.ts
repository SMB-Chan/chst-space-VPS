import { describe, expect, it } from "vitest";
import {
  applyGenerationParams,
  applyNonReasoningGenerationParams,
  applySafeGenerationParams,
  applyStreamingToolParams,
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

  it("sends GLM vendor parameters at the Node SDK top level", () => {
    const opts: Record<string, unknown> = {};
    applyGenerationParams(opts, "glm-5.2", "dashscope", "medium");
    expect(opts).toMatchObject({
      max_tokens: 8192,
      incremental_output: true,
      enable_thinking: true,
      reasoning_effort: "medium",
    });
    expect(opts.extra_body).toBeUndefined();
  });

  it("uses a supported DeepSeek snapshot reasoning level", () => {
    const opts: Record<string, unknown> = {};
    applyGenerationParams(
      opts,
      "deepseek-v4-flash-0731",
      "dashscope",
      "medium",
    );
    expect(opts).toMatchObject({
      incremental_output: true,
      enable_thinking: true,
      reasoning_effort: "high",
    });
    expect(opts.thinking_budget).toBeUndefined();
    expect(opts.extra_body).toBeUndefined();
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
  it("strips optional vendor parameters and keeps incremental streaming", () => {
    const opts: Record<string, unknown> = {
      extra_body: { enable_thinking: true },
      enable_thinking: true,
      thinking_budget: 8192,
      tool_stream: true,
      reasoning_effort: "medium",
    };
    applySafeGenerationParams(opts, "dashscope");
    expect(opts.reasoning_effort).toBeUndefined();
    expect(opts.enable_thinking).toBeUndefined();
    expect(opts.thinking_budget).toBeUndefined();
    expect(opts.tool_stream).toBeUndefined();
    expect(opts.extra_body).toBeUndefined();
    expect(opts.incremental_output).toBe(true);
  });
});

describe("applyNonReasoningGenerationParams", () => {
  it("explicitly disables DashScope thinking for an empty-response retry", () => {
    const opts: Record<string, unknown> = {
      enable_thinking: true,
      thinking_budget: 8192,
    };
    applyNonReasoningGenerationParams(opts, "dashscope");
    expect(opts.incremental_output).toBe(true);
    expect(opts.enable_thinking).toBe(false);
    expect(opts.thinking_budget).toBeUndefined();
    expect(opts.extra_body).toBeUndefined();
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

describe("applyStreamingToolParams", () => {
  it("enables streamed function calls for GLM without dropping thinking params", () => {
    const opts: Record<string, unknown> = {
      enable_thinking: true,
      thinking_budget: 4096,
    };
    applyStreamingToolParams(opts, "glm-5.2", "dashscope", true);
    expect(opts.enable_thinking).toBe(true);
    expect(opts.thinking_budget).toBe(4096);
    expect(opts.tool_stream).toBe(true);
    expect(opts.extra_body).toBeUndefined();
  });

  it("does not add tool_stream when no tools are attached", () => {
    const opts: Record<string, unknown> = {
      enable_thinking: true,
      tool_stream: true,
    };
    applyStreamingToolParams(opts, "glm-5.2", "dashscope", false);
    expect(opts.enable_thinking).toBe(true);
    expect(opts.tool_stream).toBeUndefined();
  });
});
