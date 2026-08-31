import { describe, expect, it } from "vitest";
import {
  ALIBABA_CAPABILITY_DEFAULTS,
  ALIBABA_CHAT_MODELS,
  ALIBABA_MODEL_CATALOG,
  getAlibabaModel,
  modelHasAlibabaCapability,
  modelsForAlibabaCapability,
} from "./alibaba-capabilities";

describe("Alibaba capability registry", () => {
  it("keeps model ids unique", () => {
    const ids = ALIBABA_MODEL_CATALOG.map((model) => model.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("separates specialist media models from selectable chat models", () => {
    expect(ALIBABA_CHAT_MODELS.length).toBeGreaterThan(0);
    expect(ALIBABA_CHAT_MODELS.every((model) => model.kind === "chat")).toBe(
      true,
    );
    expect(
      ALIBABA_CHAT_MODELS.some((model) => model.id === "qwen-image-3.0-pro"),
    ).toBe(false);
    expect(
      ALIBABA_CHAT_MODELS.some(
        (model) => model.id === "qwen-audio-3.0-tts-plus",
      ),
    ).toBe(false);
    expect(
      ALIBABA_CHAT_MODELS.some((model) => model.id === "happyhorse-1.1-t2v"),
    ).toBe(false);
  });

  it("registers the Token Plan models used by the application", () => {
    const expected = [
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.7-plus",
      "qwen3.7-max",
      "qwen3.6-flash",
      "qwen-image-3.0-pro",
      "qwen-audio-3.0-asr-flash",
      "qwen-audio-3.0-tts-plus",
      "qwen-audio-3.0-realtime-plus",
      "wan2.7-image",
      "wan2.7-image-pro",
      "happyhorse-1.1-i2v",
      "happyhorse-1.1-t2v",
      "happyhorse-1.1-r2v",
      "deepseek-v4-pro-0813",
      "deepseek-v4-pro",
      "deepseek-v4-flash-0731",
      "glm-5.2",
    ];
    expect(ALIBABA_MODEL_CATALOG.map((model) => model.id).sort()).toEqual(
      expected.sort(),
    );
  });

  it("maps defaults only to models that implement their capability", () => {
    for (const [capability, modelId] of Object.entries(
      ALIBABA_CAPABILITY_DEFAULTS,
    )) {
      expect(modelHasAlibabaCapability(modelId, capability as never)).toBe(
        true,
      );
    }
  });

  it("models the important vision boundary for bridge routing", () => {
    expect(modelHasAlibabaCapability("qwen3.8-flash", "vision")).toBe(true);
    expect(modelHasAlibabaCapability("qwen3.7-max", "vision")).toBe(false);
    expect(modelHasAlibabaCapability("deepseek-v4-pro", "vision")).toBe(false);
  });

  it("discovers specialist models by capability", () => {
    expect(
      modelsForAlibabaCapability("image.generate").map((model) => model.id),
    ).toEqual(["qwen-image-3.0-pro", "wan2.7-image", "wan2.7-image-pro"]);
    expect(getAlibabaModel("happyhorse-1.1-r2v")?.transport).toBe(
      "dashscope-async-video",
    );
  });
});
