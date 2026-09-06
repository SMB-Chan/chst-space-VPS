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
      auditReasoning: "off",
      translationMode: "off",
    });
  });

  it("persists the translation mode", () => {
    saveSettings({ translationMode: "auto" });
    expect(loadSettings().translationMode).toBe("auto");
  });

  it("rejects an invalid translation mode", () => {
    saveSettings({ translationMode: "auto" });
    const raw = JSON.parse(
      localStorage.getItem("chat-space.settings.v1") ?? "{}",
    );
    raw.translationMode = "klingon";
    localStorage.setItem("chat-space.settings.v1", JSON.stringify(raw));
    expect(loadSettings().translationMode).toBe("off");
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

  it("honors a saved auditor even when it equals the primary", () => {
    // Swapping used to make the selector show (and the turn use) a model the
    // user never selected whenever the saved auditor matched the chat model.
    const models = [
      { id: "z-ai/glm-5.3-flash", provider: "openrouter" as const },
      { id: "qwen/qwen3.7-flash", provider: "openrouter" as const },
    ];
    expect(
      pickAuditModel("z-ai/glm-5.3-flash", models, "z-ai/glm-5.3-flash"),
    ).toBe("z-ai/glm-5.3-flash");
    expect(
      pickAuditModel("z-ai/glm-5.3-flash", models, "qwen/qwen3.7-flash"),
    ).toBe("qwen/qwen3.7-flash");
  });

  it("falls back only when the saved auditor is missing from the catalog", () => {
    const models = [
      { id: "z-ai/glm-5.3-flash", provider: "openrouter" as const },
      { id: "qwen/qwen3.7-flash", provider: "openrouter" as const },
    ];
    expect(pickAuditModel("z-ai/glm-5.3-flash", models, "qwen3.8-max")).toBe(
      "qwen/qwen3.7-flash",
    );
  });
});
