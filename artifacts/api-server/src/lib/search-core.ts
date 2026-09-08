import {
  annotateSearchResultsWithEvidence,
  annotateSearchResultsWithProvider,
  mergeSearchEvidenceMetadata,
} from "./search-evidence-vector";
import type { SearchResult } from "./search-parse";
import type { SearchSubqueryRole } from "./search-query-planner";

export type SearchProviderFailureKind =
  "rate_limited" | "blocked" | "timeout" | "server_error" | "transient";

export type SearchProviderHealth = "healthy" | "degraded" | "cooldown";

export interface SearchProviderHealthSnapshot {
  name: string;
  health: SearchProviderHealth;
  consecutiveFailures: number;
  suspendedUntil: number;
  lastFailureKind?: SearchProviderFailureKind;
}

interface MutableProviderHealth {
  consecutiveFailures: number;
  suspendedUntil: number;
  lastFailureKind?: SearchProviderFailureKind;
}

export interface RankedProviderResults {
  providerName: string;
  weight?: number;
  results: SearchResult[];
}

const healthByProvider = new Map<string, MutableProviderHealth>();

const RATE_LIMIT_COOLDOWN_MS = 60_000;
const BLOCKED_COOLDOWN_MS = 10 * 60_000;
const TIMEOUT_COOLDOWN_MS = 30_000;
const SERVER_ERROR_COOLDOWN_MS = 15_000;
const TRANSIENT_COOLDOWN_MS = 10_000;
const GENERIC_FAILURES_BEFORE_COOLDOWN = 2;
const RRF_K = 60;
const DOMAIN_SOFT_CAP = 2;
const SEARCH_SUBQUERY_ROLES = new Set<SearchSubqueryRole>([
  "primary",
  "official",
  "freshness",
  "counterevidence",
  "comparison",
  "research",
  "technical",
  "cross_language",
]);

function stateFor(name: string): MutableProviderHealth {
  let state = healthByProvider.get(name);
  if (!state) {
    state = { consecutiveFailures: 0, suspendedUntil: 0 };
    healthByProvider.set(name, state);
  }
  return state;
}

function numericStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function retryAfterMs(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function errorText(error: unknown): string {
  if (error instanceof Error)
    return `${error.name} ${error.message}`.toLowerCase();
  return String(error ?? "").toLowerCase();
}

export function classifySearchProviderFailure(
  error: unknown,
): SearchProviderFailureKind {
  const status = numericStatus(error);
  const text = errorText(error);
  if (status === 429 || /rate.?limit|too many requests/.test(text)) {
    return "rate_limited";
  }
  if (
    status === 401 ||
    status === 403 ||
    /captcha|access denied|bot challenge|forbidden|blocked/.test(text)
  ) {
    return "blocked";
  }
  if (/timeout|timed out|aborterror|timeouterror/.test(text)) {
    return "timeout";
  }
  if ((status !== null && status >= 500) || /\b5\d\d\b/.test(text)) {
    return "server_error";
  }
  return "transient";
}

export function isSearchProviderAvailable(
  name: string,
  now = Date.now(),
): boolean {
  const state = healthByProvider.get(name);
  return !state || state.suspendedUntil <= now;
}

/**
 * Mark a provider healthy after a successful request. An already-active
 * cooldown is deliberately not cleared by a late success from an older
 * concurrent request; it expires naturally and a later success resets state.
 */
export function recordSearchProviderSuccess(
  name: string,
  now = Date.now(),
): void {
  const state = stateFor(name);
  if (state.suspendedUntil > now) return;
  state.consecutiveFailures = 0;
  state.suspendedUntil = 0;
  state.lastFailureKind = undefined;
}

export function recordSearchProviderFailure(
  name: string,
  error: unknown,
  now = Date.now(),
): SearchProviderHealthSnapshot {
  const state = stateFor(name);
  const kind = classifySearchProviderFailure(error);
  state.consecutiveFailures += 1;
  state.lastFailureKind = kind;

  let cooldownMs = 0;
  if (kind === "rate_limited") {
    cooldownMs = Math.max(retryAfterMs(error) ?? 0, RATE_LIMIT_COOLDOWN_MS);
  } else if (kind === "blocked") {
    cooldownMs = BLOCKED_COOLDOWN_MS;
  } else if (kind === "timeout") {
    cooldownMs = TIMEOUT_COOLDOWN_MS;
  } else if (kind === "server_error") {
    cooldownMs = SERVER_ERROR_COOLDOWN_MS;
  } else if (state.consecutiveFailures >= GENERIC_FAILURES_BEFORE_COOLDOWN) {
    cooldownMs = TRANSIENT_COOLDOWN_MS;
  }

  if (cooldownMs > 0) {
    state.suspendedUntil = Math.max(state.suspendedUntil, now + cooldownMs);
  }
  return getSearchProviderHealth(name, now);
}

export function getSearchProviderHealth(
  name: string,
  now = Date.now(),
): SearchProviderHealthSnapshot {
  const state = stateFor(name);
  const health: SearchProviderHealth =
    state.suspendedUntil > now
      ? "cooldown"
      : state.consecutiveFailures > 0
        ? "degraded"
        : "healthy";
  return {
    name,
    health,
    consecutiveFailures: state.consecutiveFailures,
    suspendedUntil: state.suspendedUntil,
    lastFailureKind: state.lastFailureKind,
  };
}

export function resetSearchProviderHealthForTests(): void {
  healthByProvider.clear();
}

function domainOf(result: SearchResult): string {
  try {
    return new URL(result.url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function queryRoleFromRankedSetName(
  providerName: string,
): SearchSubqueryRole | undefined {
  if (!providerName.startsWith("query:")) return undefined;
  const role = providerName.slice("query:".length).split(":", 1)[0];
  return SEARCH_SUBQUERY_ROLES.has(role as SearchSubqueryRole)
    ? (role as SearchSubqueryRole)
    : undefined;
}

function resultsWithFusionProvenance(
  set: RankedProviderResults,
): SearchResult[] {
  const queryRole = queryRoleFromRankedSetName(set.providerName);
  return queryRole
    ? annotateSearchResultsWithEvidence(set.results, { role: queryRole })
    : annotateSearchResultsWithProvider(set.results, set.providerName);
}

interface FusedCandidate {
  result: SearchResult;
  score: number;
  bestRank: number;
  firstSeen: number;
}

/**
 * Independent weighted Reciprocal Rank Fusion for provider-ranked search lists.
 * A URL confirmed by more than one provider naturally rises without requiring
 * provider-specific score scales. Provider weights are optional and bounded.
 * Provider and query-lane provenance are accumulated while duplicate URLs fuse
 * so later evidence-gap decisions can reuse already-collected work.
 */
export function fuseSearchProviderResults(
  sets: RankedProviderResults[],
  maxResults: number,
): SearchResult[] {
  if (maxResults <= 0) return [];
  const candidates = new Map<string, FusedCandidate>();
  let seenOrder = 0;

  for (const set of sets) {
    const rawWeight = set.weight ?? 1;
    const weight = Math.min(4, Math.max(0.1, rawWeight));
    const seenInProvider = new Set<string>();
    resultsWithFusionProvenance(set).forEach((result, index) => {
      if (seenInProvider.has(result.url)) return;
      seenInProvider.add(result.url);
      const rank = index + 1;
      const contribution = weight / (RRF_K + rank);
      const existing = candidates.get(result.url);
      if (!existing) {
        candidates.set(result.url, {
          result,
          score: contribution,
          bestRank: rank,
          firstSeen: seenOrder++,
        });
        return;
      }
      existing.score += contribution;
      existing.bestRank = Math.min(existing.bestRank, rank);
      if (result.snippet.length > existing.result.snippet.length) {
        existing.result = { ...existing.result, snippet: result.snippet };
      }
      if (
        existing.result.title === existing.result.url &&
        result.title !== result.url
      ) {
        existing.result = { ...existing.result, title: result.title };
      }
      const evidence = mergeSearchEvidenceMetadata(
        existing.result.evidence,
        result.evidence,
      );
      if (evidence) existing.result = { ...existing.result, evidence };
    });
  }

  const ranked = [...candidates.values()].sort(
    (a, b) =>
      b.score - a.score || a.bestRank - b.bestRank || a.firstSeen - b.firstSeen,
  );

  const selected: SearchResult[] = [];
  const deferred: SearchResult[] = [];
  const perDomain = new Map<string, number>();
  for (const candidate of ranked) {
    const domain = domainOf(candidate.result);
    if (domain && (perDomain.get(domain) ?? 0) >= DOMAIN_SOFT_CAP) {
      deferred.push(candidate.result);
      continue;
    }
    selected.push(candidate.result);
    if (domain) perDomain.set(domain, (perDomain.get(domain) ?? 0) + 1);
    if (selected.length >= maxResults) return selected;
  }
  for (const result of deferred) {
    if (selected.length >= maxResults) break;
    selected.push(result);
  }
  return selected;
}
