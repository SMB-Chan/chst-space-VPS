import { describe, expect, it } from "vitest";
import { packWebContextParts } from "./web-search";

describe("packWebContextParts", () => {
  it("passes small evidence through untouched", () => {
    const parts = ["【Web検索結果】\n[1] one", "【ページ内容 [1]】\nbody"];
    const packed = packWebContextParts(parts, 10_000);
    expect(packed.contextText).toBe(parts.join("\n\n"));
    expect(packed.omittedSections).toBe(0);
  });

  it("caps long evidence and marks the omission explicitly", () => {
    const parts = [
      "【Web検索結果】\n[1] one",
      `【ページ内容 [1]】\n${"a".repeat(5_000)}`,
      `【ページ内容 [2]】\n${"b".repeat(5_000)}`,
    ];
    const packed = packWebContextParts(parts, 6_000);
    expect(packed.contextText.length).toBeLessThanOrEqual(6_000);
    expect(packed.omittedSections).toBeGreaterThan(0);
    expect(packed.contextText).toContain("省略");
    expect(packed.contextText).toContain("推測で補わない");
    expect(packed.contextText).toContain("【Web検索結果】");
  });

  it("never emits mojibake when packing multibyte text", () => {
    const parts = [`【ページ内容 [1]】\n${"🌸".repeat(5_000)}`];
    const packed = packWebContextParts(parts, 2_000);
    expect(packed.contextText).not.toContain("�");
    expect(packed.omittedSections).toBe(0);
  });
});
