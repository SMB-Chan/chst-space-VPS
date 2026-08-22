import { describe, expect, it } from "vitest";
import {
  expandSearchQueries,
  normalizeQuery,
  sanitizeSearchQuery,
  scoreSearchResult,
  mergeSearchResults,
  extractArticleContent,
  extractMainContent,
  extractEmbeddedContent,
  isBotChallengePage,
  MIN_CONTENT_CHARS,
} from "./search-enhance";

describe("normalizeQuery", () => {
  it("lowercases, strips spaces and punctuation", () => {
    expect(normalizeQuery("  今日の天気  ")).toBe("今日の天気");
    expect(normalizeQuery("GPT-5, release date!")).toBe("gpt5 release date");
    expect(normalizeQuery("　最新　ニュース　")).toBe("最新 ニュース");
  });
});

describe("sanitizeSearchQuery", () => {
  it("passes ordinary queries through", () => {
    expect(sanitizeSearchQuery("東京 天気 最新")).toBe("東京 天気 最新");
  });

  it("collapses newlines and extra whitespace into one line", () => {
    expect(sanitizeSearchQuery("Node.js\n最新版\r\n リリース")).toBe("Node.js 最新版 リリース");
  });

  it("rejects empty and overlong queries", () => {
    expect(sanitizeSearchQuery("   ")).toBe("");
    expect(sanitizeSearchQuery("あ".repeat(201))).toBe("");
  });

  it("rejects secret-like content that must not leak to search APIs", () => {
    expect(sanitizeSearchQuery("login with sk-abcdefghijklmnop1234567890")).toBe("");
    expect(sanitizeSearchQuery("-----BEGIN PRIVATE KEY----- abc")).toBe("");
    expect(sanitizeSearchQuery("token: Bearer abcdef0123456789abcd")).toBe("");
    expect(sanitizeSearchQuery("api_key=abcdef12345")).toBe("");
    expect(sanitizeSearchQuery("password: hunter2")).toBe("");
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

  it("yields too little text for a JS-rendered SPA shell", () => {
    const html = `
      <html>
        <head><title>SPA</title></head>
        <body>
          <div id="root"></div>
          <script src="/assets/index.js"></script>
        </body>
      </html>
    `;
    expect(extractMainContent(html).length).toBeLessThan(MIN_CONTENT_CHARS);
  });
});

describe("extractArticleContent", () => {
  it("extracts article text and title via Readability", () => {
    const body = "これは記事の本文です。Readability が抽出すべき内容。".repeat(10);
    const html = `
      <html>
        <head><title>記事タイトル | サイト名</title></head>
        <body>
          <nav>ナビゲーション リンク リンク リンク</nav>
          <article><h1>記事タイトル</h1><p>${body}</p></article>
          <footer>フッターのコピーライト</footer>
        </body>
      </html>
    `;
    const article = extractArticleContent(html, "https://example.com/post/1");
    expect(article).not.toBeNull();
    expect(article!.text).toContain("Readability が抽出すべき内容");
    expect(article!.title).toContain("記事タイトル");
  });

  it("returns null for pages with no identifiable article", () => {
    expect(
      extractArticleContent(
        "<html><body><div id=\"root\"></div></body></html>",
        "https://example.com/",
      ),
    ).toBeNull();
  });

  it("returns null for malformed input without throwing", () => {
    expect(extractArticleContent("", "https://example.com/")).toBeNull();
  });
});

describe("isBotChallengePage", () => {
  it("detects a Cloudflare challenge page", () => {
    const html = `
      <html>
        <head><title>Just a moment...</title></head>
        <body><div id="challenge-platform"></div></body>
      </html>
    `;
    expect(isBotChallengePage(html)).toBe(true);
  });

  it("does not flag ordinary article pages", () => {
    const html = `
      <html>
        <body><article><p>普通の記事本文です。ボット対策とは無関係の内容。</p></article></body>
      </html>
    `;
    expect(isBotChallengePage(html)).toBe(false);
  });
});

describe("extractEmbeddedContent", () => {
  it("extracts articleBody from JSON-LD", () => {
    const body = "これはJSON-LDに埋め込まれた記事本文です。".repeat(10);
    const html = `
      <html>
        <head>
          <script type="application/ld+json">
            {"@context":"https://schema.org","@type":"NewsArticle","headline":"タイトル","articleBody":"${body}"}
          </script>
        </head>
        <body><div id="root"></div></body>
      </html>
    `;
    const text = extractEmbeddedContent(html);
    expect(text).toContain("JSON-LDに埋め込まれた記事本文");
  });

  it("extracts long strings from Next.js __NEXT_DATA__ and strips HTML", () => {
    const article = "<p>Next.jsのpropsに入っている本文です。</p>".repeat(8);
    const html = `
      <html>
        <body>
          <div id="__next"></div>
          <script id="__NEXT_DATA__" type="application/json">
            {"props":{"pageProps":{"article":{"title":"題","body":${JSON.stringify(article)}}}}}
          </script>
        </body>
      </html>
    `;
    const text = extractEmbeddedContent(html);
    expect(text).toContain("Next.jsのpropsに入っている本文です");
    expect(text).not.toContain("<p>");
  });

  it("returns empty string when no structured data is present", () => {
    expect(extractEmbeddedContent("<html><body><p>short</p></body></html>")).toBe("");
  });

  it("ignores malformed JSON blocks without throwing", () => {
    const html = `
      <script type="application/ld+json">{broken json</script>
      <script id="__NEXT_DATA__" type="application/json">not json at all</script>
    `;
    expect(extractEmbeddedContent(html)).toBe("");
  });
});
