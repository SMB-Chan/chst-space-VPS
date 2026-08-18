import { beforeEach, describe, expect, it } from "vitest";
import { loadSettings, saveSettings } from "./settings";

describe("settings store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadSettings()).toEqual({
      defaultModel: "gpt-5.6-terra",
      defaultReasoning: "medium",
    });
  });

  it("persists a default model and reasoning level", () => {
    saveSettings({ defaultModel: "qwen3.8-max", defaultReasoning: "high" });
    expect(loadSettings()).toEqual({
      defaultModel: "qwen3.8-max",
      defaultReasoning: "high",
    });
  });
});
