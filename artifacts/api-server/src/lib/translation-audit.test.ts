import { describe, expect, it } from "vitest";
import {
  TRANSLATION_AUDIT_SYSTEM_PROMPT,
  buildRecentTranslationContext,
  buildTranslationAuditUserMessage,
  classifyTranslationAuditProfile,
  inspectTranslationInvariants,
} from "./translation-audit";

describe("translation audit", () => {
  it("treats a Japanese to Korean term translation as translation QA, not answer-language mismatch", () => {
    const message = buildTranslationAuditUserMessage({
      mode: "ja-ko",
      source: "ローカル鉄道",
      translation: "지방 철도",
    });

    expect(message).toContain("ja-ko: 日本語→韓国語");
    expect(message).toContain("<source_text>\nローカル鉄道\n</source_text>");
    expect(message).toContain(
      "<translated_text>\n지방 철도\n</translated_text>",
    );
    expect(TRANSLATION_AUDIT_SYSTEM_PROMPT).toContain(
      "原文と訳文の言語が違うこと自体",
    );
    expect(TRANSLATION_AUDIT_SYSTEM_PROMPT).toContain(
      "ja-ko では、日本語入力に韓国語訳が返るのが正しい動作",
    );
  });

  it("uses a lighter profile for short phrases and a detailed profile for long text", () => {
    expect(classifyTranslationAuditProfile("ローカル鉄道")).toBe("short");
    expect(classifyTranslationAuditProfile("a".repeat(1_300))).toBe("detailed");
    expect(
      classifyTranslationAuditProfile(
        "This is an ordinary sentence that is clearly long enough to require the standard translation audit profile.",
      ),
    ).toBe("standard");
  });

  it("flags missing URLs and numeric tokens without treating them as automatic verdicts", () => {
    const issues = inspectTranslationInvariants({
      source: "価格は12,500円です。https://example.com/a を参照。",
      translation: "The price is shown on the linked page.",
    });
    expect(issues.some((item) => item.includes("12,500"))).toBe(true);
    expect(issues.some((item) => item.includes("https://example.com/a"))).toBe(
      true,
    );

    expect(
      inspectTranslationInvariants({
        source: "価格は12,500円です。https://example.com/a",
        translation: "The price is 12,500 yen. https://example.com/a",
      }),
    ).toEqual([]);
  });

  it("preserves recent user and assistant translation context for adjustment requests", () => {
    const context = buildRecentTranslationContext([
      { role: "user", content: "この文章を英訳して" },
      { role: "assistant", content: "Please translate this sentence." },
      { role: "user", content: "もっとカジュアルに" },
    ]);
    expect(context).toContain("ASSISTANT: Please translate this sentence.");
    expect(context).toContain("USER: もっとカジュアルに");
  });

  it.each([
    ["ja-en", "日本語→英語"],
    ["en-ja", "英語→日本語"],
    ["ja-ko", "日本語→韓国語"],
    ["ko-ja", "韓国語→日本語"],
    ["ja-zh", "日本語→中国語"],
    ["zh-ja", "中国語→日本語"],
  ] as const)(
    "includes the configured %s translation direction",
    (mode, label) => {
      const message = buildTranslationAuditUserMessage({
        mode,
        source: "source",
        translation: "target",
      });
      expect(message).toContain(label);
    },
  );
});
