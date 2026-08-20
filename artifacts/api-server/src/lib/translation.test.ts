import { describe, expect, it } from "vitest";
import { buildTranslationSystemPrompt, parseTranslationMode } from "./translation";

describe("parseTranslationMode", () => {
  it("accepts known modes", () => {
    expect(parseTranslationMode("auto")).toBe("auto");
    expect(parseTranslationMode("ja-en")).toBe("ja-en");
    expect(parseTranslationMode("en-ja")).toBe("en-ja");
  });

  it("rejects unknown or missing values", () => {
    expect(parseTranslationMode("english")).toBeUndefined();
    expect(parseTranslationMode("")).toBeUndefined();
    expect(parseTranslationMode(undefined)).toBeUndefined();
    expect(parseTranslationMode(42)).toBeUndefined();
  });
});

describe("buildTranslationSystemPrompt", () => {
  it("covers both directions in auto mode", () => {
    const prompt = buildTranslationSystemPrompt("auto");
    expect(prompt).toContain("日本語なら英語へ");
    expect(prompt).toContain("日本語以外なら日本語へ");
  });

  it("pins the direction for explicit modes", () => {
    expect(buildTranslationSystemPrompt("ja-en")).toContain("日本語から英語");
    expect(buildTranslationSystemPrompt("en-ja")).toContain("英語から日本語");
  });

  it("demands translation-only output and nuance preservation", () => {
    const prompt = buildTranslationSystemPrompt("auto");
    expect(prompt).toContain("出力は訳文のみ");
    expect(prompt).toContain("ニュアンス");
    expect(prompt).toContain("調整指示");
  });
});
