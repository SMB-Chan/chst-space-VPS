import { afterEach, describe, expect, it } from "vitest";
import {
  parseBraveResults,
  parseTavilyResults,
  parseExaResults,
  getConfiguredApiProviders,
} from "./search-providers";

const ENV_KEYS = ["TAVILY_API_KEY", "EXA_API_KEY", "BRAVE_SEARCH_API_KEY"] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

describe("parseBraveResults", () => {
  it("maps web results to SearchResult", () => {
    const json = {
      web: {
        results: [
          { title: "記事A", url: "https://example.com/a", description: "概要A" },
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
});

describe("parseTavilyResults", () => {
  it("maps results with content as snippet", () => {
    const json = {
      results: [{ title: "T", url: "https://example.com", content: "本文抜粋" }],
    };
    expect(parseTavilyResults(json)).toEqual([
      { title: "T", url: "https://example.com", snippet: "本文抜粋" },
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

describe("getConfiguredApiProviders", () => {
  it("returns no providers when no keys are set", () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect(getConfiguredApiProviders()).toEqual([]);
  });

  it("orders providers tavily > exa > brave", () => {
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
