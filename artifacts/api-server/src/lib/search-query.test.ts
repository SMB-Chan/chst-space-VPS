import { describe, expect, it } from "vitest";
import { inferSearchQuery, parseSearchHtml } from "./search-parse";

describe("inferSearchQuery", () => {
  it("searches freshness-sensitive Japanese questions", () => {
    expect(inferSearchQuery("今日の東京の天気は？")).toMatchObject({ needed: true });
    expect(inferSearchQuery("最新の円安ニュース")).toMatchObject({ needed: true });
  });

  it("skips greetings and bare URLs", () => {
    expect(inferSearchQuery("こんにちは")).toEqual({ needed: false, query: "" });
    expect(inferSearchQuery("https://example.com/page")).toEqual({ needed: false, query: "" });
  });
});

describe("parseSearchHtml", () => {
  it("reads classic DuckDuckGo result cards", () => {
    const html =
      `<a class="result__a" href="https://example.com/a">Alpha</a>` +
      `<a class="result__snippet">Snippet A</a>`;
    expect(parseSearchHtml(html)).toEqual([
      { title: "Alpha", url: "https://example.com/a", snippet: "Snippet A" },
    ]);
  });

  it("unwraps uddg redirect links", () => {
    const html = `<a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fnews.example%2Fstory">News</a>`;
    expect(parseSearchHtml(html)[0]?.url).toBe("https://news.example/story");
  });
});
