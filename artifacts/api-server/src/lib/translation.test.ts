import { describe, expect, it } from "vitest";
import {
  buildTranslationSystemPrompt,
  parseTranslationMode,
} from "./translation";

describe("parseTranslationMode", () => {
  it("accepts known modes", () => {
    expect(parseTranslationMode("auto")).toBe("auto");
    expect(parseTranslationMode("ja-en")).toBe("ja-en");
    expect(parseTranslationMode("en-ja")).toBe("en-ja");
    expect(parseTranslationMode("auto-ko")).toBe("auto-ko");
    expect(parseTranslationMode("ja-ko")).toBe("ja-ko");
    expect(parseTranslationMode("ko-ja")).toBe("ko-ja");
    expect(parseTranslationMode("auto-zh")).toBe("auto-zh");
    expect(parseTranslationMode("ja-zh")).toBe("ja-zh");
    expect(parseTranslationMode("zh-ja")).toBe("zh-ja");
  });

  it("rejects unknown or missing values", () => {
    expect(parseTranslationMode("english")).toBeUndefined();
    expect(parseTranslationMode("")).toBeUndefined();
    expect(parseTranslationMode(undefined)).toBeUndefined();
    expect(parseTranslationMode(42)).toBeUndefined();
  });
});

describe("buildTranslationSystemPrompt", () => {
  it("covers both directions in auto modes", () => {
    const en = buildTranslationSystemPrompt("auto");
    expect(en).toContain("日本語なら英語へ");
    expect(en).toContain("日本語以外なら日本語へ");
    const ko = buildTranslationSystemPrompt("auto-ko");
    expect(ko).toContain("日本語なら韓国語へ");
    expect(ko).toContain("韓国語なら日本語へ");
    const zh = buildTranslationSystemPrompt("auto-zh");
    expect(zh).toContain("日本語なら中国語へ");
    expect(zh).toContain("中国語なら日本語へ");
    expect(zh).toContain("簡体字");
  });

  it("pins the direction for explicit modes", () => {
    expect(buildTranslationSystemPrompt("ja-en")).toContain("日本語から英語");
    expect(buildTranslationSystemPrompt("en-ja")).toContain("英語から日本語");
    expect(buildTranslationSystemPrompt("ja-ko")).toContain("日本語から韓国語");
    expect(buildTranslationSystemPrompt("ko-ja")).toContain("韓国語から日本語");
    expect(buildTranslationSystemPrompt("ja-zh")).toContain("日本語から中国語");
    expect(buildTranslationSystemPrompt("ja-zh")).toContain("簡体字");
    expect(buildTranslationSystemPrompt("zh-ja")).toContain("中国語から日本語");
  });

  it("demands translation-only output and nuance preservation", () => {
    const prompt = buildTranslationSystemPrompt("auto");
    expect(prompt).toContain("出力は訳文のみ");
    expect(prompt).toContain("ニュアンス");
    expect(prompt).toContain("調整指示");
  });
});
