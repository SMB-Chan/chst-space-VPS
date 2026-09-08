import { fetchSearchJson, fetchSearchText } from "./search-http";
import { normalizeExternalHttpUrl, type SearchResult } from "./search-parse";
import type { ApiSearchProvider } from "./search-provider-types";

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_match, digits: string) =>
      String.fromCodePoint(Number(digits)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    );
}

function stripMarkup(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeResult(
  title: unknown,
  rawUrl: unknown,
  snippet: unknown,
): SearchResult | null {
  if (typeof title !== "string" || !title.trim()) return null;
  if (typeof rawUrl !== "string") return null;
  const url = normalizeExternalHttpUrl(rawUrl);
  if (!url) return null;
  return {
    title: title.trim(),
    url,
    snippet: typeof snippet === "string" ? snippet.trim() : "",
  };
}

export function parseGoogleNewsRssResults(xml: string): SearchResult[] {
  const entries = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];
  return entries.flatMap((entry): SearchResult[] => {
    const title = extractXmlTag(entry, "title");
    const url = extractXmlTag(entry, "link");
    const snippet = extractXmlTag(entry, "description");
    const rawDate = extractXmlTag(entry, "pubDate");
    const parsedDate = Date.parse(rawDate);
    const result = safeResult(title, url, snippet);
    if (!result) return [];
    return [
      {
        ...result,
        publishedAt: Number.isFinite(parsedDate)
          ? new Date(parsedDate).toISOString()
          : null,
      },
    ];
  });
}

function hasJapanese(text: string): boolean {
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(text);
}

export function parseWikipediaResults(
  json: unknown,
  language: "ja" | "en",
): SearchResult[] {
  const items = (json as { query?: { search?: unknown[] } })?.query?.search;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw): SearchResult[] => {
    const item = raw as { title?: unknown; snippet?: unknown };
    if (typeof item.title !== "string" || !item.title.trim()) return [];
    const slug = encodeURIComponent(item.title.trim().replace(/ /g, "_"));
    const result = safeResult(
      item.title,
      `https://${language}.wikipedia.org/wiki/${slug}`,
      typeof item.snippet === "string" ? stripMarkup(item.snippet) : "",
    );
    return result ? [result] : [];
  });
}

function wikipediaProvider(): ApiSearchProvider {
  return {
    name: "wikipedia",
    kind: "vertical",
    weight: 0.9,
    queryAffinity(query) {
      if (
        /\b(?:what is|who is|where is|history of|overview of)\b/i.test(query)
      ) {
        return 0.88;
      }
      if (/(?:とは|誰|どこ|概要|歴史|由来|人物|地理)/.test(query)) return 0.88;
      return 0.34;
    },
    async search(query, signal) {
      const language: "ja" | "en" = hasJapanese(query) ? "ja" : "en";
      const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
      url.searchParams.set("action", "query");
      url.searchParams.set("list", "search");
      url.searchParams.set("srsearch", query);
      url.searchParams.set("srlimit", "8");
      url.searchParams.set("srprop", "snippet");
      url.searchParams.set("format", "json");
      url.searchParams.set("formatversion", "2");
      const json = await fetchSearchJson(
        url.href,
        { headers: { Accept: "application/json" } },
        signal,
      );
      return parseWikipediaResults(json, language);
    },
  };
}

function newsProvider(): ApiSearchProvider {
  return {
    name: "news-rss",
    kind: "vertical",
    weight: 1.25,
    queryAffinity(query) {
      return /ニュース|速報|最新|報道|news|breaking|latest/i.test(query)
        ? 0.98
        : 0;
    },
    async search(query, signal) {
      const url = new URL("https://news.google.com/rss/search");
      url.searchParams.set("q", query);
      url.searchParams.set("hl", "ja");
      url.searchParams.set("gl", "JP");
      url.searchParams.set("ceid", "JP:ja");
      const xml = await fetchSearchText(
        url.href,
        { headers: { Accept: "application/rss+xml, application/xml;q=0.9" } },
        signal,
        /\b(?:application\/rss\+xml|application\/xml|text\/xml)\b/i,
      );
      return parseGoogleNewsRssResults(xml);
    },
  };
}

function extractXmlTag(block: string, tag: string): string {
  const match = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  return match ? stripMarkup(match[1] ?? "") : "";
}

export function parseArxivResults(xml: string): SearchResult[] {
  const entries = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? [];
  return entries.flatMap((entry): SearchResult[] => {
    const title = extractXmlTag(entry, "title");
    const id = extractXmlTag(entry, "id");
    const summary = extractXmlTag(entry, "summary");
    if (!title || !id || /\/api\/errors#/i.test(id)) return [];
    const url = id.replace(/^http:\/\//i, "https://");
    const result = safeResult(title, url, summary);
    return result ? [result] : [];
  });
}

function arxivProvider(): ApiSearchProvider {
  return {
    name: "arxiv",
    kind: "vertical",
    weight: 1.1,
    queryAffinity(query) {
      if (
        /\b(?:paper|preprint|research|study|benchmark|algorithm|theorem|dataset|arxiv|machine learning|neural|transformer)\b/i.test(
          query,
        )
      ) {
        return 0.94;
      }
      if (
        /(?:論文|研究|査読|ベンチマーク|アルゴリズム|定理|データセット|機械学習|ニューラル)/.test(
          query,
        )
      ) {
        return 0.94;
      }
      return 0.16;
    },
    async search(query, signal) {
      const url = new URL("https://export.arxiv.org/api/query");
      url.searchParams.set("search_query", `all:${query.trim()}`);
      url.searchParams.set("start", "0");
      url.searchParams.set("max_results", "8");
      url.searchParams.set("sortBy", "relevance");
      url.searchParams.set("sortOrder", "descending");
      const xml = await fetchSearchText(
        url.href,
        { headers: { Accept: "application/atom+xml, application/xml;q=0.9" } },
        signal,
        /\b(?:application\/atom\+xml|application\/xml|text\/xml)\b/i,
      );
      return parseArxivResults(xml);
    },
  };
}

export function parseGithubRepositoryResults(json: unknown): SearchResult[] {
  const items = (json as { items?: unknown[] })?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw): SearchResult[] => {
    const item = raw as {
      full_name?: unknown;
      html_url?: unknown;
      description?: unknown;
      language?: unknown;
      stargazers_count?: unknown;
    };
    const details: string[] = [];
    if (typeof item.description === "string" && item.description.trim()) {
      details.push(item.description.trim());
    }
    if (typeof item.language === "string" && item.language.trim()) {
      details.push(`Language: ${item.language.trim()}`);
    }
    if (typeof item.stargazers_count === "number") {
      details.push(`Stars: ${item.stargazers_count}`);
    }
    const result = safeResult(
      item.full_name,
      item.html_url,
      details.join(" · "),
    );
    return result ? [result] : [];
  });
}

function githubProvider(): ApiSearchProvider {
  return {
    name: "github",
    kind: "vertical",
    weight: 1,
    queryAffinity(query) {
      if (
        /\b(?:github|repo|repository|source code|open source|library|framework|sdk|cli|npm|crate|package)\b/i.test(
          query,
        )
      ) {
        return 0.96;
      }
      if (
        /(?:リポジトリ|ソースコード|オープンソース|ライブラリ|フレームワーク|実装|パッケージ)/.test(
          query,
        )
      ) {
        return 0.96;
      }
      return 0.14;
    },
    async search(query, signal) {
      const url = new URL("https://api.github.com/search/repositories");
      url.searchParams.set("q", query);
      url.searchParams.set("per_page", "8");
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "Chat-Space-Search-Core",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      const token = process.env.GITHUB_SEARCH_TOKEN?.trim();
      if (token) headers.Authorization = `Bearer ${token}`;
      const json = await fetchSearchJson(url.href, { headers }, signal);
      return parseGithubRepositoryResults(json);
    },
  };
}

export function getBuiltinVerticalProviders(): ApiSearchProvider[] {
  return [
    newsProvider(),
    wikipediaProvider(),
    arxivProvider(),
    githubProvider(),
  ];
}
