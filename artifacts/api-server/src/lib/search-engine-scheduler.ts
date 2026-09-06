import { getSearchProviderHealth } from "./search-core";
import type { SearchSubqueryRole } from "./search-query-planner";
import type { ApiSearchProvider } from "./search-provider-types";

interface MutableRuntimeStats {
  samples: number;
  successes: number;
  failures: number;
  ewmaLatencyMs: number;
  rolePerformance: Map<SearchSubqueryRole, MutableRolePerformance>;
}

interface MutableRolePerformance {
  samples: number;
  contributionCount: number;
  opportunityCount: number;
  contributionQuality: number;
}

export interface SearchEngineRuntimeSnapshot {
  name: string;
  samples: number;
  successes: number;
  failures: number;
  successRate: number;
  ewmaLatencyMs: number;
}

export interface SearchEngineRoleRuntimeSnapshot {
  name: string;
  role: SearchSubqueryRole;
  samples: number;
  contributionCount: number;
  opportunityCount: number;
  contributionQuality: number;
  contributionRate: number;
  correction: number;
}

const runtimeByEngine = new Map<string, MutableRuntimeStats>();
const LATENCY_EWMA_ALPHA = 0.25;
const DEFAULT_LATENCY_SCORE = 0.6;
const GENERAL_DEFAULT_AFFINITY = 0.62;
const VERTICAL_DEFAULT_AFFINITY = 0.12;
export const ADAPTIVE_ROLE_MIN_SAMPLES = 6;
export const ADAPTIVE_ROLE_MAX_CORRECTION = 0.04;
export const ADAPTIVE_ROLE_COVERAGE_FLOOR = 5;
const ADAPTIVE_ROLE_EWMA_ALPHA = 0.25;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function statsFor(name: string): MutableRuntimeStats {
  let stats = runtimeByEngine.get(name);
  if (!stats) {
    stats = {
      samples: 0,
      successes: 0,
      failures: 0,
      ewmaLatencyMs: 0,
      rolePerformance: new Map(),
    };
    runtimeByEngine.set(name, stats);
  }
  return stats;
}

function rolePerformanceFor(
  name: string,
  role: SearchSubqueryRole,
): MutableRolePerformance {
  const stats = statsFor(name);
  let performance = stats.rolePerformance.get(role);
  if (!performance) {
    performance = {
      samples: 0,
      contributionCount: 0,
      opportunityCount: 0,
      contributionQuality: 0,
    };
    stats.rolePerformance.set(role, performance);
  }
  return performance;
}

export function recordSearchEngineObservation(
  name: string,
  observation: { ok: boolean; latencyMs: number },
): void {
  const stats = statsFor(name);
  const latencyMs = Math.max(0, observation.latencyMs);
  stats.samples += 1;
  if (observation.ok) stats.successes += 1;
  else stats.failures += 1;
  stats.ewmaLatencyMs =
    stats.samples === 1
      ? latencyMs
      : stats.ewmaLatencyMs * (1 - LATENCY_EWMA_ALPHA) +
        latencyMs * LATENCY_EWMA_ALPHA;
}

export function getSearchEngineRuntime(
  name: string,
): SearchEngineRuntimeSnapshot {
  const stats = statsFor(name);
  const successRate = (stats.successes + 2) / (stats.samples + 4);
  return {
    name,
    samples: stats.samples,
    successes: stats.successes,
    failures: stats.failures,
    successRate,
    ewmaLatencyMs: stats.ewmaLatencyMs,
  };
}

export function recordSearchEngineRoleContribution(
  name: string,
  role: SearchSubqueryRole,
  observation: {
    contributionCount: number;
    finalTopKSize: number;
    successful: boolean;
  },
): void {
  if (!observation.successful) return;
  const performance = rolePerformanceFor(name, role);
  const contributionQuality = clamp01(
    Math.max(0, observation.contributionCount) /
      Math.max(
        ADAPTIVE_ROLE_COVERAGE_FLOOR,
        Math.max(1, observation.finalTopKSize),
      ),
  );
  performance.samples += 1;
  performance.contributionCount += Math.max(
    0,
    Math.floor(observation.contributionCount),
  );
  performance.opportunityCount += Math.max(
    1,
    Math.floor(observation.finalTopKSize),
  );
  performance.contributionQuality =
    performance.samples === 1
      ? contributionQuality
      : performance.contributionQuality * (1 - ADAPTIVE_ROLE_EWMA_ALPHA) +
        contributionQuality * ADAPTIVE_ROLE_EWMA_ALPHA;
}

function roleContributionCorrection(
  name: string,
  role: SearchSubqueryRole,
): number {
  const performance = rolePerformanceFor(name, role);
  if (performance.samples < ADAPTIVE_ROLE_MIN_SAMPLES) return 0;
  return Math.min(
    ADAPTIVE_ROLE_MAX_CORRECTION,
    performance.contributionQuality * ADAPTIVE_ROLE_MAX_CORRECTION,
  );
}

export function getSearchEngineRoleRuntime(
  name: string,
  role: SearchSubqueryRole,
): SearchEngineRoleRuntimeSnapshot {
  const performance = rolePerformanceFor(name, role);
  return {
    name,
    role,
    samples: performance.samples,
    contributionCount: performance.contributionCount,
    opportunityCount: performance.opportunityCount,
    contributionQuality: performance.contributionQuality,
    contributionRate: performance.contributionQuality,
    correction:
      performance.samples >= ADAPTIVE_ROLE_MIN_SAMPLES
        ? Math.min(
            ADAPTIVE_ROLE_MAX_CORRECTION,
            performance.contributionQuality * ADAPTIVE_ROLE_MAX_CORRECTION,
          )
        : 0,
  };
}

function latencyScore(snapshot: SearchEngineRuntimeSnapshot): number {
  if (snapshot.samples === 0) return DEFAULT_LATENCY_SCORE;
  return 1 / (1 + snapshot.ewmaLatencyMs / 2_500);
}

function affinityFor(provider: ApiSearchProvider, query: string): number {
  if (provider.queryAffinity) {
    try {
      return clamp01(provider.queryAffinity(query));
    } catch {
      return provider.kind === "vertical"
        ? VERTICAL_DEFAULT_AFFINITY
        : GENERAL_DEFAULT_AFFINITY;
    }
  }
  return provider.kind === "vertical"
    ? VERTICAL_DEFAULT_AFFINITY
    : GENERAL_DEFAULT_AFFINITY;
}

function engineScore(
  provider: ApiSearchProvider,
  query: string,
  role: SearchSubqueryRole,
): number {
  const runtime = getSearchEngineRuntime(provider.name);
  const health = getSearchProviderHealth(provider.name);
  const affinity = affinityFor(provider, query);
  const reliability = runtime.successRate;
  const latency = latencyScore(runtime);
  const weight = Math.min(2, Math.max(0.5, provider.weight ?? 1));
  const weightScore = (weight - 0.5) / 1.5;
  const healthMultiplier = health.health === "degraded" ? 0.8 : 1;
  const baseScore =
    (affinity * 0.55 +
      reliability * 0.25 +
      latency * 0.15 +
      weightScore * 0.05) *
    healthMultiplier;
  return baseScore + roleContributionCorrection(provider.name, role);
}

/**
 * Stable dynamic ordering. The original provider order is the final tie-breaker
 * so cold-start behavior remains predictable while observations gradually
 * influence scheduling.
 */
export function rankSearchEngines(
  query: string,
  providers: ApiSearchProvider[],
  role: SearchSubqueryRole = "primary",
): ApiSearchProvider[] {
  return providers
    .map((provider, index) => ({
      provider,
      index,
      score: engineScore(provider, query, role),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.provider);
}

export function resetSearchEngineRuntimeForTests(): void {
  runtimeByEngine.clear();
}
