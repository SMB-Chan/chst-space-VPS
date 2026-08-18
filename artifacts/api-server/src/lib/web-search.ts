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
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_PAGE_CHARS = 4000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

async function assertSafeUrl(rawUrl: string): Promise<URL> {
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
  const addrs = await lookup(host, { all: true });
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) throw new Error(`Blocked host resolving to private address: ${host}`);
  }
  return url;
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

async function fetchWithTimeout(rawUrl: string): Promise<UndiciResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // Follow redirects manually so every hop is SSRF-checked
    let current = rawUrl;
    for (let hop = 0; hop < 4; hop++) {
      const url = await assertSafeUrl(current);
      const res = await undiciFetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, "Accept-Language": "ja,en;q=0.8" },
        redirect: "manual",
        dispatcher: safeAgent,
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return res;
        current = new URL(location, url).href;
        continue;
      }
      return res;
    }
    throw new Error("Too many redirects");
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPageText(
  url: string
): Promise<{ title: string; text: string } | null> {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html") && !contentType.includes("text")) return null;
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : url;
    const text = stripHtml(html).slice(0, MAX_PAGE_CHARS);
    return { title, text };
  } catch (err) {
    logger.warn({ err, url }, "Failed to fetch page");
    return null;
  }
}

/** Search the web via DuckDuckGo HTML endpoint (no API key required). */
export async function searchWeb(query: string): Promise<SearchResult[]> {
  try {
    const res = await fetchWithTimeout(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    );
    if (!res.ok) {
      logger.warn({ status: res.status }, "DuckDuckGo search failed");
      return [];
    }
    const html = await res.text();
    const results: SearchResult[] = [];
    const blockRe =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(html)) !== null && results.length < 5) {
      let url = m[1];
      // DDG wraps result URLs: //duckduckgo.com/l/?uddg=<encoded>&...
      const uddg = url.match(/[?&]uddg=([^&]+)/);
      if (uddg) url = decodeURIComponent(uddg[1]);
      if (!/^https?:\/\//.test(url)) continue;
      results.push({
        title: stripHtml(m[2]),
        url,
        snippet: m[3] ? stripHtml(m[3]) : "",
      });
    }
    return results;
  } catch (err) {
    logger.warn({ err, query }, "Web search error");
    return [];
  }
}

/**
 * Ask the model whether a web search is needed and, if so, for a query.
 * Model-independent: works via any OpenAI-compatible client.
 */
export async function decideSearch(
  client: OpenAI,
  model: string,
  provider: "openai" | "dashscope",
  userMessage: string
): Promise<{ search: boolean; query: string }> {
  const today = new Date().toISOString().slice(0, 10);
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
    }
    const resp = (await client.chat.completions.create(
      opts
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
  } catch (err) {
    logger.warn({ err, model }, "Search decision failed; skipping search");
  }
  return { search: false, query: "" };
}

/**
 * Build web context for a user message:
 * - fetches any URLs pasted by the user
 * - runs a web search when the decision step says it is needed
 * `onStatus` is called with progress events for SSE streaming.
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

  // 1) Fetch URLs the user pasted directly
  const urls = extractUrls(userMessage);
  if (urls.length > 0) {
    onStatus({ status: "fetching", urls });
    const pages = await Promise.all(urls.map((u) => fetchPageText(u)));
    pages.forEach((page, i) => {
      if (page) {
        sources.push({ title: page.title, url: urls[i] });
        parts.push(`【ユーザー提供URL: ${urls[i]}】\nタイトル: ${page.title}\n本文抜粋: ${page.text}`);
      }
    });
  }

  // 2) Decide whether to search (skip when the message was mostly a URL request)
  const decision = await decideSearch(client, model, provider, userMessage);
  if (decision.search) {
    searched = true;
    query = decision.query;
    onStatus({ status: "searching", query });
    const results = await searchWeb(decision.query);
    if (results.length > 0) {
      // Fetch top 2 pages for deeper content
      const top = results.slice(0, 2);
      const pages = await Promise.all(top.map((r) => fetchPageText(r.url)));
      for (const r of results) {
        sources.push({ title: r.title, url: r.url });
      }
      const snippetBlock = results
        .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   概要: ${r.snippet}`)
        .join("\n");
      parts.push(`【Web検索結果（クエリ: ${decision.query}）】\n${snippetBlock}`);
      pages.forEach((page, i) => {
        if (page) {
          parts.push(`【ページ内容: ${top[i].url}】\n${page.text}`);
        }
      });
    } else {
      parts.push(`【Web検索結果（クエリ: ${decision.query}）】\n検索結果が取得できませんでした。`);
    }
  }

  return {
    searched,
    query,
    sources,
    contextText: parts.join("\n\n"),
  };
}
