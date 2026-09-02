export type AiFailureKind =
  | "timeout"
  | "dns"
  | "connection-reset"
  | "connection-refused"
  | "connection"
  | "upstream-5xx"
  | "upstream-retryable"
  | "rate-limit"
  | "authentication"
  | "invalid-request"
  | "cancelled"
  | "unknown";

export interface SafeAiFailureFields {
  failureKind: AiFailureKind;
  upstreamStatus?: number;
  transportCode?: string;
  upstreamRequestId?: string;
}

export interface AiStreamRetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 750;
const DEFAULT_MAX_DELAY_MS = 6_000;
const MAX_PROVIDER_RETRY_AFTER_MS = 10_000;

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && chain.length < 6) {
    chain.push(current);
    seen.add(current);
    current =
      typeof current === "object" && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return chain;
}

function errorMessage(value: unknown): string {
  return value instanceof Error
    ? value.message
    : value && typeof value === "object" && "message" in value
      ? String((value as { message?: unknown }).message ?? "")
      : "";
}

function errorName(value: unknown): string {
  return value instanceof Error
    ? value.name
    : value && typeof value === "object" && "name" in value
      ? String((value as { name?: unknown }).name ?? "")
      : "";
}

function errorStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const typed = value as { status?: unknown; statusCode?: unknown };
  const candidate =
    typeof typed.status === "number" ? typed.status : typed.statusCode;
  return typeof candidate === "number" &&
    Number.isInteger(candidate) &&
    candidate >= 100 &&
    candidate <= 599
    ? candidate
    : undefined;
}

function errorCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as { code?: unknown }).code;
  if (typeof candidate !== "string") return undefined;
  const normalized = candidate.trim().toUpperCase();
  return /^[A-Z0-9_]{2,64}$/.test(normalized) ? normalized : undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const getter = (headers as { get?: unknown }).get;
  if (typeof getter === "function") {
    const value = getter.call(headers, name);
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  const record = headers as Record<string, unknown>;
  const value =
    record[name] ?? record[name.toLowerCase()] ?? record[name.toUpperCase()];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value) && typeof value[0] === "string") {
    return value[0].trim() || undefined;
  }
  return undefined;
}

function errorHeader(value: unknown, name: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const typed = value as {
    headers?: unknown;
    response?: { headers?: unknown };
  };
  return (
    readHeader(typed.headers, name) ?? readHeader(typed.response?.headers, name)
  );
}

function safeRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : undefined;
}

function upstreamRequestId(chain: unknown[]): string | undefined {
  for (const value of chain) {
    if (!value || typeof value !== "object") continue;
    const typed = value as {
      request_id?: unknown;
      requestId?: unknown;
    };
    const candidate =
      safeRequestId(typed.request_id) ??
      safeRequestId(typed.requestId) ??
      safeRequestId(errorHeader(value, "x-request-id"));
    if (candidate) return candidate;
  }
  return undefined;
}

export function safeAiFailureFields(error: unknown): SafeAiFailureFields {
  const chain = errorChain(error);
  const status = chain.map(errorStatus).find((value) => value !== undefined);
  const code = chain.map(errorCode).find((value) => value !== undefined);
  const requestId = upstreamRequestId(chain);
  const names = chain.map(errorName).join(" ");
  const messages = chain.map(errorMessage).join(" ");

  let failureKind: AiFailureKind = "unknown";
  if (
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    /timeout|timed out/i.test(`${names} ${messages}`)
  ) {
    failureKind = "timeout";
  } else if (code === "EAI_AGAIN" || code === "ENOTFOUND") {
    failureKind = "dns";
  } else if (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "UND_ERR_SOCKET" ||
    /connection reset|socket hang up|other side closed/i.test(messages)
  ) {
    failureKind = "connection-reset";
  } else if (
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  ) {
    failureKind = "connection-refused";
  } else if (status !== undefined && status >= 500) {
    failureKind = "upstream-5xx";
  } else if (status === 408 || status === 409 || status === 425) {
    failureKind = "upstream-retryable";
  } else if (status === 429) {
    failureKind = "rate-limit";
  } else if (status === 401 || status === 403) {
    failureKind = "authentication";
  } else if (status === 400 || status === 422) {
    failureKind = "invalid-request";
  } else if (
    /APIUserAbortError|AbortError/i.test(names) ||
    /operation cancelled|request was aborted/i.test(messages)
  ) {
    failureKind = "cancelled";
  } else if (
    /APIConnectionError/i.test(names) ||
    /connection error|fetch failed|network error/i.test(messages)
  ) {
    failureKind = "connection";
  }

  return {
    failureKind,
    ...(status === undefined ? {} : { upstreamStatus: status }),
    ...(code ? { transportCode: code } : {}),
    ...(requestId ? { upstreamRequestId: requestId } : {}),
  };
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export function getAiStreamRetryConfig(
  env: NodeJS.ProcessEnv = process.env,
): AiStreamRetryConfig {
  const maxAttempts = boundedInteger(
    env.AI_STREAM_MAX_ATTEMPTS,
    DEFAULT_MAX_ATTEMPTS,
    1,
    5,
  );
  const baseDelayMs = boundedInteger(
    env.AI_STREAM_RETRY_BASE_MS,
    DEFAULT_BASE_DELAY_MS,
    0,
    10_000,
  );
  const configuredMaxDelayMs = boundedInteger(
    env.AI_STREAM_RETRY_MAX_MS,
    DEFAULT_MAX_DELAY_MS,
    1,
    30_000,
  );
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs: Math.max(baseDelayMs, configuredMaxDelayMs),
  };
}

export function getAiRetryAfterMs(
  error: unknown,
  nowMs = Date.now(),
): number | undefined {
  for (const value of errorChain(error)) {
    const retryAfterMs = Number(errorHeader(value, "retry-after-ms"));
    if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
      return Math.min(
        MAX_PROVIDER_RETRY_AFTER_MS,
        Math.max(50, Math.round(retryAfterMs)),
      );
    }

    const retryAfter = errorHeader(value, "retry-after");
    if (!retryAfter) continue;
    const seconds = Number(retryAfter);
    const parsedMs = Number.isFinite(seconds)
      ? seconds * 1_000
      : Date.parse(retryAfter) - nowMs;
    if (Number.isFinite(parsedMs) && parsedMs >= 0) {
      return Math.min(
        MAX_PROVIDER_RETRY_AFTER_MS,
        Math.max(50, Math.round(parsedMs)),
      );
    }
  }
  return undefined;
}

export function getAiRetryDelayMs(
  error: unknown,
  failedAttempt: number,
  config: AiStreamRetryConfig = getAiStreamRetryConfig(),
  random: () => number = Math.random,
): number {
  const providerDelay = getAiRetryAfterMs(error);
  if (providerDelay !== undefined) return providerDelay;

  const exponent = Math.max(0, failedAttempt - 1);
  const exponential = Math.min(
    config.maxDelayMs,
    config.baseDelayMs * 2 ** exponent,
  );
  const randomValue = Math.min(1, Math.max(0, random()));
  const jitter = 0.75 + randomValue * 0.25;
  return Math.round(exponential * jitter);
}

export function waitForAiRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  if (delayMs <= 0) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(ready);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
