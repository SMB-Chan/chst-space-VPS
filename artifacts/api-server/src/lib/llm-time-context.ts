export const LLM_TIME_ZONE = "Asia/Tokyo";
export const LLM_TIME_ZONE_LABEL = "JST";
export const LLM_UTC_OFFSET = "+09:00";

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: LLM_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("ja-JP", {
  timeZone: LLM_TIME_ZONE,
  weekday: "long",
});

const LEGACY_UTC_DATE_PREFIX = /^今日の日付:\s*\d{4}-\d{2}-\d{2}。\s*/;
const JST_CONTEXT_PREFIX = "現在日時:";

function dateTimeParts(date: Date): Record<string, string> {
  return Object.fromEntries(
    DATE_TIME_FORMATTER.formatToParts(date).map(({ type, value }) => [type, value]),
  );
}

/** ISO-8601-like timestamp pinned to Japan Standard Time (UTC+09:00). */
export function formatJstDateTime(date: Date = new Date()): string {
  const parts = dateTimeParts(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${LLM_UTC_OFFSET}`;
}

/**
 * Time context injected into LLM calls. Keep the IANA zone as well as the
 * numeric offset so models can resolve relative dates without depending on the
 * host machine's locale or timezone configuration.
 */
export function buildLlmTimeContext(date: Date = new Date()): string {
  const timestamp = formatJstDateTime(date);
  const weekday = WEEKDAY_FORMATTER.format(date);
  return (
    `現在日時: ${timestamp} (${weekday}, ${LLM_TIME_ZONE}, ${LLM_TIME_ZONE_LABEL}, UTC${LLM_UTC_OFFSET})。` +
    `「今日」「明日」「昨日」「今朝」「今夜」などの相対日時は、この日本標準時を基準に解釈してください。`
  );
}

interface ChatMessageLike {
  role?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

function normalizeMessages(messages: unknown[], date: Date): unknown[] {
  const normalized: unknown[] = [];

  for (const value of messages) {
    if (!value || typeof value !== "object") {
      normalized.push(value);
      continue;
    }

    const message = value as ChatMessageLike;
    if (message.role !== "system" || typeof message.content !== "string") {
      normalized.push(value);
      continue;
    }

    // Idempotence for retries/wrappers, and migration from the old UTC-only
    // "今日の日付" prefix used by chat-stream/web-search.
    if (message.content.startsWith(JST_CONTEXT_PREFIX)) continue;
    const content = message.content.replace(LEGACY_UTC_DATE_PREFIX, "");
    if (!content) continue;
    normalized.push({ ...message, content });
  }

  return [
    { role: "system", content: buildLlmTimeContext(date) },
    ...normalized,
  ];
}

/**
 * Inject JST context into an OpenAI-compatible chat-completions JSON body.
 * Non-JSON/non-chat-shaped bodies are returned unchanged.
 */
export function injectLlmTimeContextIntoBody(
  body: string,
  date: Date = new Date(),
): string {
  try {
    const parsed = JSON.parse(body) as { messages?: unknown } & Record<string, unknown>;
    if (!Array.isArray(parsed.messages)) return body;
    parsed.messages = normalizeMessages(parsed.messages, date);
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function requestUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function isChatCompletionsRequest(input: Parameters<typeof fetch>[0]): boolean {
  const raw = requestUrl(input);
  if (!raw) return false;
  try {
    return /\/chat\/completions\/?$/.test(new URL(raw).pathname);
  } catch {
    return false;
  }
}

/**
 * Fetch wrapper for OpenAI-compatible clients. It modifies only JSON request
 * bodies sent to /chat/completions; audio/files/other endpoints are untouched.
 */
export function createLlmTimeContextFetch(
  baseFetch: typeof fetch = globalThis.fetch,
  now: () => Date = () => new Date(),
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!isChatCompletionsRequest(input) || typeof init?.body !== "string") {
      return baseFetch(input, init);
    }

    const body = injectLlmTimeContextIntoBody(init.body, now());
    return baseFetch(input, { ...init, body });
  }) as typeof fetch;
}
