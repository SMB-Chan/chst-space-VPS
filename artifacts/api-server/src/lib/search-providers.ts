import { fetch as undiciFetch } from "undici";
import { logger } from "./logger";
import type { SearchResult } from "./search-parse";

/**
 * API-based search providers.  When an API key is configured these replace
 * the fragile DuckDuckGo HTML scraping path, which stays as the keyless
 * fallback.  Hosts are fixed and known, so no SSRF guard is needed here —
 * only the query string carries user input.
 */

const PROVIDER_TIMEOUT_MS = 10_000;

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
    if (!res.ok) {
      throw new Error(`Search API returned ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Response parsers (pure, unit-tested)
// ---------------------------------------------------------------------------

export function parseBraveResults(json: unknown): SearchResult[] {
  const results = (json as { web?: { results?: unknown[] } })?.web?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const r of results) {
    const item = r as { title?: string; url?: string; description?: string };
    if (typeof item.title === "string" && typeof item.url === "string") {
      out.push({
        title: item.title,
        url: item.url,
        snippet: typeof item.description === "string" ? item.description : "",
      });
    }
  }
  return out;
}

export function parseTavilyResults(json: unknown): SearchResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const r of results) {
    const item = r as { title?: string; url?: string; content?: string };
    if (typeof item.title === "string" && typeof item.url === "string") {
      out.push({
        title: item.title,
        url: item.url,
        snippet: typeof item.content === "string" ? item.content : "",
      });
    }
  }
  return out;
}

export function parseExaResults(json: unknown): SearchResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const out: SearchResult[] = [];
  for (const r of results) {
    const item = r as { title?: string; url?: string; text?: string };
    if (typeof item.url === "string") {
      out.push({
        title: typeof item.title === "string" && item.title ? item.title : item.url,
        url: item.url,
        snippet: typeof item.text === "string" ? item.text : "",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/** Tavily — LLM-oriented; returns cleaned page content as snippets. */
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
        body: JSON.stringify({
          query,
          max_results: 8,
          search_depth: "basic",
        }),
      });
      return parseTavilyResults(json);
    },
  };
}

/** Exa — neural/semantic search; tolerant of vague natural-language queries. */
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

/** Brave — independent index, plain web results. */
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

/**
 * Providers with a configured API key, in preference order.
 * Read from env on every call so tests and runtime config stay in sync.
 */
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
 * Try each configured API provider in order; return the first non-empty
 * result set.  Returns [] when every provider failed or returned nothing —
 * the caller then falls back to DuckDuckGo scraping.
 */
export async function searchWithApiProviders(query: string): Promise<SearchResult[]> {
  for (const provider of getConfiguredApiProviders()) {
    try {
      const results = await provider.search(query);
      if (results.length > 0) {
        logger.debug({ provider: provider.name, query }, "Search API provider used");
        return results;
      }
      logger.warn({ provider: provider.name, query }, "Search API returned no results");
    } catch (err) {
      logger.warn({ err, provider: provider.name, query }, "Search API provider failed");
    }
  }
  return [];
}
