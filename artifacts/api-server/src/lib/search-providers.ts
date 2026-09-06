import { fetch as undiciFetch } from "undici";
import { logger, safeFailureFields } from "./logger";
import { readResponseTextLimited } from "./bounded-body";
import { normalizeExternalHttpUrl, type SearchResult } from "./search-parse";
import {
  fuseSearchProviderResults,
  getSearchProviderHealth,
  isSearchProviderAvailable,
  recordSearchProviderFailure,
  recordSearchProviderSuccess,
  resetSearchProviderHealthForTests,
  type RankedProviderResults,
} from "./search-core";

/**
 * API-based search providers. Fixed SaaS providers use known hosts; SearXNG is
 * an operator-configured self-hosted endpoint. Provider responses are still
 * untrusted and are bounded, parsed defensively, and URL-normalized before use.
 *
 * Provider scheduling, cooldown and rank fusion are implemented independently
 * in search-core.ts. No SearXNG source code is embedded here.
 */

const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const PRIMARY_MIN_RESULTS = 5;
const PRIMARY_MIN_DOMAINS = 3;
const MAX_MERGED_API_RESULTS = 10;
const DEFAULT_INITIAL_FANOUT = 2;
const MAX_INITIAL_FANOUT = 3;
export const SEARCH_PROVIDER_REDIRECT_POLICY = "error" as const;

export interface ApiSearchProvider {
  name: string;
  /** Optional relative contribution to rank fusion; defaults to 1. */
  weight?: number;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

export { getSearchProviderHealth, resetSearchProviderHealthForTests };

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function providerHttpError(status: number, retryAfter: string | null): Error {
  const error = new Error(`Search API returned ${status}`) as Error & {
    status?: number;
    retryAfterMs?: number;
  };
  error.status = status;
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

async function fetchJson(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const abortParent = () =>
    controller.abort(signal?.reason ?? new Error("Operation cancelled"));
  if (signal?.aborted) abortParent();
  else signal?.addEventListener("abort", abortParent, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Search provider timed out")),
    PROVIDER_TIMEOUT_MS,
  );
  try {
    // Authenticated machine-API endpoints are not expected to redirect. Reject
    // redirects rather than carrying API credentials onto a second destination
    // selected by an unexpected provider response.
    const res = await undiciFetch(url, {
      ...init,
      signal: controller.signal,
      redirect: SEARCH_PROVIDER_REDIRECT_POLICY,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw providerHttpError(res.status, res.headers.get("retry-after"));
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!/\b(?:application\/json|[^;]+\+json)\b/i.test(contentType)) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error("Search API returned a non-JSON response");
    }
    const text = await readResponseTextLimited(
      res,
      MAX_PROVIDER_RESPONSE_BYTES,
    );
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Search API returned invalid JSON");
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortParent);
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
    const item = raw as {
      title?: unknown;
      url?: unknown;
      description?: unknown;
    };
    const result = safeResult(item.title, item.url, item.description);
    return result ? [result] : [];
  });
}

export function parseSearxngResults(json: unknown): SearchResult[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw): SearchResult[] => {
    const item = raw as { title?: unknown; url?: unknown; content?: unknown };
    const result = safeResult(item.title, item.url, item.content);
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
    async search(query, signal) {
      const json = await fetchJson(
        "https://api.tavily.com/search",
        {
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
        },
        signal,
      );
      return parseTavilyResults(json);
    },
  };
}

function exaProvider(apiKey: string): ApiSearchProvider {
  return {
    name: "exa",
    async search(query, signal) {
      const json = await fetchJson(
        "https://api.exa.ai/search",
        {
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
        },
        signal,
      );
      return parseExaResults(json);
    },
  };
}

function braveProvider(apiKey: string): ApiSearchProvider {
  return {
    name: "brave",
    async search(query, signal) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
      const json = await fetchJson(
        url,
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": apiKey,
          },
        },
        signal,
      );
      return parseBraveResults(json);
    },
  };
}

/**
 * Normalize the operator-configured SearXNG base URL. Private/local HTTP hosts
 * are intentionally allowed because a self-hosted instance commonly lives on
 * an internal network. Embedded credentials, queries, fragments, and non-HTTP
 * schemes are rejected; Basic auth must use the dedicated env vars instead.
 */
export function normalizeSearxngBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const pathname = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

/**
 * Self-hosted SearXNG metasearch. This remains an optional compatibility
 * provider; Chat-Space does not depend on it for scheduling or fusion.
 */
function searxngProvider(baseUrl: string): ApiSearchProvider {
  const username = process.env.SEARXNG_USERNAME?.trim();
  const password = process.env.SEARXNG_PASSWORD?.trim();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (username && password) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }
  return {
    name: "searxng",
    async search(query, signal) {
      const url = new URL(`${baseUrl}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const json = await fetchJson(url.href, { headers }, signal);
      return parseSearxngResults(json);
    },
  };
}

export function getConfiguredApiProviders(): ApiSearchProvider[] {
  const providers: ApiSearchProvider[] = [];
  const rawSearxngUrl = process.env.SEARXNG_BASE_URL?.trim();
  if (rawSearxngUrl) {
    const searxngUrl = normalizeSearxngBaseUrl(rawSearxngUrl);
    if (searxngUrl) providers.push(searxngProvider(searxngUrl));
    else {
      logger.warn(
        { component: "search-provider", errorCode: "SEARXNG_CONFIG_INVALID" },
        "Ignoring invalid SEARXNG_BASE_URL",
      );
    }
  }
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
 * Backward-compatible merge entry point. Internally this now uses weighted RRF
 * instead of round-robin interleaving, so agreement across providers is a
 * positive ranking signal while a soft domain cap still protects diversity.
 */
export function mergeSearchProviderResults(
  resultSets: SearchResult[][],
  maxResults = MAX_MERGED_API_RESULTS,
): SearchResult[] {
  return fuseSearchProviderResults(
    resultSets.map((results, index) => ({
      providerName: `provider-${index}`,
      results,
    })),
    maxResults,
  );
}

function configuredInitialFanout(): number {
  const raw = Number(
    process.env.SEARCH_INITIAL_FANOUT ?? DEFAULT_INITIAL_FANOUT,
  );
  if (!Number.isFinite(raw)) return DEFAULT_INITIAL_FANOUT;
  return Math.min(MAX_INITIAL_FANOUT, Math.max(1, Math.floor(raw)));
}

async function runProvider(
  provider: ApiSearchProvider,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!isSearchProviderAvailable(provider.name)) {
    const health = getSearchProviderHealth(provider.name);
    logger.debug(
      {
        provider: provider.name,
        providerHealth: health.health,
        suspendedUntil: health.suspendedUntil,
      },
      "Skipping search provider in cooldown",
    );
    return [];
  }
  try {
    const results = await provider.search(query, signal);
    recordSearchProviderSuccess(provider.name);
    if (results.length > 0) {
      logger.debug(
        { provider: provider.name, resultCount: results.length },
        "Search API provider used",
      );
    } else {
      logger.warn(
        { provider: provider.name },
        "Search API returned no results",
      );
    }
    return results;
  } catch (err) {
    // Client disconnect/cancellation is a lifecycle event, not a provider
    // failure. Propagate it so we do not launch fallbacks after the response is
    // already gone.
    if (signal?.aborted) throw err;
    const health = recordSearchProviderFailure(provider.name, err);
    logger.warn(
      {
        ...safeFailureFields(
          err,
          "search-provider",
          "SEARCH_API_PROVIDER_FAILED",
        ),
        provider: provider.name,
        providerHealth: health.health,
        failureKind: health.lastFailureKind,
        suspendedUntil: health.suspendedUntil || undefined,
      },
      "Search API provider failed",
    );
    return [];
  }
}

function rankedSet(
  provider: ApiSearchProvider,
  results: SearchResult[],
): RankedProviderResults {
  return {
    providerName: provider.name,
    weight: provider.weight,
    results,
  };
}

/**
 * Adaptive provider ensemble inspired by metasearch scheduling principles but
 * implemented independently for Chat-Space:
 * - providers in cooldown are skipped rather than repeatedly hammered;
 * - the initial wave is configurable (SEARCH_INITIAL_FANOUT, 1..3);
 * - if coverage is insufficient, remaining healthy providers run in parallel;
 * - ranked lists are combined with weighted Reciprocal Rank Fusion.
 *
 * The default fan-out is 2 for lower latency and broader first-wave coverage.
 * Operators can set SEARCH_INITIAL_FANOUT to an explicit value from 1 to 3.
 * Raw queries are intentionally never written to logs.
 */
export async function searchWithProviders(
  query: string,
  providers: ApiSearchProvider[],
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (providers.length === 0) return [];
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Search cancelled");
  }

  const available = providers.filter((provider) =>
    isSearchProviderAvailable(provider.name),
  );
  if (available.length === 0) return [];

  const initialCount = Math.min(configuredInitialFanout(), available.length);
  const initialProviders = available.slice(0, initialCount);
  const initialResults = await Promise.all(
    initialProviders.map((provider) => runProvider(provider, query, signal)),
  );
  const ranked: RankedProviderResults[] = initialProviders.map(
    (provider, index) => rankedSet(provider, initialResults[index] ?? []),
  );
  const initialMerged = fuseSearchProviderResults(
    ranked,
    MAX_MERGED_API_RESULTS,
  );

  if (
    initialCount === available.length ||
    hasSufficientPrimaryCoverage(initialMerged)
  ) {
    return initialMerged;
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Search cancelled");
  }

  const remainingProviders = available.slice(initialCount);
  const remainingResults = await Promise.all(
    remainingProviders.map((provider) => runProvider(provider, query, signal)),
  );
  remainingProviders.forEach((provider, index) => {
    ranked.push(rankedSet(provider, remainingResults[index] ?? []));
  });
  return fuseSearchProviderResults(ranked, MAX_MERGED_API_RESULTS);
}

export async function searchWithApiProviders(
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  return searchWithProviders(query, getConfiguredApiProviders(), signal);
}
