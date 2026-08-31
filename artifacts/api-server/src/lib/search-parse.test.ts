import { describe, expect, it } from "vitest";
import {
  extractUrls,
  inferSearchQuery,
  normalizeExternalHttpUrl,
  parseSearchHtml,
} from "./search-parse";

describe("normalizeExternalHttpUrl", () => {
  it("removes fragments and well-known tracking parameters", () => {
    expect(
      normalizeExternalHttpUrl(
        "https://Example.com/article?utm_source=newsletter&utm_medium=email&page=2&fbclid=abc#section",
      ),
    ).toBe("https://example.com/article?page=2");
  });

  it("removes case-insensitive UTM keys and click identifiers", () => {
    expect(
      normalizeExternalHttpUrl(
        "https://example.com/a?UTM_Campaign=spring&gclid=123&msclkid=456&q=keep",
      ),
    ).toBe("https://example.com/a?q=keep");
  });

  it("preserves query parameters that may affect resource identity", () => {
    expect(
      normalizeExternalHttpUrl(
        "https://example.com/search?q=chat+space&page=3&ref=docs",
      ),
    ).toBe("https://example.com/search?q=chat+space&page=3&ref=docs");
  });

  it("rejects credential-bearing and non-http URLs", () => {
    expect(
      normalizeExternalHttpUrl("https://user:pass@example.com/private"),
    ).toBeNull();
    expect(normalizeExternalHttpUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeExternalHttpUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("extractUrls", () => {
  it("deduplicates URL variants that differ only by tracking parameters", () => {
    const urls = extractUrls(
      "See https://example.com/a?utm_source=x and https://example.com/a?fbclid=y#section then https://example.com/b?page=2",
    );
    expect(urls).toEqual([
      "https://example.com/a",
      "https://example.com/b?page=2",
    ]);
  });
});

describe("parseSearchHtml", () => {
  it("deduplicates DuckDuckGo results after URL canonicalization", () => {
    const first = encodeURIComponent(
      "https://example.com/story?utm_source=ddg",
    );
    const second = encodeURIComponent(
      "https://example.com/story?fbclid=abc#comments",
    );
    const html = `
      <a class="result__a" href="/?uddg=${first}">Story one</a>
      <a class="result__snippet">First snippet</a>
      <a class="result__a" href="/?uddg=${second}">Story duplicate</a>
      <a class="result__snippet">Second snippet</a>
    `;
    const results = parseSearchHtml(html);
    expect(results).toHaveLength(1);
    expect(results[0]?.url).toBe("https://example.com/story");
  });
});

describe("inferSearchQuery temporal expressions", () => {
  it("detects past temporal expressions", () => {
    expect(inferSearchQuery("去年の流行は何だった？").needed).toBe(true);
    expect(inferSearchQuery("3年前のデータを見せて").needed).toBe(true);
    expect(inferSearchQuery("昨年の売上は？").needed).toBe(true);
    expect(inferSearchQuery("先月のイベント結果").needed).toBe(true);
    expect(inferSearchQuery("前回の変更以来どうなった？").needed).toBe(true);
  });

  it("detects future temporal expressions", () => {
    expect(inferSearchQuery("来年の予定は？").needed).toBe(true);
    expect(inferSearchQuery("今後の見通しを教えてください").needed).toBe(true);
    expect(inferSearchQuery("来月のイベント").needed).toBe(true);
    expect(inferSearchQuery("3年後の予測").needed).toBe(true);
    expect(inferSearchQuery("次のリリースはいつ？").needed).toBe(true);
  });

  it("detects temporal span expressions", () => {
    expect(inferSearchQuery("AI技術の変化について").needed).toBe(true);
    expect(inferSearchQuery("株価の推移を教えて").needed).toBe(true);
    expect(inferSearchQuery("去年と今年を比較して").needed).toBe(true);
  });

  it("does not trigger on non-temporal queries", () => {
    expect(inferSearchQuery("こんにちは").needed).toBe(false);
    expect(inferSearchQuery("Pythonでソート怎么写く？").needed).toBe(false);
  });
});
