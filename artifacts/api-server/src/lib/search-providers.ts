import { fetch as undiciFetch } from "undici";
import { logger } from "./logger";
import { readResponseTextLimited } from "./bounded-body";
import { normalizeExternalHttpUrl, type SearchResult } from "./search-parse";

/**
 * API-based search providers. Hosts are fixed and known; only the query string
 * carries user-controlled data. Provider responses are still untrusted and
 * are bounded, parsed defensively, and URL-normalized before use.
 */

const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

export interface ApiSearchProvider {
  name: string;
  search(query: string): Promise<SearchResult[]>;
}

async function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const res = await undiciFetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`Search API returned ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (!/\b(?:application\/json|[^;]+\+json)\b/i.test(contentType)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error("Search API returned a non-JSON response");
    }
    const text = await readResponseTextLimited(res, MAX_PROVIDER_RESPONSE_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Search API returned invalid JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

function safeResult(
  title: unknown,
  rawUrl: unknown,
  snippet: unknown,
  allowUrlAsTitle = false,
): SearchResult | null {
  if (typeof rawUrl !== "string") return null;
  const url = normalizeExternalHttpUrl(rawUrl);
  if (!url) return null;
  const normalizedTitle = typeof title === "string" && title.trim() ? title.trim() : allowUrlAsTitle ? url : "";
  if (!normalizedTitle) return null;
  return {
    title: normalizedTitle,
    url,
    snippet: typeof snippet === "string" ? snippet : "",
  };
}

export function parseBraveResults(json: unknown): SearchResult[] {
  const results = (json as { web?: { results?: unknown[] } })?.web?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw): SearchResult[] => {
    const item = raw as { title?: unknown; url?: unknown; description?: unknown };
    const result = safeResult(item.title, item.url, item.description);
    return result ? [result] : [];
  });
}

export function parseTavilyResults(json: unknown): SearchResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw): SearchResult[] => {
    const item = raw as { title?: unknown; url?: unknown; content?: unknown };
    const result = safeResult(item.title, item.url, item.content);
    return result ? [result] : [];
  });
}

export function parseExaResults(json: unknown): SearchResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw): SearchResult[] => {
    const item = raw as { title?: unknown; url?: unknown; text?: unknown };
    const result = safeResult(item.title, item.url, item.text, true);
    return result ? [result] : [];
  });
}

function tavilyProvider(apiKey: string): ApiSearchProvider {
  return {
    name: "tavily",
    async search(query) {
      const json = await fetchJson("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query, max_results: 8, search_depth: "basic" }),
      });
      return parseTavilyResults(json);
    },
  };
}

function exaProvider(apiKey: string): ApiSearchProvider {
  return {
    name: "exa",
    async search(query) {
      const json = await fetchJson("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          query,
          numResults: 8,
          contents: { text: { maxCharacters: 500 } },
        }),
      });
      return parseExaResults(json);
    },
  };
}

function braveProvider(apiKey: string): ApiSearchProvider {
  return {
    name: "brave",
    async search(query) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
      const json = await fetchJson(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      });
      return parseBraveResults(json);
    },
  };
}

export function getConfiguredApiProviders(): ApiSearchProvider[] {
  const providers: ApiSearchProvider[] = [];
  const tavilyKey = process.env.TAVILY_API_KEY?.trim();
  const exaKey = process.env.EXA_API_KEY?.trim();
  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (tavilyKey) providers.push(tavilyProvider(tavilyKey));
  if (exaKey) providers.push(exaProvider(exaKey));
  if (braveKey) providers.push(braveProvider(braveKey));
  return providers;
}

/**
 * Try each configured API provider in order; return the first non-empty set.
 * Raw queries are intentionally not written to logs because they can contain
 * user-provided personal or confidential text.
 */
export async function searchWithApiProviders(query: string): Promise<SearchResult[]> {
  for (const provider of getConfiguredApiProviders()) {
    try {
      const results = await provider.search(query);
      if (results.length > 0) {
        logger.debug({ provider: provider.name, resultCount: results.length }, "Search API provider used");
        return results;
      }
      logger.warn({ provider: provider.name }, "Search API returned no results");
    } catch (err) {
      logger.warn({ err, provider: provider.name }, "Search API provider failed");
    }
  }
  return [];
}
