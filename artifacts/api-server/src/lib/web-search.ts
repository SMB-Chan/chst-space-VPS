import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, type Response as UndiciResponse } from "undici";
import type OpenAI from "openai";
import { logger } from "./logger";
import { readResponseTextLimited } from "./bounded-body";
import {
  extractUrls,
  parseSearchHtml,
  inferSearchQuery,
  stripHtml,
  type SearchResult,
} from "./search-parse";
import {
  expandSearchQueries,
  mergeSearchResults,
  extractMainContent,
  extractEmbeddedContent,
  isBotChallengePage,
  normalizeQuery,
  FETCH_TOP_N,
  MIN_CONTENT_CHARS,
  type ScoredSearchResult,
} from "./search-enhance";
import { fetchWithBrowser } from "./render-fetch";

export type { SearchResult, ScoredSearchResult };
export { extractUrls, inferSearchQuery, parseSearchHtml };

export interface WebContext {
  searched: boolean;
  query?: string;
  sources: { title: string; url: string }[];
  contextText: string;
  searchWarning?: string;
}

/** Timeout covering ALL phases (DNS + connect + headers + body) for DDG search. */
const SEARCH_FETCH_TIMEOUT_MS = 12_000;
/** Shorter end-to-end timeout (DNS + connect + headers + body) for individual pages. */
const PAGE_FETCH_TIMEOUT_MS = 6_000;
/** Hard deadline for the search-decision LLM call. Heuristic covers timeouts. */
const DECIDE_TIMEOUT_MS = 6_000;

const MAX_PAGE_CHARS = 4000;
/** Maximum decompressed bytes accepted from a fetched page/search response. */
export const MAX_PAGE_RESPONSE_BYTES = 1024 * 1024;
export const MAX_SEARCH_RESPONSE_BYTES = 2 * 1024 * 1024;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/**
 * Optional last-resort fallback for pages that cannot be read from raw HTML
 * (JS-rendered shells, bot challenges): fetch through the r.jina.ai rendering
 * proxy, which returns the page as Markdown. Disabled by default because the
 * target URL is sent to a third-party service; enable with
 * WEB_FETCH_RENDER_FALLBACK=1.
 */
const RENDER_FALLBACK_ENABLED = /^(1|true|yes)$/i.test(
  process.env.WEB_FETCH_RENDER_FALLBACK ?? "",
);
const RENDER_PROXY_BASE = "https://r.jina.ai/";

/**
 * Browser-based fallback (local headless Chromium via Playwright) for pages
 * unreadable from raw HTML.  Local and private, so enabled by default;
 * disable with WEB_FETCH_PLAYWRIGHT_FALLBACK=0.  Degrades gracefully when
 * the browser binary is not installed.
 */
const PLAYWRIGHT_FALLBACK_ENABLED = !/^(0|false|no)$/i.test(
  process.env.WEB_FETCH_PLAYWRIGHT_FALLBACK ?? "",
);
/** Deadline for one browser-rendered page load (goto + settle). */
const BROWSER_FETCH_TIMEOUT_MS = 15_000;

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
  const key = normalizeQuery(query);
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    searchCache.delete(key);
    return null;
  }
  return entry.results;
}

function setCachedResults(query: string, results: SearchResult[]): void {
  const key = normalizeQuery(query);
  const now = Date.now();
  // Sweep all expired entries first so they don't count toward the size limit
  for (const [cacheKey, entry] of searchCache) {
    if (now > entry.expiry) searchCache.delete(cacheKey);
  }
  // If still at capacity, evict the oldest entry (Map preserves insertion order)
  while (searchCache.size >= SEARCH_CACHE_MAX) {
    const firstKey = searchCache.keys().next().value;
    if (firstKey !== undefined) searchCache.delete(firstKey);
    else break;
  }
  searchCache.set(key, { results, expiry: now + SEARCH_CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------



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
  if (url.username || url.password) {
    throw new Error("Blocked URL containing credentials");
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
  timeoutMs: number,
  opts?: { userAgent?: string | null }
): Promise<{ response: UndiciResponse; cancel: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const cancel = () => clearTimeout(timer);
  const userAgent = opts && "userAgent" in opts ? opts.userAgent : USER_AGENT;

  try {
    let current = rawUrl;
    for (let hop = 0; hop < 4; hop++) {
      // assertSafeUrl races its internal DNS lookup against our signal
      const url = await assertSafeUrl(current, controller.signal);
      const headers: Record<string, string> = { "Accept-Language": "ja,en;q=0.8" };
      if (userAgent) headers["User-Agent"] = userAgent;
      const res = await undiciFetch(url, {
        signal: controller.signal,
        headers,
        redirect: "manual",
        dispatcher: safeAgent,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { response: res, cancel };
        // Do not leave a redirect body pinned to the connection pool.
        try {
          await res.body?.cancel();
        } catch {
          // Following the validated redirect is still safe if cancellation races.
        }
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

async function discardResponseBody(response: UndiciResponse): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup for non-success/non-text responses.
  }
}

/**
 * Fetch a page through the rendering proxy (r.jina.ai) and return its
 * Markdown text.  Used only when direct extraction failed and the operator
 * has opted in via WEB_FETCH_RENDER_FALLBACK.
 */
async function fetchViaRenderProxy(url: string): Promise<string | null> {
  try {
    // Rendering is slower than a plain fetch, so allow a longer deadline.
    // Note: r.jina.ai's own Cloudflare challenges browser-like User-Agents
    // from datacenter IPs, so the proxy request omits the browser UA.
    const { response: res, cancel } = await fetchWithTimeout(
      `${RENDER_PROXY_BASE}${url}`,
      PAGE_FETCH_TIMEOUT_MS * 3,
      { userAgent: null },
    );
    try {
      if (!res.ok) {
        await discardResponseBody(res);
        return null;
      }
      const text = (await readResponseTextLimited(res, MAX_PAGE_RESPONSE_BYTES)).trim();
      // The proxy can return a rendered copy of the target's own bot
      // challenge ("Just a moment..."), which is not usable content.
      if (text.length < MIN_CONTENT_CHARS || isBotChallengePage(text)) return null;
      return text;
    } finally {
      cancel();
    }
  } catch (err) {
    logger.warn({ err, url }, "Render-proxy fetch failed");
    return null;
  }
}

/**
 * Last-resort fetch chain for pages unreadable via plain HTTP:
 * 1. local headless Chromium (Playwright) — private, enabled by default
 * 2. r.jina.ai rendering proxy — third-party, opt-in only
 */
async function fetchViaFallbacks(
  url: string,
): Promise<{ title: string; text: string } | null> {
  if (PLAYWRIGHT_FALLBACK_ENABLED) {
    const rendered = await fetchWithBrowser(url, BROWSER_FETCH_TIMEOUT_MS);
    if (
      rendered &&
      rendered.text.length >= MIN_CONTENT_CHARS &&
      !isBotChallengePage(rendered.text)
    ) {
      return { title: rendered.title, text: rendered.text.slice(0, MAX_PAGE_CHARS) };
    }
  }
  if (RENDER_FALLBACK_ENABLED) {
    const rendered = await fetchViaRenderProxy(url);
    if (rendered) return { title: url, text: rendered.slice(0, MAX_PAGE_CHARS) };
  }
  return null;
}

export async function fetchPageText(
  url: string
): Promise<{ title: string; text: string } | null> {
  try {
    const { response: res, cancel } = await fetchWithTimeout(url, PAGE_FETCH_TIMEOUT_MS);
    try {
      if (!res.ok) {
        logger.warn({ status: res.status, url }, "Page fetch rejected");
        await discardResponseBody(res);
        // Bot-protection commonly answers with 401/403/429/503; the fallback
        // chain (browser, then proxy) may still be able to read the page.
        if ([401, 403, 429, 503].includes(res.status)) {
          return await fetchViaFallbacks(url);
        }
        return null;
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("html") && !contentType.includes("text")) {
        await discardResponseBody(res);
        return null;
      }
      // Body read is still covered by the active abort timer and is bounded
      // before conversion to a JavaScript string.
      const html = await readResponseTextLimited(res, MAX_PAGE_RESPONSE_BYTES);
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = titleMatch ? stripHtml(titleMatch[1]) : url;

      let text = extractMainContent(html);
      if (text.length < MIN_CONTENT_CHARS) {
        // JS-rendered shell or interstitial: try data embedded in the HTML
        // (JSON-LD articleBody, Next.js __NEXT_DATA__) before giving up.
        const embedded = extractEmbeddedContent(html);
        if (embedded.length > text.length) text = embedded;
      }

      if (text.length < MIN_CONTENT_CHARS) {
        // Still unreadable (JS shell, interstitial): hand over to the
        // browser/proxy fallback chain, keeping the HTML-derived title.
        const fallback = await fetchViaFallbacks(url);
        if (fallback) return { title: title === url ? fallback.title : title, text: fallback.text };
        logger.warn(
          { url, botChallenge: isBotChallengePage(html) },
          "Page content unreadable (JS-rendered or bot-blocked)",
        );
        return null;
      }
      return { title, text: text.slice(0, MAX_PAGE_CHARS) };
    } finally {
      cancel(); // disarm only after body has been fully consumed
    }
  } catch (err) {
    logger.warn({ err, url }, "Failed to fetch page");
    return null;
  }
}

async function searchWebOnce(url: string): Promise<SearchResult[]> {
  const { response: res, cancel } = await fetchWithTimeout(url, SEARCH_FETCH_TIMEOUT_MS);
  try {
    if (!res.ok) {
      logger.warn({ status: res.status, url }, "Search endpoint failed");
      await discardResponseBody(res);
      return [];
    }
    return parseSearchHtml(await readResponseTextLimited(res, MAX_SEARCH_RESPONSE_BYTES));
  } finally {
    cancel();
  }
}

/** Search the web via DuckDuckGo HTML (no API key). Falls back to the lite page. */
export async function searchWeb(query: string): Promise<ScoredSearchResult[]> {
  const cached = getCachedResults(query);
  if (cached) {
    logger.debug({ query }, "Search cache hit");
    return cached.map((r) => ({ ...r, score: 0 }));
  }

  const queries = expandSearchQueries(query);
  const endpoints = [
    `https://html.duckduckgo.com/html/?q=`,
    `https://lite.duckduckgo.com/lite/?q=`,
  ];

  // Search all query-angle × endpoint combinations in parallel.
  const searchCalls: Promise<SearchResult[]>[] = [];
  for (const q of queries) {
    for (const base of endpoints) {
      const url = `${base}${encodeURIComponent(q)}`;
      searchCalls.push(
        searchWebOnce(url).catch((err) => {
          logger.warn({ err, query: q, endpoint: base }, "Web search endpoint error");
          return [];
        }),
      );
    }
  }

  const resultSets = await Promise.all(searchCalls);
  const allResults = resultSets.flat();
  if (allResults.length === 0) return [];

  const merged = mergeSearchResults(allResults, query);
  setCachedResults(
    query,
    merged.map(({ score: _score, ...rest }) => rest),
  );
  return merged;
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
  userMessage: string,
  options?: { forceQuery?: string },
): Promise<{ search: boolean; query: string; skippedDueToError?: boolean; usedFallback?: boolean }> {
  if (options?.forceQuery) {
    return { search: true, query: options.forceQuery };
  }

  const inferred = inferSearchQuery(userMessage);
  if (inferred.needed && inferred.query) {
    return { search: true, query: inferred.query };
  }

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
      logger.warn({ model }, "Search decision timed out; using heuristic fallback");
    } else {
      logger.warn({ err, model }, "Search decision failed; using heuristic fallback");
    }
    if (inferred.query) {
      return { search: true, query: inferred.query, usedFallback: true };
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
  onStatus: (event: Record<string, unknown>) => void,
  options?: { forceQuery?: string },
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
    decideSearch(client, model, provider, userMessage, options),
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
    const warning = "一部のURLが読み込めませんでした（タイムアウト・アクセス拒否・ボット対策によるブロックなど）。読み込めた情報でお答えします。";
    searchWarning = warning;
    onStatus({ status: "search_warning", message: warning });
  }

  if (decision.usedFallback) {
    const warning = "検索判定が遅れたため、メッセージから検索クエリを作りました。";
    searchWarning = warning;
    onStatus({ status: "search_warning", message: warning });
  } else if (decision.skippedDueToError) {
    const warning = "検索判定に失敗したため、Web検索をスキップしました。手元の知識でお答えします。";
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
      const top = results.slice(0, FETCH_TOP_N);
      const pages = await Promise.all(top.map((r) => fetchPageText(r.url)));
      for (const r of results) {
        sources.push({ title: r.title, url: r.url });
      }
      const snippetBlock = results
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   概要: ${r.snippet}`)
        .join("\n");
      const expandedQueries = expandSearchQueries(decision.query);
      const queryNote =
        expandedQueries.length > 1
          ? `（拡張クエリ: ${expandedQueries.slice(1).join(" / ")}）`
          : "";
      parts.push(`【Web検索結果（クエリ: ${decision.query}）${queryNote}】\n${snippetBlock}`);

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
