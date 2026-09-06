import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseBraveResults,
  parseSearxngResults,
  parseTavilyResults,
  parseExaResults,
  getConfiguredApiProviders,
  hasSufficientPrimaryCoverage,
  mergeSearchProviderResults,
  normalizeSearxngBaseUrl,
  resetSearchEngineRuntimeForTests,
  resetSearchProviderHealthForTests,
  searchWithProviders,
  SEARCH_PROVIDER_REDIRECT_POLICY,
  type ApiSearchProvider,
} from "./search-providers";
import type { SearchResult } from "./search-parse";

const ENV_KEYS = [
  "SEARXNG_BASE_URL",
  "SEARXNG_USERNAME",
  "SEARXNG_PASSWORD",
  "TAVILY_API_KEY",
  "EXA_API_KEY",
  "BRAVE_SEARCH_API_KEY",
  "SEARCH_INITIAL_FANOUT",
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  resetSearchEngineRuntimeForTests();
  resetSearchProviderHealthForTests();
});

function result(host: string, path: string, title = path): SearchResult {
  return {
    title,
    url: `https://${host}/${path}`,
    snippet: `${title} snippet`,
  };
}

function stubProvider(
  name: string,
  implementation: (signal?: AbortSignal) => Promise<SearchResult[]>,
): ApiSearchProvider & { search: ReturnType<typeof vi.fn> } {
  return {
    name,
    search: vi.fn((_query: string, signal?: AbortSignal) =>
      implementation(signal),
    ),
  };
}

describe("search provider transport policy", () => {
  it("rejects redirects from authenticated fixed API endpoints", () => {
    expect(SEARCH_PROVIDER_REDIRECT_POLICY).toBe("error");
  });
});

describe("parseBraveResults", () => {
  it("maps web results to SearchResult", () => {
    const json = {
      web: {
        results: [
          {
            title: "記事A",
            url: "https://example.com/a",
            description: "概要A",
          },
          { title: "記事B", url: "https://example.com/b" },
        ],
      },
    };
    const results = parseBraveResults(json);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "記事A",
      url: "https://example.com/a",
      snippet: "概要A",
    });
    expect(results[1].snippet).toBe("");
  });

  it("returns [] for malformed payloads", () => {
    expect(parseBraveResults({})).toEqual([]);
    expect(parseBraveResults(null)).toEqual([]);
    expect(parseBraveResults({ web: { results: "nope" } })).toEqual([]);
  });

  it("drops non-http and credential-bearing URLs", () => {
    const json = {
      web: {
        results: [
          { title: "JS", url: "javascript:alert(1)" },
          {
            title: "Credentials",
            url: "https://user:pass@example.com/private",
          },
          { title: "OK", url: "https://example.com/ok#fragment" },
        ],
      },
    };
    expect(parseBraveResults(json)).toEqual([
      { title: "OK", url: "https://example.com/ok", snippet: "" },
    ]);
  });
});

describe("parseTavilyResults", () => {
  it("maps results with content as snippet", () => {
    const json = {
      results: [
        { title: "T", url: "https://example.com", content: "本文抜粋" },
      ],
    };
    expect(parseTavilyResults(json)).toEqual([
      { title: "T", url: "https://example.com/", snippet: "本文抜粋" },
    ]);
  });

  it("drops entries without title or url", () => {
    const json = { results: [{ url: "https://example.com" }, { title: "T" }] };
    expect(parseTavilyResults(json)).toEqual([]);
  });
});

describe("parseExaResults", () => {
  it("maps results, falling back to url as title", () => {
    const json = {
      results: [
        { title: "E", url: "https://example.com/e", text: "テキスト" },
        { title: "", url: "https://example.com/f" },
      ],
    };
    const results = parseExaResults(json);
    expect(results[0]).toEqual({
      title: "E",
      url: "https://example.com/e",
      snippet: "テキスト",
    });
    expect(results[1].title).toBe("https://example.com/f");
  });
});

describe("SearXNG configuration", () => {
  it("normalizes http(s) base URLs including subpaths", () => {
    expect(normalizeSearxngBaseUrl("https://searx.example.com/")).toBe(
      "https://searx.example.com",
    );
    expect(normalizeSearxngBaseUrl("http://127.0.0.1:8080/searxng///")).toBe(
      "http://127.0.0.1:8080/searxng",
    );
  });

  it("rejects embedded credentials, query/fragment data, and non-http schemes", () => {
    expect(
      normalizeSearxngBaseUrl("https://user:pass@searx.example.com"),
    ).toBeNull();
    expect(
      normalizeSearxngBaseUrl("https://searx.example.com/?x=1"),
    ).toBeNull();
    expect(normalizeSearxngBaseUrl("https://searx.example.com/#x")).toBeNull();
    expect(normalizeSearxngBaseUrl("file:///tmp/searxng")).toBeNull();
    expect(normalizeSearxngBaseUrl("not a url")).toBeNull();
  });
});

describe("getConfiguredApiProviders", () => {
  it("returns no providers when no keys are set", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(getConfiguredApiProviders()).toEqual([]);
  });

  it("orders providers searxng > tavily > exa > brave", () => {
    process.env.SEARXNG_BASE_URL = "https://searx.internal.example.com";
    process.env.TAVILY_API_KEY = "t";
    process.env.EXA_API_KEY = "e";
    process.env.BRAVE_SEARCH_API_KEY = "b";
    expect(getConfiguredApiProviders().map((p) => p.name)).toEqual([
      "searxng",
      "tavily",
      "exa",
      "brave",
    ]);
  });

  it("ignores an invalid searxng URL instead of creating a provider", () => {
    process.env.SEARXNG_BASE_URL = "file:///tmp/searxng";
    process.env.BRAVE_SEARCH_API_KEY = "b";
    expect(getConfiguredApiProviders().map((p) => p.name)).toEqual(["brave"]);
  });

  it("orders providers tavily > exa > brave without searxng", () => {
    delete process.env.SEARXNG_BASE_URL;
    process.env.TAVILY_API_KEY = "t";
    process.env.EXA_API_KEY = "e";
    process.env.BRAVE_SEARCH_API_KEY = "b";
    expect(getConfiguredApiProviders().map((p) => p.name)).toEqual([
      "tavily",
      "exa",
      "brave",
    ]);
  });

  it("ignores blank keys", () => {
    process.env.TAVILY_API_KEY = "  ";
    delete process.env.EXA_API_KEY;
    process.env.BRAVE_SEARCH_API_KEY = "b";
    expect(getConfiguredApiProviders().map((p) => p.name)).toEqual(["brave"]);
  });
});

describe("conditional provider ensemble", () => {
  it("accepts a primary result set only when it has enough results and domains", () => {
    expect(
      hasSufficientPrimaryCoverage([
        result("a.example", "1"),
        result("a.example", "2"),
        result("b.example", "3"),
        result("c.example", "4"),
        result("c.example", "5"),
      ]),
    ).toBe(true);
    expect(
      hasSufficientPrimaryCoverage([
        result("a.example", "1"),
        result("a.example", "2"),
        result("a.example", "3"),
        result("a.example", "4"),
        result("b.example", "5"),
      ]),
    ).toBe(false);
  });

  it("does not call secondary providers when primary coverage is sufficient", async () => {
    process.env.SEARCH_INITIAL_FANOUT = "1";
    const primaryResults = [
      result("a.example", "1"),
      result("a.example", "2"),
      result("b.example", "3"),
      result("c.example", "4"),
      result("c.example", "5"),
    ];
    const primary = stubProvider("primary", async () => primaryResults);
    const secondary = stubProvider("secondary", async () => [
      result("d.example", "6"),
    ]);

    const results = await searchWithProviders("query", [primary, secondary]);
    expect(results).toEqual(primaryResults);
    expect(primary.search).toHaveBeenCalledOnce();
    expect(secondary.search).not.toHaveBeenCalled();
  });

  it("queries secondary providers only when the primary is sparse or concentrated", async () => {
    process.env.SEARCH_INITIAL_FANOUT = "1";
    const duplicate = result("same.example", "duplicate");
    const primary = stubProvider("primary", async () => [
      duplicate,
      result("same.example", "p2"),
      result("same.example", "p3"),
    ]);
    const second = stubProvider("second", async () => [
      duplicate,
      result("two.example", "s2"),
      result("three.example", "s3"),
    ]);
    const third = stubProvider("third", async () => [
      result("four.example", "t1"),
      result("five.example", "t2"),
    ]);

    const results = await searchWithProviders("query", [
      primary,
      second,
      third,
    ]);
    expect(second.search).toHaveBeenCalledOnce();
    expect(third.search).toHaveBeenCalledOnce();
    expect(results.filter((item) => item.url === duplicate.url)).toHaveLength(
      1,
    );
    expect(
      new Set(results.map((item) => new URL(item.url).hostname)).size,
    ).toBeGreaterThanOrEqual(4);
    expect(results.length).toBeGreaterThan(primary.search.mock.results.length);
  });

  it("falls back to secondary providers when the primary throws", async () => {
    process.env.SEARCH_INITIAL_FANOUT = "1";
    const primary = stubProvider("primary", async () => {
      throw new Error("primary unavailable");
    });
    const secondaryResults = [
      result("two.example", "1"),
      result("three.example", "2"),
    ];
    const secondary = stubProvider("secondary", async () => secondaryResults);

    const results = await searchWithProviders("query", [primary, secondary]);
    expect(results).toEqual(secondaryResults);
    expect(primary.search).toHaveBeenCalledOnce();
    expect(secondary.search).toHaveBeenCalledOnce();
  });

  it("starts two providers in the initial wave by default", async () => {
    delete process.env.SEARCH_INITIAL_FANOUT;
    const primary = stubProvider("default-primary", async () => [
      result("same.example", "p1"),
      result("same.example", "p2"),
      result("same.example", "p3"),
    ]);
    const secondary = stubProvider("default-secondary", async () => [
      result("two.example", "s1"),
      result("three.example", "s2"),
    ]);
    const tertiary = stubProvider("default-tertiary", async () => [
      result("four.example", "t1"),
    ]);

    await searchWithProviders("query", [primary, secondary, tertiary]);

    expect(primary.search).toHaveBeenCalledOnce();
    expect(secondary.search).toHaveBeenCalledOnce();
    expect(tertiary.search).not.toHaveBeenCalled();
  });

  it("propagates parent cancellation instead of launching fallback providers", async () => {
    process.env.SEARCH_INITIAL_FANOUT = "1";
    const controller = new AbortController();
    const cancelled = new Error("client disconnected");
    const primary = stubProvider("primary", async (signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(cancelled);
      throw cancelled;
    });
    const secondary = stubProvider("secondary", async () => [
      result("two.example", "1"),
    ]);

    await expect(
      searchWithProviders("query", [primary, secondary], controller.signal),
    ).rejects.toBe(cancelled);
    expect(primary.search).toHaveBeenCalledOnce();
    expect(secondary.search).not.toHaveBeenCalled();
  });

  it("does not start a provider when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    const cancelled = new Error("already cancelled");
    controller.abort(cancelled);
    const primary = stubProvider("primary", async () => [
      result("one.example", "1"),
    ]);

    await expect(
      searchWithProviders("query", [primary], controller.signal),
    ).rejects.toBe(cancelled);
    expect(primary.search).not.toHaveBeenCalled();
  });

  it("round-robins providers and deduplicates URLs while keeping a soft domain cap", () => {
    const duplicate = result("a.example", "dup");
    const merged = mergeSearchProviderResults(
      [
        [duplicate, result("a.example", "p2"), result("a.example", "p3")],
        [duplicate, result("b.example", "s2"), result("b.example", "s3")],
        [result("c.example", "t1"), result("d.example", "t2")],
      ],
      6,
    );

    expect(merged).toHaveLength(6);
    expect(merged.filter((item) => item.url === duplicate.url)).toHaveLength(1);
    const firstFourDomains = merged
      .slice(0, 4)
      .map((item) => new URL(item.url).hostname);
    expect(new Set(firstFourDomains).size).toBeGreaterThanOrEqual(3);
  });
});

describe("parseSearxngResults", () => {
  it("maps searxng json results and drops invalid entries", () => {
    expect(
      parseSearxngResults({
        results: [
          {
            title: "Doc",
            url: "https://docs.example.com/guide",
            content: "how to",
          },
          { title: "no url", content: "x" },
          { url: "javascript:alert(1)" },
        ],
      }),
    ).toEqual([
      {
        title: "Doc",
        url: "https://docs.example.com/guide",
        snippet: "how to",
      },
    ]);
    expect(parseSearxngResults({ results: "nope" })).toEqual([]);
  });
});
