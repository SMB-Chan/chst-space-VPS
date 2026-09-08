import type { SearchEvidenceMetadata } from "./search-evidence-vector";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string | null;
  /** Publisher metadata carried by vertical feeds such as Google News RSS. */
  publisherName?: string | null;
  publisherUrl?: string | null;
  /** Canonical article URL when a provider exposes one separately. */
  articleUrl?: string | null;
  /** Internal retrieval provenance used for bounded evidence-gap recovery. */
  evidence?: SearchEvidenceMetadata;
}

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "yclid",
  "_ga",
  "_gl",
]);

function isTrackingQueryKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized.startsWith("utm_") || TRACKING_QUERY_KEYS.has(normalized);
}

/**
 * Accept only ordinary credential-free HTTP(S) URLs for search results and
 * source cards. Fragment and well-known cross-site tracking parameters are
 * removed so the same document is not treated as multiple search results.
 * Semantically meaningful query parameters are preserved in their original
 * order; generic keys such as `ref` are intentionally not removed.
 */
export function normalizeExternalHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isTrackingQueryKey(key)) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return null;
  }
}

export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? [];
  const urls = matches
    .map(normalizeExternalHttpUrl)
    .filter((url): url is string => Boolean(url));
  return [...new Set(urls)].slice(0, 3);
}

export function stripHtml(html: string): string {
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

const STRONG_SEARCH_RE =
  /最新|きょう|今日|昨日|明日|ニュース|天気|天候|気温|株価|為替|円安|円高|選挙|速報|発売|リリース|試合結果|スコア|開場|いまの|今の|現在の|20\d{2}年|去年|昨年|一昨年|先月|先週|〜年前|\d+年前|以来|前回|当時|以前|過去|来年|再来年|来月|来週|今後|予定|予測|見通し|次回|\d+年後|将来|\b(today|tonight|latest|breaking|news|weather|who won|released?|last year|next year|future|forecast|prediction|compared to|over time)\b/i;
const SMALLTALK_RE =
  /^(こんにちは|おはよう|こんばんは|ありがとう|よろしく|hello|hi|hey)[\s!！。．]*$/i;

/** Cheap, model-free search decision so a slow judge LLM cannot skip the web. */
export function inferSearchQuery(text: string): {
  needed: boolean;
  query: string;
} {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed || SMALLTALK_RE.test(trimmed))
    return { needed: false, query: "" };
  if (/^https?:\/\/\S+$/i.test(trimmed)) return { needed: false, query: "" };
  return {
    needed: STRONG_SEARCH_RE.test(trimmed),
    query: buildStandaloneQuery(trimmed),
  };
}

/** Trailing request phrases that carry no search value ("...を教えてください"). */
const REQUEST_TAIL_RE =
  /(?:よろしくお願いします|お願いします|を)?(?:教えて|おしえて|調べて|検索して|見せて|まとめて|要約して|説明して|解説して|リストアップして)(?:ください|くれる|もらえますか|もらえませんか|いただけますか)?[。.!?！？\s]*$/;

/**
 * Turn a standalone user message into a compact query without a model: prefer
 * the sentence that carries the freshness/strong keyword, then strip trailing
 * request phrasing. Conversational and follow-up messages bypass this via
 * needsConversationAwareSearchPlan and reach the planner LLM instead.
 */
function buildStandaloneQuery(trimmed: string): string {
  const fallback = trimmed.slice(0, 80);
  const sentences = trimmed
    .split(/(?<=[。！？!?])\s*/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const source =
    sentences.length > 1
      ? (sentences.find((sentence) => STRONG_SEARCH_RE.test(sentence)) ??
        sentences[0])
      : trimmed;
  const query = source
    .replace(REQUEST_TAIL_RE, "")
    .replace(/[。.,、]\s*$/, "")
    .trim()
    .slice(0, 80);
  return query || fallback;
}

export function parseSearchHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const push = (rawUrl: string, title: string, snippet = "") => {
    let candidate = rawUrl;
    const uddg = candidate.match(/[?&]uddg=([^&]+)/);
    if (uddg) {
      try {
        candidate = decodeURIComponent(uddg[1]);
      } catch {
        return;
      }
    }
    const url = normalizeExternalHttpUrl(candidate);
    if (!url || seen.has(url)) return;
    seen.add(url);
    results.push({
      title: stripHtml(title) || url,
      url,
      snippet: stripHtml(snippet),
    });
  };

  const classicRe =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = classicRe.exec(html)) !== null && results.length < 5) {
    push(m[1], m[2], m[3] ?? "");
  }

  if (results.length === 0) {
    const liteRe = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((m = liteRe.exec(html)) !== null && results.length < 5) {
      if (!/[?&]uddg=/.test(m[1]) && !/^https?:\/\//i.test(m[1])) continue;
      push(m[1], m[2]);
    }
  }
  return results;
}

/**
 * Bing wraps organic results in `bing.com/ck/a` click-tracker links whose
 * real target is base64url-encoded in the `u` parameter (after an "a1"
 * marker). Returns the decoded target, the plain href for direct links, or
 * null when an unresolvable tracker link cannot be decoded.
 */
function unwrapBingRedirectUrl(rawHref: string): string | null {
  const href = rawHref.replace(/&amp;/g, "&");
  if (!/^https?:\/\/[^/]*bing\.com\/ck/i.test(href)) return href;
  const match = href.match(/[?&]u=([^&]+)/);
  if (!match) return null;
  let value = match[1];
  if (value.startsWith("a1")) value = value.slice(2);
  try {
    const decoded = Buffer.from(
      value.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    // Malformed encoding: treated as an unresolvable tracker below.
  }
  return null;
}

/**
 * Parse Bing result cards (`li.b_algo`). Used as the scraping fallback when
 * DuckDuckGo answers with its bot challenge, which is the common case from
 * datacenter IPs.
 */
export function parseSearchBingHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const algoRe = /<li class="b_algo"[\s\S]*?<\/li>/g;
  let block: RegExpExecArray | null;
  while ((block = algoRe.exec(html)) !== null && results.length < 5) {
    const item = block[0];
    const link = item.match(
      /<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (!link) continue;
    const unwrapped = unwrapBingRedirectUrl(link[1]);
    if (!unwrapped) continue;
    const url = normalizeExternalHttpUrl(unwrapped);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const snippet = item.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title: stripHtml(link[2]) || url,
      url,
      snippet: snippet ? stripHtml(snippet[1]) : "",
    });
  }
  return results;
}
