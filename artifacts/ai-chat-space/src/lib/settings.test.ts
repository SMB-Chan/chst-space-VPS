import { beforeEach, describe, expect, it } from "vitest";
import { loadSettings, pickAuditModel, saveSettings } from "./settings";

describe("settings store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual({
      defaultModel: "gpt-5.6-terra",
      defaultReasoning: "medium",
      auditEnabled: false,
      auditModelId: "qwen3.8-max",
    });
  });

  it("persists a default model and reasoning level", () => {
    saveSettings({ defaultModel: "qwen3.8-max", defaultReasoning: "high" });
    expect(loadSettings().defaultModel).toBe("qwen3.8-max");
    expect(loadSettings().defaultReasoning).toBe("high");
  });

  it("picks an auditor from the other provider when possible", () => {
    expect(
      pickAuditModel("gpt-5.6-terra", [
        { id: "gpt-5.6-terra", provider: "openai" },
        { id: "qwen3.8-max", provider: "dashscope" },
      ]),
    ).toBe("qwen3.8-max");
  });
});
