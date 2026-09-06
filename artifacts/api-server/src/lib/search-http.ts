import { fetch as undiciFetch } from "undici";
import { readResponseTextLimited } from "./bounded-body";

const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
export const SEARCH_PROVIDER_REDIRECT_POLICY = "error" as const;

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function parseRateLimitResetMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const epochSeconds = Number(value.trim());
  if (!Number.isFinite(epochSeconds) || epochSeconds < 0) return undefined;
  return Math.max(0, epochSeconds * 1000 - Date.now());
}

function providerHttpError(
  status: number,
  retryAfter: string | null,
  rateLimitReset: string | null,
): Error {
  const error = new Error(`Search API returned ${status}`) as Error & {
    status?: number;
    retryAfterMs?: number;
  };
  error.status = status;
  const retryAfterMs =
    parseRetryAfterMs(retryAfter) ?? parseRateLimitResetMs(rateLimitReset);
  if (retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

export async function fetchSearchText(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
  signal?: AbortSignal,
  acceptedContentType?: RegExp,
): Promise<string> {
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
    const res = await undiciFetch(url, {
      ...init,
      signal: controller.signal,
      redirect: SEARCH_PROVIDER_REDIRECT_POLICY,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw providerHttpError(
        res.status,
        res.headers.get("retry-after"),
        res.headers.get("x-ratelimit-reset"),
      );
    }
    if (acceptedContentType) {
      const contentType = res.headers.get("content-type") ?? "";
      if (!acceptedContentType.test(contentType)) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error("Search API returned an unexpected content type");
      }
    }
    return await readResponseTextLimited(res, MAX_PROVIDER_RESPONSE_BYTES);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abortParent);
  }
}

export async function fetchSearchJson(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
  signal?: AbortSignal,
): Promise<unknown> {
  const text = await fetchSearchText(
    url,
    init,
    signal,
    /\b(?:application\/json|[^;]+\+json)\b/i,
  );
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Search API returned invalid JSON");
  }
}
