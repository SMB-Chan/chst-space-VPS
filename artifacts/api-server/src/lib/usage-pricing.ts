/**
 * Pure usage-accounting primitives (no database imports) so streaming code
 * can estimate tokens hermetically; the DB-backed tracker re-exports these.
 */

export interface UsageEntry {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}

/** Per-1M-token USD prices, verified against the OpenRouter catalog 2026-09. */
const MODEL_PRICING_USD_PER_1M: Record<
  string,
  { input: number; output: number }
> = {
  "qwen/qwen3.7-flash": { input: 0.03, output: 0.13 },
  "z-ai/glm-5.3-flash": { input: 0.07, output: 0.25 },
  "tencent/hy3": { input: 0.0825, output: 0.33 },
  "qwen/qwen3.8-flash": { input: 0.15, output: 0.47 },
  "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "deepseek/deepseek-chat": { input: 0.32, output: 0.89 },
  "qwen/qwen3-235b-a22b-thinking-2507": { input: 0.23, output: 2.3 },
};
/** Conservative default for models without a recorded price. */
const FALLBACK_PRICING_USD_PER_1M = { input: 0.3, output: 1.0 };

/** Default monthly budget (USD) for a general user without an override. */
export const DEFAULT_USER_MONTHLY_BUDGET_USD = 2;

export function usageMonthKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function estimateCostUsd(
  modelId: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing =
    MODEL_PRICING_USD_PER_1M[modelId] ?? FALLBACK_PRICING_USD_PER_1M;
  return (
    (promptTokens / 1_000_000) * pricing.input +
    (completionTokens / 1_000_000) * pricing.output
  );
}

/**
 * Rough token estimate when a provider does not report usage (≈3 chars per
 * token blends CJK-heavy Japanese and Latin text acceptably for budgeting).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export function resolveDefaultUserBudgetUsd(
  raw: string | undefined = process.env.USER_MONTHLY_BUDGET_USD,
): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_USER_MONTHLY_BUDGET_USD;
}
