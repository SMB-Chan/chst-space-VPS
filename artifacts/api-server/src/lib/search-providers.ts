import { fetch as undiciFetch } from "undici";
import { logger, safeFailureFields } from "./logger";
import { readResponseTextLimited } from "./bounded-body";
import { normalizeExternalHttpUrl, type SearchResult } from "./search-parse";

/**
 * API-based search providers. Hosts are fixed and known; only the query string
 * carries user-controlled data. Provider responses are still untrusted and
 * are bounded, parsed defensively, and URL-normalized before use.
 */

const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const PRIMARY_MIN_RESULTS = 5;
const PRIMARY_MIN_DOMAINS = 3;
const MAX_MERGED_API_RESULTS = 10;
const DIVERSE_DOMAIN_SOFT_CAP = 2;
export const SEARCH_PROVIDER_REDIRECT_POLICY = "error" as const;

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
    // Authenticated machine-API endpoints are fixed and are not expected to
    // redirect. Reject redirects rather than carrying API credentials onto a
    // second destination selected by an unexpected provider response.
    const res = await undiciFetch(url, {
      ...init,
      signal: controller.signal,
      redirect: SEARCH_PROVIDER_REDIRECT_POLICY,
    });
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
  const normalizedTitle =
    typeof title === "string" && title.trim()
      ? title.trim()
      : allowUrlAsTitle
        ? url
        : "";
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

function domainOf(result: SearchResult): string {
  try {
    return new URL(result.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function distinctDomainCount(results: SearchResult[]): number {
  return new Set(results.map(domainOf).filter(Boolean)).size;
}

export function hasSufficientPrimaryCoverage(results: SearchResult[]): boolean {
  return (
    results.length >= PRIMARY_MIN_RESULTS &&
    distinctDomainCount(results) >= PRIMARY_MIN_DOMAINS
  );
}

/**
 * Merge provider-ranked lists while preserving useful provider ordering and
 * avoiding one provider/domain monopolising the ensemble. The domain cap is a
 * soft first pass: remaining unique URLs are used afterward if diversity alone
 * would leave too few results.
 */
export function mergeSearchProviderResults(
  resultSets: SearchResult[][],
  maxResults = MAX_MERGED_API_RESULTS,
): SearchResult[] {
  const output: SearchResult[] = [];
  const seenUrls = new Set<string>();
  const perDomain = new Map<string, number>();
  const cursors = resultSets.map(() => 0);

  const addRoundRobin = (enforceDomainCap: boolean): void => {
    let progressed = true;
    while (output.length < maxResults && progressed) {
      progressed = false;
      for (let setIndex = 0; setIndex < resultSets.length; setIndex++) {
        const results = resultSets[setIndex] ?? [];
        while (cursors[setIndex] < results.length) {
          const candidate = results[cursors[setIndex]++]!;
          if (seenUrls.has(candidate.url)) continue;
          const domain = domainOf(candidate);
          if (
            enforceDomainCap &&
            domain &&
            (perDomain.get(domain) ?? 0) >= DIVERSE_DOMAIN_SOFT_CAP
          ) {
            continue;
          }
          seenUrls.add(candidate.url);
          if (domain) perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
          output.push(candidate);
          progressed = true;
          break;
        }
        if (output.length >= maxResults) return;
      }
    }
  };

  addRoundRobin(true);

  // The first pass advances past domain-capped candidates. Re-scan every set
  // for remaining unique URLs without the cap so sparse provider combinations
  // still return as much useful coverage as possible.
  if (output.length < maxResults) {
    for (const results of resultSets) {
      for (const candidate of results) {
        if (output.length >= maxResults) break;
        if (seenUrls.has(candidate.url)) continue;
        seenUrls.add(candidate.url);
        output.push(candidate);
      }
    }
  }

  return output;
}

async function runProvider(
  provider: ApiSearchProvider,
  query: string,
): Promise<SearchResult[]> {
  try {
    const results = await provider.search(query);
    if (results.length > 0) {
      logger.debug(
        { provider: provider.name, resultCount: results.length },
        "Search API provider used",
      );
    } else {
      logger.warn({ provider: provider.name }, "Search API returned no results");
    }
    return results;
  } catch (err) {
    logger.warn(
      {
        ...safeFailureFields(err, "search-provider", "SEARCH_API_PROVIDER_FAILED"),
        provider: provider.name,
      },
      "Search API provider failed",
    );
    return [];
  }
}

/**
 * Prefer one provider when it already gives sufficient coverage. Only pay the
 * latency/API-cost of additional providers when the primary set is sparse or
 * concentrated in too few domains. Secondary providers are then queried in
 * parallel and merged with URL deduplication + domain diversity.
 *
 * Raw queries are intentionally never written to logs because they can contain
 * user-provided personal or confidential text.
 */
export async function searchWithProviders(
  query: string,
  providers: ApiSearchProvider[],
): Promise<SearchResult[]> {
  if (providers.length === 0) return [];

  const primaryResults = await runProvider(providers[0]!, query);
  if (
    providers.length === 1 ||
    hasSufficientPrimaryCoverage(primaryResults)
  ) {
    return primaryResults.slice(0, MAX_MERGED_API_RESULTS);
  }

  const secondaryResults = await Promise.all(
    providers.slice(1).map((provider) => runProvider(provider, query)),
  );
  return mergeSearchProviderResults(
    [primaryResults, ...secondaryResults],
    MAX_MERGED_API_RESULTS,
  );
}

export async function searchWithApiProviders(query: string): Promise<SearchResult[]> {
  return searchWithProviders(query, getConfiguredApiProviders());
}
