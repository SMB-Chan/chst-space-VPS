import { logger } from "./logger";

const TOKEN_PLAN_USAGE_API = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const TOKEN_PLAN_USAGE_ENDPOINT =
  "https://bailian-singapore-cs.alibabacloud.com/cli/api.json" +
  `?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(TOKEN_PLAN_USAGE_API)}`;
const TOKEN_PLAN_REGION = "ap-southeast-1";
export const TOKEN_PLAN_DASHSCOPE_BASE_URL =
  "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
export const MODEL_STUDIO_DASHSCOPE_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
const TOKEN_PLAN_DASHSCOPE_HOST = "token-plan.ap-southeast-1.maas.aliyuncs.com";
const MODEL_STUDIO_DASHSCOPE_HOSTS = new Set([
  "dashscope-intl.aliyuncs.com",
  "dashscope.aliyuncs.com",
]);
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_CACHE_MS = 30_000;
const DEFAULT_WARN_REMAINING_PERCENT = 25;
const DEFAULT_BLOCK_HEAVY_REMAINING_PERCENT = 10;

export type AlibabaTokenPlanQuotaDecision = "allow" | "warn" | "block" | "unknown";
export type AlibabaDashScopeKeyKind = "token-plan" | "model-studio" | "unknown";

export interface AlibabaTokenPlanUsageSnapshot {
  checkedAt: string;
  weeklyUsedPercent?: number;
  weeklyRemainingPercent?: number;
  weeklyResetAt?: string;
  fiveHourUsedPercent?: number;
  fiveHourRemainingPercent?: number;
  fiveHourResetAt?: string;
}

export interface AlibabaTokenPlanQuotaAssessment {
  decision: AlibabaTokenPlanQuotaDecision;
  heavy: boolean;
  limitingWindow?: "5-hour" | "1-week";
  remainingPercent?: number;
  resetAt?: string;
  reason: string;
}

interface RawTokenPlanUsage {
  per5HourPercentage?: unknown;
  per5HourResetTime?: unknown;
  per1WeekPercentage?: unknown;
  per1WeekResetTime?: unknown;
}

let cachedUsage:
  | { expiresAt: number; snapshot: AlibabaTokenPlanUsageSnapshot }
  | null = null;

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  return !["0", "false", "off", "no"].includes(raw.trim().toLowerCase());
}

function parsePercent(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Alibaba currently returns quota percentages as fractions (0..1). Accept 0..100 defensively. */
function usedPercent(value: unknown): number | undefined {
  const numeric = finiteNumber(value);
  if (numeric === undefined || numeric < 0) return undefined;
  if (numeric <= 1) return Math.min(100, Math.max(0, numeric * 100));
  if (numeric <= 100) return numeric;
  return undefined;
}

function resetIso(value: unknown): string | undefined {
  const numeric = finiteNumber(value);
  if (numeric === undefined || numeric <= 0) return undefined;
  const date = new Date(numeric);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function findUsageObject(value: unknown, depth = 0): RawTokenPlanUsage | undefined {
  if (depth > 8 || !value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    "per1WeekPercentage" in record ||
    "per1WeekResetTime" in record ||
    "per5HourPercentage" in record ||
    "per5HourResetTime" in record
  ) {
    return record;
  }
  for (const child of Object.values(record)) {
    const found = findUsageObject(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function responseLooksLoggedOut(value: unknown): boolean {
  try {
    const text = JSON.stringify(value);
    return /NotLogined|not logged in|session.*expired/i.test(text);
  } catch {
    return false;
  }
}

function buildGatewayBody(): string {
  const params = JSON.stringify({
    Api: TOKEN_PLAN_USAGE_API,
    V: "1.0",
    Data: {
      cornerstoneParam: {
        protocol: "V2",
        console: "ONE_CONSOLE",
        productCode: "p_efm",
        switchUserType: 3,
        consoleSite: "BAILIAN_ALIYUN",
      },
    },
  });
  return new URLSearchParams({ params, region: TOKEN_PLAN_REGION }).toString();
}

export function isAlibabaTokenPlanQuotaGuardEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBoolean(env.ALIBABA_TOKEN_PLAN_QUOTA_GUARD, true);
}

export function isAlibabaTokenPlanQuotaFailOpen(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseBoolean(env.ALIBABA_TOKEN_PLAN_QUOTA_FAIL_OPEN, false);
}

export function classifyAlibabaDashScopeKey(
  apiKey: string | undefined,
): AlibabaDashScopeKeyKind {
  const normalized = apiKey?.trim() ?? "";
  if (/^sk-sp-/i.test(normalized)) return "token-plan";
  if (/^sk-/i.test(normalized)) return "model-studio";
  return "unknown";
}

export function isAlibabaTokenPlanChatKey(apiKey: string | undefined): boolean {
  return classifyAlibabaDashScopeKey(apiKey) === "token-plan";
}

function normalizeDashScopeUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("DashScope endpoint must use HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("DashScope endpoint must not contain credentials, query, or fragment");
  }
  return url.toString().replace(/\/+$/, "");
}

/**
 * Token Plan and regular Model Studio credentials use different endpoints.
 * Keep the default safe for each credential class and reject known crossings.
 */
export function resolveAlibabaDashScopeBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const keyKind = classifyAlibabaDashScopeKey(env.DASHSCOPE_API_KEY);
  if (keyKind === "unknown") {
    throw new Error("DASHSCOPE_API_KEY has an unsupported key format");
  }

  const configured = env.DASHSCOPE_BASE_URL?.trim();
  const fallback =
    keyKind === "token-plan"
      ? TOKEN_PLAN_DASHSCOPE_BASE_URL
      : MODEL_STUDIO_DASHSCOPE_BASE_URL;
  const normalized = normalizeDashScopeUrl(configured || fallback);
  const host = new URL(normalized).hostname.toLowerCase();

  if (keyKind === "token-plan" && MODEL_STUDIO_DASHSCOPE_HOSTS.has(host)) {
    throw new Error("Token Plan key cannot use a general Model Studio endpoint");
  }
  if (keyKind === "model-studio" && host === TOKEN_PLAN_DASHSCOPE_HOST) {
    throw new Error("General Model Studio key cannot use a Token Plan endpoint");
  }
  return normalized;
}

export async function fetchAlibabaTokenPlanUsage(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<AlibabaTokenPlanUsageSnapshot | null> {
  if (!isAlibabaTokenPlanQuotaGuardEnabled(env)) return null;
  const accessToken = env.ALIBABA_CONSOLE_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;

  const timeoutMs = parsePositiveInt(env.ALIBABA_TOKEN_PLAN_QUOTA_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("Alibaba Token Plan quota check timed out")),
    timeoutMs,
  );
  try {
    const response = await fetchImpl(TOKEN_PLAN_USAGE_ENDPOINT, {
      method: "POST",
      headers: {
        Accept: "*/*",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: buildGatewayBody(),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Alibaba Token Plan quota endpoint returned HTTP ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (responseLooksLoggedOut(payload)) {
      throw new Error("Alibaba console access token is expired or not logged in");
    }
    const usage = findUsageObject(payload);
    if (!usage) throw new Error("Alibaba Token Plan quota response did not contain usage data");

    const weeklyUsedPercent = usedPercent(usage.per1WeekPercentage);
    const fiveHourUsedPercent = usedPercent(usage.per5HourPercentage);
    const snapshot: AlibabaTokenPlanUsageSnapshot = {
      checkedAt: new Date().toISOString(),
      ...(weeklyUsedPercent !== undefined
        ? {
            weeklyUsedPercent,
            weeklyRemainingPercent: Math.max(0, 100 - weeklyUsedPercent),
          }
        : {}),
      ...(resetIso(usage.per1WeekResetTime)
        ? { weeklyResetAt: resetIso(usage.per1WeekResetTime) }
        : {}),
      ...(fiveHourUsedPercent !== undefined
        ? {
            fiveHourUsedPercent,
            fiveHourRemainingPercent: Math.max(0, 100 - fiveHourUsedPercent),
          }
        : {}),
      ...(resetIso(usage.per5HourResetTime)
        ? { fiveHourResetAt: resetIso(usage.per5HourResetTime) }
        : {}),
    };
    if (
      snapshot.weeklyRemainingPercent === undefined ||
      snapshot.fiveHourRemainingPercent === undefined
    ) {
      throw new Error("Alibaba Token Plan quota response did not contain both quota windows");
    }
    return snapshot;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getAlibabaTokenPlanUsage(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<AlibabaTokenPlanUsageSnapshot | null> {
  const now = Date.now();
  if (fetchImpl === fetch && cachedUsage && cachedUsage.expiresAt > now) {
    return cachedUsage.snapshot;
  }
  try {
    const snapshot = await fetchAlibabaTokenPlanUsage(env, fetchImpl);
    if (snapshot && fetchImpl === fetch) {
      const cacheMs = parsePositiveInt(env.ALIBABA_TOKEN_PLAN_QUOTA_CACHE_MS, DEFAULT_CACHE_MS);
      cachedUsage = { snapshot, expiresAt: now + cacheMs };
    }
    return snapshot;
  } catch {
    cachedUsage = null;
    logger.warn(
      "Alibaba Token Plan quota telemetry unavailable; continuing without authoritative quota data",
    );
    return null;
  }
}

export function assessAlibabaTokenPlanQuota(
  snapshot: AlibabaTokenPlanUsageSnapshot | null,
  heavy: boolean,
  env: NodeJS.ProcessEnv = process.env,
): AlibabaTokenPlanQuotaAssessment {
  if (!snapshot) {
    return {
      decision: "unknown",
      heavy,
      reason: "Token Plan quota telemetry is not configured or unavailable",
    };
  }

  if (
    snapshot.weeklyRemainingPercent === undefined ||
    snapshot.fiveHourRemainingPercent === undefined
  ) {
    return {
      decision: "unknown",
      heavy,
      reason: "Token Plan quota telemetry is incomplete",
    };
  }

  const windows = [
    {
      window: "5-hour" as const,
      remaining: snapshot.fiveHourRemainingPercent,
      resetAt: snapshot.fiveHourResetAt,
    },
    {
      window: "1-week" as const,
      remaining: snapshot.weeklyRemainingPercent,
      resetAt: snapshot.weeklyResetAt,
    },
  ];

  const limiting = windows.reduce((lowest, item) =>
    item.remaining < lowest.remaining ? item : lowest,
  );
  const warnAt = parsePercent(
    env.ALIBABA_TOKEN_PLAN_WARN_REMAINING_PERCENT,
    DEFAULT_WARN_REMAINING_PERCENT,
  );
  const blockHeavyAt = Math.min(
    warnAt,
    parsePercent(
      env.ALIBABA_TOKEN_PLAN_BLOCK_HEAVY_REMAINING_PERCENT,
      DEFAULT_BLOCK_HEAVY_REMAINING_PERCENT,
    ),
  );

  if (heavy && limiting.remaining <= blockHeavyAt) {
    return {
      decision: "block",
      heavy,
      limitingWindow: limiting.window,
      remainingPercent: limiting.remaining,
      resetAt: limiting.resetAt,
      reason: `Only ${limiting.remaining.toFixed(1)}% remains in the ${limiting.window} Token Plan quota`,
    };
  }
  if (limiting.remaining <= warnAt) {
    return {
      decision: "warn",
      heavy,
      limitingWindow: limiting.window,
      remainingPercent: limiting.remaining,
      resetAt: limiting.resetAt,
      reason: `${limiting.remaining.toFixed(1)}% remains in the ${limiting.window} Token Plan quota`,
    };
  }
  return {
    decision: "allow",
    heavy,
    limitingWindow: limiting.window,
    remainingPercent: limiting.remaining,
    resetAt: limiting.resetAt,
    reason: `${limiting.remaining.toFixed(1)}% remains in the ${limiting.window} Token Plan quota`,
  };
}

function countMessageCost(value: unknown): { textChars: number; images: number } {
  if (typeof value === "string") return { textChars: value.length, images: 0 };
  if (!Array.isArray(value)) return { textChars: 0, images: 0 };
  let textChars = 0;
  let images = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") textChars += record.text.length;
    if (record.type === "image_url") images += 1;
  }
  return { textChars, images };
}

export function isHeavyAlibabaChatRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const request = body as Record<string, unknown>;
  const messages = Array.isArray(request.messages) ? request.messages : [];
  let textChars = 0;
  let images = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const cost = countMessageCost((message as Record<string, unknown>).content);
    textChars += cost.textChars;
    images += cost.images;
  }

  const extra =
    request.extra_body && typeof request.extra_body === "object"
      ? (request.extra_body as Record<string, unknown>)
      : undefined;
  const reasoningEffort =
    typeof extra?.reasoning_effort === "string" ? extra.reasoning_effort.toLowerCase() : "";
  const thinkingBudget = finiteNumber(extra?.thinking_budget) ?? 0;
  const highReasoning = reasoningEffort === "high" || reasoningEffort === "xhigh" || thinkingBudget >= 8_192;
  const model = typeof request.model === "string" ? request.model.toLowerCase() : "";
  const flagship = /(?:qwen3\.8-max|qwen3\.7-max|deepseek-v4-pro)/.test(model);

  return (
    textChars >= 30_000 ||
    images >= 2 ||
    (highReasoning && textChars >= 8_000) ||
    (flagship && textChars >= 16_000)
  );
}

export class AlibabaTokenPlanQuotaGuardError extends Error {
  readonly remainingPercent?: number;
  readonly resetAt?: string;

  constructor(assessment: AlibabaTokenPlanQuotaAssessment) {
    const reset = assessment.resetAt ? ` Reset: ${assessment.resetAt}.` : "";
    super(`Alibaba Token Plan quota guard blocked a high-cost request: ${assessment.reason}.${reset}`);
    this.name = "AlibabaTokenPlanQuotaGuardError";
    this.remainingPercent = assessment.remainingPercent;
    this.resetAt = assessment.resetAt;
  }
}

/**
 * Wrap the DashScope transport with a provider-authoritative quota preflight.
 * The quota endpoint is queried only for Token Plan keys and cached briefly.
 * Normal-sized requests are never blocked; only requests classified as heavy
 * are stopped when the limiting active window is below the configured floor.
 */
export function createAlibabaTokenPlanQuotaGuardedFetch(
  innerFetch: typeof fetch,
  env: NodeJS.ProcessEnv = process.env,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      !isAlibabaTokenPlanQuotaGuardEnabled(env) ||
      !isAlibabaTokenPlanChatKey(env.DASHSCOPE_API_KEY)
    ) {
      return innerFetch(input, init);
    }

    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    const isChatCompletion = /\/chat\/completions(?:\?|$)/.test(url);
    if (!isChatCompletion || typeof init?.body !== "string") return innerFetch(input, init);

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(init.body);
    } catch {
      return innerFetch(input, init);
    }

    const heavy = isHeavyAlibabaChatRequest(parsedBody);
    const snapshot = await getAlibabaTokenPlanUsage(env);
    const assessment = assessAlibabaTokenPlanQuota(snapshot, heavy, env);
    if (assessment.decision === "block") {
      logger.warn(
        {
          remainingPercent: assessment.remainingPercent,
          resetAt: assessment.resetAt,
          limitingWindow: assessment.limitingWindow,
        },
        "Alibaba Token Plan quota guard blocked a heavy chat request",
      );
      throw new AlibabaTokenPlanQuotaGuardError(assessment);
    }
    if (assessment.decision === "warn") {
      logger.warn(
        {
          heavy,
          remainingPercent: assessment.remainingPercent,
          resetAt: assessment.resetAt,
          limitingWindow: assessment.limitingWindow,
        },
        "Alibaba Token Plan quota headroom is low",
      );
    } else if (
      assessment.decision === "unknown" &&
      heavy &&
      !isAlibabaTokenPlanQuotaFailOpen(env)
    ) {
      logger.warn(
        "Heavy Alibaba chat request blocked because Token Plan quota telemetry is unavailable",
      );
      throw new AlibabaTokenPlanQuotaGuardError(assessment);
    } else if (assessment.decision === "unknown" && heavy) {
      logger.warn(
        "Heavy Alibaba chat request is proceeding under the explicit Token Plan quota fail-open override",
      );
    }

    return innerFetch(input, init);
  }) as typeof fetch;
}