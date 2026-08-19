import { describe, expect, it } from "vitest";
import {
  expandSearchQueries,
  normalizeQuery,
  scoreSearchResult,
  mergeSearchResults,
  extractMainContent,
} from "./search-enhance";

describe("normalizeQuery", () => {
  it("lowercases, strips spaces and punctuation", () => {
    expect(normalizeQuery("  今日の天気  ")).toBe("今日の天気");
    expect(normalizeQuery("GPT-5, release date!")).toBe("gpt5 release date");
    expect(normalizeQuery("　最新　ニュース　")).toBe("最新 ニュース");
  });
});

describe("expandSearchQueries", () => {
  it("adds latest variant for plain queries", () => {
    expect(expandSearchQueries("東京 天気")).toContain("東京 天気 最新");
    expect(expandSearchQueries("東京 天気")).toContain("東京 天気");
  });

  it("does not duplicate latest when already present", () => {
    const variants = expandSearchQueries("東京 天気 最新");
    expect(variants).toHaveLength(1);
    expect(variants[0]).toBe("東京 天気 最新");
  });

  it("adds news variant for Japanese queries", () => {
    const variants = expandSearchQueries("円安");
    expect(variants).toContain("円安 最新");
    expect(variants).toContain("円安 ニュース");
  });

  it("caps variants at 3", () => {
    expect(expandSearchQueries("テストクエリ").length).toBeLessThanOrEqual(3);
  });
});

describe("scoreSearchResult", () => {
  it("ranks exact title matches highest", () => {
    const exact = { title: "東京の天気", url: "https://example.com", snippet: "概要" };
    const partial = { title: "大阪の天気", url: "https://example.com", snippet: "概要" };
    const exactScore = scoreSearchResult(exact, "東京の天気");
    const partialScore = scoreSearchResult(partial, "東京の天気");
    expect(exactScore).toBeGreaterThan(partialScore);
  });

  it("boosts authority domains", () => {
    const auth = { title: "Title", url: "https://www.nhk.or.jp/news/", snippet: "" };
    const plain = { title: "Title", url: "https://example.com", snippet: "" };
    expect(scoreSearchResult(auth, "ニュース")).toBeGreaterThan(scoreSearchResult(plain, "ニュース"));
  });

  it("penalizes low-quality domains", () => {
    const low = { title: "Title", url: "https://matome.example.com", snippet: "" };
    const plain = { title: "Title", url: "https://example.com", snippet: "" };
    expect(scoreSearchResult(low, "ニュース")).toBeLessThan(scoreSearchResult(plain, "ニュース"));
  });

  it("boosts current-year recency signals", () => {
    const currentYear = new Date().getUTCFullYear();
    const recent = { title: `${currentYear}年の予測`, url: "https://example.com", snippet: "" };
    const old = { title: "2018年の予測", url: "https://example.com", snippet: "" };
    expect(scoreSearchResult(recent, "予測")).toBeGreaterThan(scoreSearchResult(old, "予測"));
  });

  it("does not grant authority points for trusted text in a path or query", () => {
    const spoofed = {
      title: "Title",
      url: "https://example.com/reuters.com/story?source=nhk.or.jp",
      snippet: "",
    };
    const plain = { title: "Title", url: "https://example.com/story", snippet: "" };
    expect(scoreSearchResult(spoofed, "ニュース")).toBe(scoreSearchResult(plain, "ニュース"));
  });

  it("recognizes trusted subdomains by hostname suffix", () => {
    const auth = { title: "Title", url: "https://news.example.nhk.or.jp/story", snippet: "" };
    const plain = { title: "Title", url: "https://example.com/story", snippet: "" };
    expect(scoreSearchResult(auth, "ニュース")).toBeGreaterThan(scoreSearchResult(plain, "ニュース"));
  });
});

describe("mergeSearchResults", () => {
  it("deduplicates by URL and sorts by score", () => {
    const results = [
      { title: "A", url: "https://example.com/a", snippet: "first" },
      { title: "A2", url: "https://example.com/a#section", snippet: "duplicate" },
      { title: "B", url: "https://example.com/b", snippet: "exact match 東京の天気" },
    ];
    const merged = mergeSearchResults(results, "東京の天気");
    expect(merged).toHaveLength(2);
    expect(merged[0].url).toBe("https://example.com/b");
  });
});

describe("extractMainContent", () => {
  it("prefers article content", () => {
    const html = `
      <html>
        <head><title>Page</title></head>
        <body>
          <nav>Navigation</nav>
          <article>
            <p>This is the main article content that should be extracted.</p>
            <p>Second paragraph with enough length to be meaningful.</p>
          </article>
          <footer>Footer</footer>
        </body>
      </html>
    `;
    const text = extractMainContent(html);
    expect(text).toContain("main article content");
    expect(text).not.toContain("Navigation");
    expect(text).not.toContain("Footer");
  });

  it("falls back to paragraphs when no article/main", () => {
    const html = `
      <div>
        <p>First meaningful paragraph with enough text to be kept.</p>
        <p>Second meaningful paragraph with enough text to be kept.</p>
      </div>
    `;
    const text = extractMainContent(html);
    expect(text).toContain("First meaningful paragraph");
    expect(text).toContain("Second meaningful paragraph");
  });

  it("strips scripts and styles", () => {
    const html = `
      <script>alert('x')</script>
      <style>.x { color: red; }</style>
      <p>Visible content.</p>
    `;
    const text = extractMainContent(html);
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color: red");
    expect(text).toContain("Visible content");
  });
});
