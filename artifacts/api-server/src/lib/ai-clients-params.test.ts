import { describe, expect, it } from "vitest";
import { resolveOpenRouterApiKey } from "./openrouter-config";
import {
  applyGenerationParams,
  applySafeGenerationParams,
  getClientForModel,
  isUnsupportedGenerationParam,
  VISION_MODEL_IDS,
} from "./ai-clients";

describe("openrouter generation params", () => {
  it("uses max_tokens and the unified reasoning param", () => {
    const opts: Record<string, unknown> = {};
    applyGenerationParams(
      opts,
      "google/gemini-2.5-flash-lite",
      "openrouter",
      "high",
    );
    expect(opts.max_tokens).toBe(8192);
    expect(opts.reasoning).toEqual({ effort: "high" });
    expect(opts).not.toHaveProperty("incremental_output");
    expect(opts).not.toHaveProperty("enable_thinking");
    expect(opts).not.toHaveProperty("max_completion_tokens");
  });

  it("actively disables thinking when the level is off", () => {
    // GLM/Qwen think by default; background stages run with reasoningLevel
    // "off" and would otherwise burn their token cap on hidden reasoning.
    const off: Record<string, unknown> = {};
    applyGenerationParams(
      off,
      "google/gemini-2.5-flash-lite",
      "openrouter",
      "off",
    );
    expect(off.reasoning).toEqual({ enabled: false });

    const plain: Record<string, unknown> = {};
    applyGenerationParams(
      plain,
      "deepseek/deepseek-chat",
      "openrouter",
      "high",
    );
    expect(plain.max_tokens).toBe(8192);
    expect(plain).not.toHaveProperty("reasoning");
  });

  it("strips vendor params on the safe retry and keeps max_tokens", () => {
    const opts: Record<string, unknown> = {
      reasoning: { effort: "low" },
      enable_thinking: false,
      incremental_output: true,
      max_completion_tokens: 8192,
    };
    applySafeGenerationParams(opts, "openrouter");
    expect(opts.max_tokens).toBe(8192);
    expect(opts).not.toHaveProperty("reasoning");
    expect(opts).not.toHaveProperty("enable_thinking");
    expect(opts).not.toHaveProperty("incremental_output");
    expect(opts).not.toHaveProperty("max_completion_tokens");
  });

  it("treats reasoning rejections as unsupported-param errors", () => {
    expect(
      isUnsupportedGenerationParam(
        new Error("400 Reasoning is not supported by this model"),
      ),
    ).toBe(true);
  });

  it("keeps OpenRouter vision models in the vision set", () => {
    expect(VISION_MODEL_IDS.has("z-ai/glm-5.3-flash")).toBe(true);
    expect(VISION_MODEL_IDS.has("google/gemini-2.5-flash-lite")).toBe(true);
    expect(VISION_MODEL_IDS.has("qwen/qwen3.8-flash")).toBe(true);
    expect(VISION_MODEL_IDS.has("qwen/qwen3.7-flash")).toBe(true);
    expect(VISION_MODEL_IDS.has("openai/gpt-4o-mini")).toBe(true);
    expect(VISION_MODEL_IDS.has("deepseek/deepseek-chat")).toBe(false);
  });

  it("sends the reasoning effort to Qwen3.7 Flash", () => {
    const opts: Record<string, unknown> = {};
    applyGenerationParams(opts, "qwen/qwen3.7-flash", "openrouter", "high");
    expect(opts.max_tokens).toBe(8192);
    expect(opts.reasoning).toEqual({ effort: "high" });
    expect(opts).not.toHaveProperty("enable_thinking");
  });

  it("sends the reasoning effort to Qwen3.8 Flash", () => {
    const opts: Record<string, unknown> = {};
    applyGenerationParams(opts, "qwen/qwen3.8-flash", "openrouter", "medium");
    expect(opts.max_tokens).toBe(8192);
    expect(opts.reasoning).toEqual({ effort: "medium" });
    expect(opts).not.toHaveProperty("enable_thinking");
    expect(opts).not.toHaveProperty("incremental_output");
  });

  it("sends the reasoning effort to GLM-5.3 Flash", () => {
    const opts: Record<string, unknown> = {};
    applyGenerationParams(opts, "z-ai/glm-5.3-flash", "openrouter", "medium");
    expect(opts.max_tokens).toBe(8192);
    expect(opts.reasoning).toEqual({ effort: "medium" });
    expect(opts).not.toHaveProperty("enable_thinking");
    expect(opts).not.toHaveProperty("incremental_output");
  });

  it("resolves when configured and fails with a clear message otherwise", () => {
    if (resolveOpenRouterApiKey()) {
      const resolved = getClientForModel("deepseek/deepseek-chat");
      expect(resolved.provider).toBe("openrouter");
      return;
    }
    expect(() => getClientForModel("deepseek/deepseek-chat")).toThrow(
      /OPEN_ROUTER|OPENROUTER_API_KEY/,
    );
  });
});
