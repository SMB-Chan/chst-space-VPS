import { logger, safeFailureFields } from "./logger";
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
import { fetchSearchJson } from "./search-http";
import {
  rankSearchEngines,
  recordSearchEngineObservation,
  resetSearchEngineRuntimeForTests,
} from "./search-engine-scheduler";
import { getBuiltinVerticalProviders } from "./search-vertical-providers";
import {
  planSearchQueries,
  type SearchQueryPlan,
  type SearchSubqueryRole,
} from "./search-query-planner";
import type { ApiSearchProvider } from "./search-provider-types";

/**
 * API-based and vertical search engines. Provider responses are untrusted and
 * bounded, parsed defensively, and URL-normalized before use. Scheduling,
 * cooldown and rank fusion are implemented independently for Chat-Space.
 */

const PRIMARY_MIN_RESULTS = 5;
const PRIMARY_MIN_DOMAINS = 3;
const MAX_MERGED_API_RESULTS = 10;
const DEFAULT_INITIAL_FANOUT = 2;
const MAX_INITIAL_FANOUT = 3;
const MIN_VERTICAL_QUERY_AFFINITY = 0.55;

export { SEARCH_PROVIDER_REDIRECT_POLICY } from "./search-http";
export type { ApiSearchProvider } from "./search-provider-types";
export {
  getSearchProviderHealth,
  resetSearchProviderHealthForTests,
  resetSearchEngineRuntimeForTests,
};

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
    kind: "general",
    async search(query, signal) {
      const json = await fetchSearchJson(
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
    kind: "general",
    async search(query, signal) {
      const json = await fetchSearchJson(
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
    kind: "general",
    async search(query, signal) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
      const json = await fetchSearchJson(
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
    kind: "general",
    async search(query, signal) {
      const url = new URL(`${baseUrl}/search`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const json = await fetchSearchJson(url.href, { headers }, signal);
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

interface ProviderExecution {
  provider: ApiSearchProvider;
  results: SearchResult[];
  success: boolean;
  latencyMs: number;
}

interface TaggedProviderExecution {
  role: SearchSubqueryRole;
  execution: ProviderExecution;
}

interface ProviderSearchRun {
  results: SearchResult[];
  executions: ProviderExecution[];
}

function contributionCount(
  providerResults: SearchResult[],
  finalResults: SearchResult[],
): number {
  const finalUrls = new Set(finalResults.map((result) => result.url));
  return new Set(
    providerResults
      .map((result) => result.url)
      .filter((url) => finalUrls.has(url)),
  ).size;
}

function logSearchExecutionMetadata(
  executions: TaggedProviderExecution[],
  finalResults: SearchResult[],
): void {
  const finalResultCount = finalResults.length;
  const finalDistinctDomainCount = distinctDomainCount(finalResults);
  for (const { role, execution } of executions) {
    logger.debug(
      {
        component: "search-provider",
        eventCode: "SEARCH_EXECUTION_METADATA",
        subqueryRole: role,
        engine: execution.provider.name,
        success: execution.success,
        resultCount: execution.results.length,
        latencyMs: execution.latencyMs,
        finalTopKContributionCount: contributionCount(
          execution.results,
          finalResults,
        ),
        finalResultCount,
        finalDistinctDomainCount,
      },
      "Search execution metadata",
    );
  }
}

export function hasSufficientPrimaryCoverage(results: SearchResult[]): boolean {
  return (
    results.length >= PRIMARY_MIN_RESULTS &&
    distinctDomainCount(results) >= PRIMARY_MIN_DOMAINS
  );
}

/**
 * Backward-compatible merge entry point. Internally this uses weighted RRF so
 * agreement across providers is a positive ranking signal while a soft domain
 * cap still protects diversity.
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

function verticalMatchesQuery(
  provider: ApiSearchProvider,
  query: string,
): boolean {
  if (provider.kind !== "vertical") return true;
  if (!provider.queryAffinity) return false;
  try {
    return provider.queryAffinity(query) >= MIN_VERTICAL_QUERY_AFFINITY;
  } catch {
    return false;
  }
}

async function runProvider(
  provider: ApiSearchProvider,
  query: string,
  signal?: AbortSignal,
): Promise<ProviderExecution> {
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
    return { provider, results: [], success: false, latencyMs: 0 };
  }
  const startedAt = Date.now();
  try {
    const results = await provider.search(query, signal);
    const latencyMs = Math.max(0, Date.now() - startedAt);
    recordSearchProviderSuccess(provider.name);
    recordSearchEngineObservation(provider.name, {
      ok: results.length > 0,
      latencyMs,
    });
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
    return {
      provider,
      results,
      success: results.length > 0,
      latencyMs,
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    const latencyMs = Math.max(0, Date.now() - startedAt);
    recordSearchEngineObservation(provider.name, {
      ok: false,
      latencyMs,
    });
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
    return { provider, results: [], success: false, latencyMs };
  }
}

async function runProviderWave(
  providers: ApiSearchProvider[],
  query: string,
  signal?: AbortSignal,
): Promise<ProviderExecution[]> {
  const pending: Promise<ProviderExecution>[] = [];
  for (const provider of providers) {
    if (signal?.aborted) {
      await Promise.allSettled(pending);
      throw signal.reason ?? new Error("Search cancelled");
    }
    pending.push(runProvider(provider, query, signal));
  }
  return Promise.all(pending);
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
 * Adaptive provider ensemble:
 * - providers in cooldown are skipped rather than repeatedly hammered;
 * - eligible engines are dynamically ordered using query affinity, recent
 *   success rate and EWMA latency;
 * - the initial wave remains configurable (SEARCH_INITIAL_FANOUT, 1..3);
 * - if coverage is insufficient, remaining healthy providers run in parallel;
 * - ranked lists are combined with weighted Reciprocal Rank Fusion.
 */
async function executeSearchWithProviders(
  query: string,
  providers: ApiSearchProvider[],
  signal?: AbortSignal,
): Promise<ProviderSearchRun> {
  if (providers.length === 0) return { results: [], executions: [] };
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Search cancelled");
  }

  const available = rankSearchEngines(
    query,
    providers.filter(
      (provider) =>
        isSearchProviderAvailable(provider.name) &&
        verticalMatchesQuery(provider, query),
    ),
  );
  if (available.length === 0) return { results: [], executions: [] };

  const initialCount = Math.min(configuredInitialFanout(), available.length);
  const initialProviders = available.slice(0, initialCount);
  const initialExecutions = await runProviderWave(
    initialProviders,
    query,
    signal,
  );
  const ranked: RankedProviderResults[] = initialExecutions.map((execution) =>
    rankedSet(execution.provider, execution.results),
  );
  const initialMerged = fuseSearchProviderResults(
    ranked,
    MAX_MERGED_API_RESULTS,
  );

  if (
    initialCount === available.length ||
    hasSufficientPrimaryCoverage(initialMerged)
  ) {
    return { results: initialMerged, executions: initialExecutions };
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Search cancelled");
  }

  const remainingProviders = available.slice(initialCount);
  const remainingExecutions = await runProviderWave(
    remainingProviders,
    query,
    signal,
  );
  remainingExecutions.forEach((execution) => {
    ranked.push(rankedSet(execution.provider, execution.results));
  });
  return {
    results: fuseSearchProviderResults(ranked, MAX_MERGED_API_RESULTS),
    executions: [...initialExecutions, ...remainingExecutions],
  };
}

export async function searchWithProviders(
  query: string,
  providers: ApiSearchProvider[],
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const run = await executeSearchWithProviders(query, providers, signal);
  logSearchExecutionMetadata(
    run.executions.map((execution) => ({
      role: "primary",
      execution,
    })),
    run.results,
  );
  return run.results;
}

/**
 * Execute the bounded query plan without multiplying routine search cost.
 * The sanitized primary query always runs first. Supplemental angles only run
 * when primary coverage is insufficient, and their already-fused result lists
 * are combined again with weighted RRF so cross-query agreement is rewarded.
 */
export async function searchWithPlannedProviders(
  query: string,
  providers: ApiSearchProvider[],
  signal?: AbortSignal,
  suppliedPlan?: SearchQueryPlan,
): Promise<SearchResult[]> {
  const plan = planSearchQueries(query, {
    suggestedQueries: suppliedPlan?.queries
      .slice(1)
      .filter((item) => item.role !== "primary")
      .map(({ query: suggestedQuery, role }) => ({
        query: suggestedQuery,
        role: role as Exclude<SearchSubqueryRole, "primary">,
      })),
  });
  const primary = plan.queries[0];
  if (!primary || providers.length === 0) return [];
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Search cancelled");
  }

  const primaryRun = await executeSearchWithProviders(
    primary.query,
    providers,
    signal,
  );
  if (
    plan.queries.length === 1 ||
    hasSufficientPrimaryCoverage(primaryRun.results)
  ) {
    logSearchExecutionMetadata(
      primaryRun.executions.map((execution) => ({
        role: primary.role,
        execution,
      })),
      primaryRun.results,
    );
    return primaryRun.results;
  }
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Search cancelled");
  }

  const supplemental = plan.queries.slice(1);
  const supplementalRuns = await Promise.all(
    supplemental.map((item) =>
      executeSearchWithProviders(item.query, providers, signal),
    ),
  );
  const rankedQueries: RankedProviderResults[] = [
    {
      providerName: `query:${primary.role}`,
      weight: primary.weight,
      results: primaryRun.results,
    },
    ...supplemental.map((item, index) => ({
      providerName: `query:${item.role}:${index}`,
      weight: item.weight,
      results: supplementalRuns[index]?.results ?? [],
    })),
  ];
  const finalResults = fuseSearchProviderResults(
    rankedQueries,
    MAX_MERGED_API_RESULTS,
  );
  logSearchExecutionMetadata(
    [
      ...primaryRun.executions.map((execution) => ({
        role: primary.role,
        execution,
      })),
      ...supplementalRuns.flatMap((run, index) =>
        run.executions.map((execution) => ({
          role: supplemental[index].role,
          execution,
        })),
      ),
    ],
    finalResults,
  );
  return finalResults;
}

export async function searchWithApiProviders(
  query: string,
  signal?: AbortSignal,
  suppliedPlan?: SearchQueryPlan,
): Promise<SearchResult[]> {
  const providers = [
    ...getConfiguredApiProviders(),
    ...getBuiltinVerticalProviders(),
  ];
  return searchWithPlannedProviders(query, providers, signal, suppliedPlan);
}
