import { getSearchProviderHealth } from "./search-core";
import type { ApiSearchProvider } from "./search-provider-types";

interface MutableRuntimeStats {
  samples: number;
  successes: number;
  failures: number;
  ewmaLatencyMs: number;
}

export interface SearchEngineRuntimeSnapshot {
  name: string;
  samples: number;
  successes: number;
  failures: number;
  successRate: number;
  ewmaLatencyMs: number;
}

const runtimeByEngine = new Map<string, MutableRuntimeStats>();
const LATENCY_EWMA_ALPHA = 0.25;
const DEFAULT_LATENCY_SCORE = 0.6;
const GENERAL_DEFAULT_AFFINITY = 0.62;
const VERTICAL_DEFAULT_AFFINITY = 0.12;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function statsFor(name: string): MutableRuntimeStats {
  let stats = runtimeByEngine.get(name);
  if (!stats) {
    stats = { samples: 0, successes: 0, failures: 0, ewmaLatencyMs: 0 };
    runtimeByEngine.set(name, stats);
  }
  return stats;
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

function engineScore(provider: ApiSearchProvider, query: string): number {
  const runtime = getSearchEngineRuntime(provider.name);
  const health = getSearchProviderHealth(provider.name);
  const affinity = affinityFor(provider, query);
  const reliability = runtime.successRate;
  const latency = latencyScore(runtime);
  const weight = Math.min(2, Math.max(0.5, provider.weight ?? 1));
  const weightScore = (weight - 0.5) / 1.5;
  const healthMultiplier = health.health === "degraded" ? 0.8 : 1;
  return (
    (affinity * 0.55 +
      reliability * 0.25 +
      latency * 0.15 +
      weightScore * 0.05) *
    healthMultiplier
  );
}

/**
 * Stable dynamic ordering. The original provider order is the final tie-breaker
 * so cold-start behavior remains predictable while observations gradually
 * influence scheduling.
 */
export function rankSearchEngines(
  query: string,
  providers: ApiSearchProvider[],
): ApiSearchProvider[] {
  return providers
    .map((provider, index) => ({
      provider,
      index,
      score: engineScore(provider, query),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.provider);
}

export function resetSearchEngineRuntimeForTests(): void {
  runtimeByEngine.clear();
}
