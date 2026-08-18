import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import type OpenAI from "openai";
import { logger } from "./logger";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebContext {
  searched: boolean;
  query?: string;
  sources: { title: string; url: string }[];
  contextText: string;
  searchWarning?: string;
}

/** Timeout covering ALL phases (DNS + connect + headers + body) for DDG search. */
const SEARCH_FETCH_TIMEOUT_MS = 10_000;
/** Shorter end-to-end timeout (DNS + connect + headers + body) for individual pages. */
const PAGE_FETCH_TIMEOUT_MS = 5_000;
/** Hard deadline for the search-decision LLM call. */
const DECIDE_TIMEOUT_MS = 8_000;

const MAX_PAGE_CHARS = 4000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---------------------------------------------------------------------------
// Bounded in-memory search-result cache
// ---------------------------------------------------------------------------
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes per entry
const SEARCH_CACHE_MAX = 200;               // max distinct queries retained

interface CacheEntry {
  results: SearchResult[];
  expiry: number;
}
const searchCache = new Map<string, CacheEntry>();

function getCachedResults(query: string): SearchResult[] | null {
  const entry = searchCache.get(query);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    searchCache.delete(query);
    return null;
  }
  return entry.results;
}

function setCachedResults(query: string, results: SearchResult[]): void {
  const now = Date.now();
  // Sweep all expired entries first so they don't count toward the size limit
  for (const [key, entry] of searchCache) {
    if (now > entry.expiry) searchCache.delete(key);
  }
  // If still at capacity, evict the oldest entry (Map preserves insertion order)
  while (searchCache.size >= SEARCH_CACHE_MAX) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey !== undefined) searchCache.delete(firstKey);
    else break;
  }
  searchCache.set(query, { results, expiry: now + SEARCH_CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  return [...new Set(matches)].slice(0, 3);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * SSRF guard: deny-by-default IP classification using ipaddr.js.
 * Only globally routable unicast addresses are allowed. Blocks loopback,
 * unspecified, link-local, private/ULA, CGNAT, multicast, broadcast,
 * reserved, and any IPv6 form embedding an IPv4 address (mapped ::ffff:x,
 * IPv4-compatible ::/96, NAT64/rfc6052, 6to4, Teredo) after checking the
 * embedded IPv4. Unparseable input is blocked.
 */
export function isPrivateAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return true;
  }
  if (addr.kind() === "ipv6") {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return isPrivateAddress(v6.toIPv4Address().toString());
    }
    const parts = v6.parts;
    // IPv4-compatible addresses (::/96, e.g. ::127.0.0.1 or ::7f00:1)
    if (parts.slice(0, 6).every((p) => p === 0)) {
      const ipv4 = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
      return isPrivateAddress(ipv4);
    }
    // NAT64 / rfc6052 (64:ff9b::/96) — embedded IPv4 in last 32 bits
    if (v6.range() === "rfc6052") {
      const ipv4 = `${parts[6] >> 8}.${parts[6] & 0xff}.${parts[7] >> 8}.${parts[7] & 0xff}`;
      return isPrivateAddress(ipv4);
    }
    // Everything not plain global unicast (loopback, linkLocal, uniqueLocal,
    // unspecified, multicast, 6to4, teredo, reserved, ...) is blocked.
    return v6.range() !== "unicast";
  }
  // IPv4: 'unicast' = globally routable; everything else
  // (private, loopback, linkLocal, carrierGradeNat, broadcast, multicast,
  // reserved, unspecified) is blocked.
  return addr.range() !== "unicast";
}

/**
 * Preflight SSRF check.  The DNS lookup here is raced against the caller's
 * AbortSignal so a stalled resolver cannot hold the request beyond the
 * configured deadline.
 */
async function assertSafeUrl(rawUrl: string, signal?: AbortSignal): Promise<URL> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked protocol: ${url.protocol}`);
  }
  const host = url.hostname;
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error(`Blocked private address: ${host}`);
    return url;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error(`Blocked host: ${host}`);
  }

  // Race the DNS lookup against the abort signal so a stalled resolver is
  // interrupted as soon as the overall fetch deadline fires.
  const lookupPromise = lookup(host, { all: true }).then((addrs) => {
    for (const { address } of addrs) {
      if (isPrivateAddress(address)) throw new Error(`Blocked host resolving to private address: ${host}`);
    }
    return url;
  });

  if (!signal) return lookupPromise;

  // Wrap the signal into a rejecting promise so we can race it
  const abortPromise = new Promise<URL>((_, reject) => {
    if (signal.aborted) {
      reject(new Error("DNS lookup aborted"));
    } else {
      signal.addEventListener("abort", () => reject(new Error("DNS lookup aborted")), { once: true });
    }
  });

  return Promise.race([lookupPromise, abortPromise]);
}

// Connection-layer SSRF guard: the address actually connected to is validated
// at DNS-lookup time inside the connector, so DNS rebinding between a
// pre-flight check and the real request cannot bypass it.
const safeAgent = new Agent({
  connect: {
    lookup: (hostname, options, callback) => {
      dnsLookup(hostname, options, (err, address, family) => {
        if (err) return callback(err, address as never, family as never);
        const addrs = Array.isArray(address)
          ? address.map((a) => (typeof a === "string" ? a : a.address))
          : [address];
        for (const a of addrs) {
          if (isPrivateAddress(a)) {
            return callback(
              new Error(`Blocked private address for host ${hostname}`),
              address as never,
              family as never
            );
          }
        }
        callback(null, address as never, family as never);
      });
    },
  },
});

/**
 * Fetch a URL with a hard end-to-end deadline covering DNS (preflight + connector),
 * TCP connect, TLS, response headers, AND body reading.
 *
 * Returns the `UndiciResponse` together with a `cancel` function the caller
 * MUST invoke after consuming the body (or on error) to disarm the timer.
 * The abort timer is intentionally NOT cleared inside this function so that
 * a server that stalls mid-body is still interrupted by the deadline.
 */
async function fetchWithTimeout(
  rawUrl: string,
  timeoutMs: number
): Promise<{ response: UndiciResponse; cancel: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => clearTimeout(timer);

  try {
    let current = rawUrl;
    for (let hop = 0; hop < 4; hop++) {
      // assertSafeUrl races its internal DNS lookup against our signal
      const url = await assertSafeUrl(current, controller.signal);
      const res = await undiciFetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8" },
        redirect: "manual",
        dispatcher: safeAgent,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { response: res, cancel };
        current = new URL(location, url).href;
        continue;
      }
      return { response: res, cancel };
    }
    throw new Error("Too many redirects");
  } catch (err) {
    cancel(); // disarm on error so timers don't leak
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchPageText(
  url: string
): Promise<{ title: string; text: string } | null> {
  try {
    const { response: res, cancel } = await fetchWithTimeout(url, PAGE_FETCH_TIMEOUT_MS);
    try {
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("html") && !contentType.includes("text")) return null;
      // Body read is still covered by the active abort timer
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? stripHtml(titleMatch[1]) : url;
      const text = stripHtml(html).slice(0, MAX_PAGE_CHARS);
      return { title, text };
    } finally {
      cancel(); // disarm only after body has been fully consumed
    }
  } catch (err) {
    logger.warn({ err, url }, "Failed to fetch page");
    return null;
  }
}

/** Search the web via DuckDuckGo HTML endpoint (no API key required). */
export async function searchWeb(query: string): Promise<SearchResult[]> {
  const cached = getCachedResults(query);
  if (cached) {
    logger.debug({ query }, "Search cache hit");
    return cached;
  }

  try {
    const { response: res, cancel } = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      SEARCH_FETCH_TIMEOUT_MS
    );
    try {
      if (!res.ok) {
        logger.warn({ status: res.status }, "DuckDuckGo search failed");
        return [];
      }
      // Body read is still covered by the active abort timer
      const html = await res.text();
      const results: SearchResult[] = [];
      const blockRe =
        /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      let m: RegExpExecArray | null;
      while ((m = blockRe.exec(html)) !== null && results.length < 5) {
        let url = m[1];
        const uddg = url.match(/[?&]uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]);
        if (!/^https?:\/\//.test(url)) continue;
        results.push({
          title: stripHtml(m[2]),
          url,
          snippet: m[3] ? stripHtml(m[3]) : "",
        });
      }
      setCachedResults(query, results);
      return results;
    } finally {
      cancel();
    }
  } catch (err) {
    logger.warn({ err, query }, "Web search error");
    return [];
  }
}

/**
 * Ask the model whether a web search is needed and, if so, for a query.
 * Uses an AbortController tied to DECIDE_TIMEOUT_MS so the upstream SDK
 * request is actually cancelled (not just raced away) when the deadline fires.
 *
 * Returns `skippedDueToError: true` when the call failed or timed out so that
 * callers can emit a user-visible warning instead of silently skipping search.
 */
export async function decideSearch(
  client: OpenAI,
  model: string,
  provider: "openai" | "dashscope",
  userMessage: string
): Promise<{ search: boolean; query: string; skippedDueToError?: boolean }> {
  const today = new Date().toISOString().slice(0, 10);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DECIDE_TIMEOUT_MS);

  try {
    const opts: Parameters<typeof client.chat.completions.create>[0] = {
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            `今日の日付: ${today}。あなたは検索判定アシスタントです。ユーザーの質問に正確に答えるためにWeb検索が必要かを判定してください。` +
            `最新情報・ニュース・価格・天気・イベント・リリース情報・あなたの知識にない可能性が高い固有名詞などは検索が必要です。` +
            `挨拶・雑談・一般知識・プログラミングの一般的な質問は検索不要です。` +
            `必ず次のJSONのみを出力: {"search": true/false, "query": "検索クエリ(日本語または英語、検索不要なら空文字)"}`,
        },
        { role: "user", content: userMessage.slice(0, 2000) },
      ],
    };
    if (provider === "openai") {
      (opts as unknown as Record<string, unknown>).max_completion_tokens = 200;
    } else {
      (opts as unknown as Record<string, unknown>).max_tokens = 200;
      // Search decision must stay a cheap JSON call — never inherit default thinking.
      (opts as unknown as Record<string, unknown>).extra_body = { enable_thinking: false };
    }

    // Pass the abort signal as a request option so the SDK cancels the upstream
    // HTTP request when the timer fires (not just races away from it).
    const resp = (await client.chat.completions.create(
      opts,
      { signal: controller.signal }
    )) as OpenAI.Chat.Completions.ChatCompletion;

    const text = resp.choices[0]?.message?.content ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        search: Boolean(parsed.search) && typeof parsed.query === "string" && parsed.query.trim() !== "",
        query: typeof parsed.query === "string" ? parsed.query.trim() : "",
      };
    }
    return { search: false, query: "" };
  } catch (err) {
    const isAbort =
      (err as Error)?.name === "AbortError" ||
      controller.signal.aborted ||
      (err as Error)?.message?.includes("aborted");
    if (isAbort) {
      logger.warn({ model }, "Search decision timed out; skipping search");
    } else {
      logger.warn({ err, model }, "Search decision failed; skipping search");
    }
    return { search: false, query: "", skippedDueToError: true };
  } finally {
    clearTimeout(timer); // always disarm; abort already fired if it needed to
  }
}

/**
 * Build web context for a user message:
 * - fetches any URLs pasted by the user (with per-page end-to-end timeout)
 * - runs a web search when the decision step says it is needed
 *
 * URL fetching and search-decision are started in parallel (independent).
 * All timeouts cover DNS + connect + headers + body so stalled sources cannot
 * block the response indefinitely.
 * `onStatus` is called with progress events for SSE streaming, including
 * warnings when sources fail.
 */
export async function buildWebContext(
  client: OpenAI,
  model: string,
  provider: "openai" | "dashscope",
  userMessage: string,
  onStatus: (event: Record<string, unknown>) => void
): Promise<WebContext> {
  const sources: { title: string; url: string }[] = [];
  const parts: string[] = [];
  let searched = false;
  let query: string | undefined;
  let searchWarning: string | undefined;

  const urls = extractUrls(userMessage);

  if (urls.length > 0) {
    onStatus({ status: "fetching", urls });
  }

  // Start URL fetching and search-decision in parallel — they are independent
  const [urlPages, decision] = await Promise.all([
    urls.length > 0
      ? Promise.all(urls.map((u) => fetchPageText(u)))
      : Promise.resolve([] as (Awaited<ReturnType<typeof fetchPageText>>)[]),
    decideSearch(client, model, provider, userMessage),
  ]);

  // Process user-provided URL pages; notify when any fail
  let urlFetchFailed = false;
  urlPages.forEach((page, i) => {
    if (page) {
      sources.push({ title: page.title, url: urls[i] });
      parts.push(`【ユーザー提供URL: ${urls[i]}】\nタイトル: ${page.title}\n本文抜粋: ${page.text}`);
    } else if (urls[i]) {
      urlFetchFailed = true;
      logger.warn({ url: urls[i] }, "URL fetch failed; continuing without it");
    }
  });

  if (urlFetchFailed) {
    const warning = "一部のURLが読み込めませんでした（タイムアウトまたはアクセス不可）。読み込めた情報でお答えします。";
    searchWarning = warning;
    onStatus({ status: "search_warning", message: warning });
  }

  // Warn when the search decision itself failed or timed out
  if (decision.skippedDueToError) {
    const warning = "検索判定がタイムアウトしたため、Web検索をスキップしました。手元の知識でお答えします。";
    searchWarning = warning;
    onStatus({ status: "search_warning", message: warning });
  }

  // Web search
  if (decision.search) {
    searched = true;
    query = decision.query;
    onStatus({ status: "searching", query });
    const results = await searchWeb(decision.query);
    if (results.length > 0) {
      const top = results.slice(0, 2);
      const pages = await Promise.all(top.map((r) => fetchPageText(r.url)));
      for (const r of results) {
        sources.push({ title: r.title, url: r.url });
      }
      const snippetBlock = results
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   概要: ${r.snippet}`)
        .join("\n");
      parts.push(`【Web検索結果（クエリ: ${decision.query}）】\n${snippetBlock}`);

      let pagesFetched = 0;
      pages.forEach((page, i) => {
        if (page) {
          pagesFetched++;
          parts.push(`【ページ内容: ${top[i].url}】\n${page.text}`);
        }
      });

      // Warn when any (not just all) of the selected pages failed to load
      if (pagesFetched < top.length) {
        const warning =
          pagesFetched === 0
            ? "ページ取得がすべてタイムアウトしたため、検索スニペットのみを参照しています。"
            : "一部のページ取得がタイムアウトしたため、取得できた情報でお答えします。";
        searchWarning = warning;
        onStatus({ status: "search_warning", message: warning });
      }
    } else {
      const warning = "Web検索で結果が取得できませんでした。手元の知識でお答えします。";
      searchWarning = warning;
      onStatus({ status: "search_warning", message: warning });
      parts.push(`【Web検索結果（クエリ: ${decision.query}）】\n検索結果が取得できませんでした。`);
    }
  }

  return {
    searched,
    query,
    sources,
    contextText: parts.join("\n\n"),
    searchWarning,
  };
}
