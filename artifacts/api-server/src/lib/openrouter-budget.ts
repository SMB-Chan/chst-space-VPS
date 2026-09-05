import { logger } from "./logger";
import { resolveOpenRouterApiKey } from "./openrouter-config";

/**
 * OpenRouter budget guard.
 *
 * The hard spending cap is the spend limit configured on the OpenRouter key
 * itself (the provider rejects requests once it is reached). This module
 * watches the key's spend through OpenRouter's key-state endpoint and hides
 * OpenRouter models slightly BEFORE the cap so users get a clean model list
 * instead of failed calls. No local database is involved: the key's usage
 * counter is authoritative.
 */

const OPENROUTER_KEY_STATE_URL = "https://openrouter.ai/api/v1/auth/key";
/** Refresh interval for a successfully fetched key state. */
const KEY_STATE_TTL_MS = 60_000;
/** Shorter retry interval after a failed state fetch. */
const KEY_STATE_ERROR_TTL_MS = 15_000;
/** Fraction of the key limit at which OpenRouter models are hidden. */
const BUDGET_WARN_FRACTION = 0.95;
/** Fallback budget (USD) when the key has no spend limit configured. */
export const DEFAULT_MONTHLY_BUDGET_USD = 5;
const KEY_STATE_TIMEOUT_MS = 5_000;

export interface OpenRouterKeyState {
  /** USD spent through the key (lifetime, per OpenRouter). */
  usage: number;
  /** USD spend limit configured on the key; null when unlimited. */
  limit: number | null;
}

interface CachedKeyState {
  state: OpenRouterKeyState | null;
  expiresAt: number;
}

let cached: CachedKeyState | null = null;

export function openRouterConfigured(): boolean {
  return Boolean(resolveOpenRouterApiKey());
}

export function resolveMonthlyBudgetUsd(
  raw: string | undefined = process.env.OPENROUTER_MONTHLY_BUDGET_USD,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MONTHLY_BUDGET_USD;
}

export async function getOpenRouterKeyState(
  signal?: AbortSignal,
): Promise<OpenRouterKeyState | null> {
  const key = resolveOpenRouterApiKey();
  if (!key) return null;
  if (cached && cached.expiresAt > Date.now()) return cached.state;
  const state = await fetchKeyState(key, signal);
  cached = {
    state,
    expiresAt: Date.now() + (state ? KEY_STATE_TTL_MS : KEY_STATE_ERROR_TTL_MS),
  };
  return state;
}

async function fetchKeyState(
  key: string,
  signal?: AbortSignal,
): Promise<OpenRouterKeyState | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KEY_STATE_TIMEOUT_MS);
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  try {
    const response = await fetch(OPENROUTER_KEY_STATE_URL, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn(
        { component: "openrouter-budget", errorCode: "KEY_STATE_REJECTED" },
        `OpenRouter key state returned ${response.status}`,
      );
      return null;
    }
    const payload = (await response.json()) as {
      data?: { usage?: unknown; limit?: unknown };
    };
    const usage = payload.data?.usage;
    if (typeof usage !== "number" || !Number.isFinite(usage)) return null;
    const limit = payload.data?.limit;
    return {
      usage,
      limit: typeof limit === "number" && Number.isFinite(limit) ? limit : null,
    };
  } catch (error) {
    if (signal?.aborted) return null;
    logger.warn(
      { component: "openrouter-budget", errorCode: "KEY_STATE_FAILED" },
      "OpenRouter key state fetch failed; budget state unknown",
    );
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortFromParent);
  }
}

/**
 * True when the key's spend has consumed (nearly) all of its allowance and
 * OpenRouter models should be hidden from the picker. Unknown state never
 * blocks — the provider-side hard cap remains the last line of defense.
 */
export async function isOpenRouterOverBudget(
  signal?: AbortSignal,
): Promise<boolean> {
  if (!openRouterConfigured()) return false;
  const state = await getOpenRouterKeyState(signal);
  if (!state) return false;
  if (state.limit != null) {
    return state.usage >= state.limit * BUDGET_WARN_FRACTION;
  }
  // Unlimited key: compare lifetime usage against the configured budget.
  // Proper monthly reset semantics require a spend-limited key.
  return state.usage >= resolveMonthlyBudgetUsd();
}

export function resetOpenRouterBudgetCache(): void {
  cached = null;
}
