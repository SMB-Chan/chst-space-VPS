import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { stripHtml, type SearchResult } from "./search-parse";

/** Number of top-scored results whose pages are fetched for full-text context. */
export const FETCH_TOP_N = 5;
/** Maximum results to return from a merged search. */
export const MAX_MERGED_RESULTS = 8;
/** First-pass cap for one hostname in the final ranked result set. */
const FINAL_HOSTNAME_SOFT_CAP = 2;

/** Normalize a query for cache keys and comparison. */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[\s　]+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

/** Maximum length accepted for an LLM-generated search query. */
export const MAX_SEARCH_QUERY_CHARS = 200;

export type SearchIntent =
  "weather" | "movies" | "news" | "finance" | "general";

/** Classify only the broad intent needed for cheap query/result tuning. */
export function classifySearchIntent(query: string): SearchIntent {
  if (/天気|天候|気温|降水|雨|雪|台風|気象|weather|forecast/i.test(query)) {
    return "weather";
  }
  if (
    /映画|上映|映画館|シネマ|興行|movie|film|cinema|showtimes?/i.test(query)
  ) {
    return "movies";
  }
  if (/ニュース|速報|報道|news|breaking|headlines?/i.test(query)) {
    return "news";
  }
  if (/株価|為替|相場|金利|決算|stock|forex|market price/i.test(query)) {
    return "finance";
  }
  return "general";
}

/**
 * Secret-shaped substrings that must never leave the process inside a search
 * query (a prompt-injected page could otherwise trick the follow-up-search
 * decision into exfiltrating them to external search APIs).
 */
const SECRET_LIKE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/, // OpenAI-style API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /api[_-]?key\s*[:=]\s*\S+/i,
  /password\s*[:=]\s*\S+/i,
];

/**
 * Sanitize a search query produced by an LLM (or an external caller) before
 * it is sent to a search backend.  Collapses to a single line, enforces a
 * length cap, and rejects secret-looking content.  Returns "" when the query
 * is unusable — callers must treat that as "do not search".
 */
export function sanitizeSearchQuery(raw: string): string {
  const oneLine = raw
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!oneLine || oneLine.length > MAX_SEARCH_QUERY_CHARS) return "";
  if (SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(oneLine))) return "";
  return oneLine;
}

/**
 * Expand a single query into a small set of related queries to improve recall.
 * Keeps the original query and adds angle variants (latest/news) without
 * multiplying into expensive LLM calls.
 */
export function expandSearchQueries(baseQuery: string): string[] {
  const normalized = baseQuery.trim();
  if (!normalized) return [];

  const variants = new Set<string>();
  variants.add(normalized);

  const hasLatest = /最新|latest|current|now|きょう|今日|現在/i.test(
    normalized,
  );
  const hasNews = /ニュース|news|速報|headlines?/i.test(normalized);
  const hasJapanese =
    /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(normalized);
  const intent = classifySearchIntent(normalized);

  const hasPast =
    /去年|昨年|一昨年|先月|先週|\d+年前|以来|前回|当時|以前|過去|last year|ago|since|historical/i.test(
      normalized,
    );
  const hasFuture =
    /来年|再来年|来月|来週|今後|\d+年後|将来|予定|予測|見通し|next year|future|forecast|prediction|upcoming/i.test(
      normalized,
    );

  // Domain-specific variants avoid sending unrelated generic "news" queries
  // for weather forecasts or movie showtimes.
  if (intent === "weather") {
    if (!/気象庁|jma\.go\.jp/i.test(normalized)) {
      variants.add(
        hasJapanese ? `${normalized} 気象庁` : `${normalized} official`,
      );
    }
    if (!/時間別|hourly/i.test(normalized)) {
      variants.add(
        hasJapanese ? `${normalized} 時間別予報` : `${normalized} hourly`,
      );
    }
  } else if (intent === "movies") {
    if (!/上映スケジュール|showtimes?/i.test(normalized)) {
      variants.add(
        hasJapanese
          ? `${normalized} 上映スケジュール`
          : `${normalized} showtimes`,
      );
    }
    if (!/映画館|cinema/i.test(normalized)) {
      variants.add(
        hasJapanese ? `${normalized} 映画館` : `${normalized} cinema`,
      );
    }
  } else if (!hasLatest && !hasNews) {
    variants.add(hasJapanese ? `${normalized} 最新` : `${normalized} latest`);
    if (hasJapanese && intent === "news") {
      variants.add(`${normalized} ニュース`);
    }
  }

  // Add temporal variants for past/future queries to improve recall.
  if (hasPast && hasJapanese) {
    variants.add(`${normalized} 結果`);
  }
  if (hasFuture && hasJapanese) {
    variants.add(`${normalized} 予想`);
  }

  return Array.from(variants).slice(0, 4);
}

const AUTHORITY_DOMAINS = new Set([
  "jma.go.jp",
  "tenki.jp",
  "weathernews.jp",
  "go.jp",
  "gov",
  "edu",
  "ac.jp",
  "reuters.com",
  "bloomberg.com",
  "nikkei.com",
  "mainichi.jp",
  "asahi.com",
  "yomiuri.co.jp",
  "nhk.or.jp",
  "jiji.com",
  "afpbb.com",
  "wsj.com",
  "nytimes.com",
  "washingtonpost.com",
  "guardian.com",
  "ft.com",
  "economist.com",
  "arxiv.org",
  "github.com",
  "stackoverflow.com",
  "docs.microsoft.com",
  "developer.mozilla.org",
  "apple.com",
  "google.com",
  "amazon.com",
  "wikipedia.org",
]);

const LOW_QUALITY_DOMAINS = new Set([
  "2ch",
  "5ch",
  "matome",
  "ameblo.jp",
  "blog.livedoor.jp",
  "plaza.rakuten.co.jp",
  "fc2.com",
]);

function hostnameMatches(hostname: string, indicator: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedIndicator = indicator.toLowerCase().trim().replace(/^\./, "");
  if (!normalizedIndicator) return false;

  // Entries containing a dot are domain suffixes.  Bare entries (e.g.
  // "gov", "edu", "matome") are matched against complete hostname labels,
  // never against the path/query string or an arbitrary substring.
  if (normalizedIndicator.includes(".")) {
    return (
      normalizedHost === normalizedIndicator ||
      normalizedHost.endsWith(`.${normalizedIndicator}`)
    );
  }
  return normalizedHost.split(".").includes(normalizedIndicator);
}

function domainScore(url: string): number {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return 0;
  }

  let score = 0;
  for (const domain of AUTHORITY_DOMAINS) {
    if (hostnameMatches(hostname, domain)) {
      score += 8;
      break;
    }
  }
  for (const domain of LOW_QUALITY_DOMAINS) {
    if (hostnameMatches(hostname, domain)) {
      score -= 6;
      break;
    }
  }
  return score;
}

function searchableTerms(query: string): string[] {
  const stopWords = new Set([
    "今日",
    "明日",
    "現在",
    "最新",
    "情報",
    "比較",
    "して",
    "くれる",
    "ください",
    "教えて",
  ]);
  const chunks = query
    .toLowerCase()
    .replace(/[?？!！。、,.()（）「」『』【】]/g, " ")
    .split(/[\s　]+|(?:の|は|を|が|へ|と|で|や|も|から|まで)/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !stopWords.has(term));
  return [...new Set(chunks)];
}

function intentRelevanceScore(result: SearchResult, query: string): number {
  const intent = classifySearchIntent(query);
  const combined =
    `${result.title} ${result.snippet} ${result.url}`.toLowerCase();
  if (intent === "weather") {
    // Recommendation/listicle pages are not forecast sources even when their
    // snippets mention features such as precipitation probability.
    if (/アプリ|おすすめ|ランキング|まとめ/.test(combined)) return -14;
    const directForecastMatch =
      /気温|降水|警報|注意報|台風|気象|予報|forecast|jma\.go\.jp|tenki\.jp|weathernews\.jp|weather\.yahoo\.co\.jp/i.test(
        combined,
      );
    if (directForecastMatch) return 10;
    return /天気|天候|雨|雪|weather/i.test(combined) ? 4 : -14;
  }
  if (intent === "movies") {
    return /映画|上映|映画館|シネマ|興行|movie|film|cinema|showtime/i.test(
      combined,
    )
      ? 8
      : -10;
  }
  return 0;
}

function recencyScore(text: string, now = new Date()): number {
  const combined = `${text}`;
  const jstYear = Number(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
    }).format(now),
  );
  const previousYear = jstYear - 1;
  const years = Array.from(combined.matchAll(/\b(20\d{2})\b/g), (match) =>
    Number(match[1]),
  );
  if (years.includes(jstYear)) return 4;
  if (years.includes(previousYear)) return 2;
  // Japanese date patterns.  Without a year this is only a modest signal.
  if (/[0-9]{1,2}月[0-9]{1,2}日/.test(combined)) return 2;
  // Relative time words.
  if (
    /今週|先週|今月|先月|最近|昨日|今日|きょう|this week|last week|today|yesterday/i.test(
      combined,
    )
  ) {
    return 2;
  }
  return 0;
}

/** Score a search result for relevance to the original query. */
export function scoreSearchResult(
  result: SearchResult,
  originalQuery: string,
): number {
  const query = originalQuery.toLowerCase();
  const title = result.title.toLowerCase();
  const snippet = result.snippet.toLowerCase();
  const combined = `${title} ${snippet}`;

  let score = 0;

  // Exact/partial title match is the strongest signal.
  if (title.includes(query)) score += 12;
  else if (title.split(/\s+/).some((w) => query.includes(w) && w.length > 1))
    score += 6;

  // Snippet match.
  if (snippet.includes(query)) score += 6;

  // Term overlap. Japanese particles are separators too, so a natural query
  // such as "東京の天気" contributes both "東京" and "天気".
  const queryWords = searchableTerms(query);
  const matchedWords = queryWords.filter((w) => combined.includes(w));
  score += matchedWords.length * 2;

  score += intentRelevanceScore(result, originalQuery);

  // Domain authority and quality penalties.
  score += domainScore(result.url);

  // Recency indicators.
  score += recencyScore(`${title} ${snippet}`);

  // Snippet length bonus (informational results tend to have longer snippets).
  if (result.snippet.length >= 60) score += 1;

  return score;
}

export interface ScoredSearchResult extends SearchResult {
  score: number;
}

function resultHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Preserve score order while preventing one hostname from monopolizing the
 * first pass. Deferred high-score results are appended in their original score
 * order only when diversity would otherwise leave the result set short.
 */
export function selectDiverseScoredResults(
  sortedResults: ScoredSearchResult[],
  maxResults: number,
): ScoredSearchResult[] {
  if (maxResults <= 0) return [];

  const selected: ScoredSearchResult[] = [];
  const deferred: ScoredSearchResult[] = [];
  const perHostname = new Map<string, number>();

  for (const result of sortedResults) {
    const hostname = resultHostname(result.url);
    if (
      hostname &&
      (perHostname.get(hostname) ?? 0) >= FINAL_HOSTNAME_SOFT_CAP
    ) {
      deferred.push(result);
      continue;
    }

    selected.push(result);
    if (hostname) {
      perHostname.set(hostname, (perHostname.get(hostname) ?? 0) + 1);
    }
    if (selected.length >= maxResults) return selected;
  }

  for (const result of deferred) {
    if (selected.length >= maxResults) break;
    selected.push(result);
  }
  return selected;
}

/**
 * Merge results from multiple queries, deduplicate by URL, score, and return
 * the top results sorted by relevance with a soft final hostname-diversity cap.
 */
export function mergeSearchResults(
  results: SearchResult[],
  originalQuery: string,
  opts?: { maxResults?: number },
): ScoredSearchResult[] {
  const maxResults = opts?.maxResults ?? MAX_MERGED_RESULTS;
  const seen = new Set<string>();
  const merged: ScoredSearchResult[] = [];

  for (const r of results) {
    const normalizedUrl = r.url.split("#")[0];
    if (seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    merged.push({ ...r, score: scoreSearchResult(r, originalQuery) });
  }

  const intent = classifySearchIntent(originalQuery);
  const intentFiltered =
    intent === "weather" || intent === "movies"
      ? merged.filter(
          (result) => intentRelevanceScore(result, originalQuery) > 0,
        )
      : merged;

  intentFiltered.sort((a, b) => b.score - a.score);
  return selectDiverseScoredResults(intentFiltered, maxResults);
}

/**
 * Extract the main readable content from HTML.
 * Uses semantic tags when available, otherwise falls back to the longest
 * contiguous paragraph block.
 */
export function extractMainContent(html: string): string {
  // Strip noise tags first.
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<menu[\s\S]*?<\/menu>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");

  // Prefer article/main content.
  const semanticMatch = cleaned.match(/<(article|main)[^>]*>([\s\S]*?)<\/\1>/i);
  if (semanticMatch) {
    const text = stripHtml(semanticMatch[2]).trim();
    if (text.length > 200) return text;
  }

  // Fallback: collect paragraphs and pick the densest contiguous block.
  const paragraphs: string[] = [];
  const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let m: RegExpExecArray | null;
  while ((m = pRe.exec(cleaned)) !== null) {
    const text = stripHtml(m[1]).trim();
    if (text.length >= 30) paragraphs.push(text);
  }

  if (paragraphs.length > 0) {
    return paragraphs.join("\n\n").trim();
  }

  // Last resort: strip all tags.
  return stripHtml(cleaned).trim();
}

/**
 * Below this many characters of extracted text, a page is treated as
 * unreadable (JS-rendered shell, bot challenge, or empty page) and
 * fallbacks are attempted.
 */
export const MIN_CONTENT_CHARS = 120;

/**
 * Extract article text with Mozilla Readability (Firefox Reader View's
 * engine) over a jsdom DOM.  Much more accurate than the regex-based
 * extractMainContent for article-style pages; pure JS, no browser needed.
 * Scripts are never executed and subresources never load (jsdom defaults),
 * so untrusted HTML is safe to parse.
 *
 * Returns null when Readability cannot identify an article or the result
 * is too thin to be useful.
 */
export function extractArticleContent(
  html: string,
  url: string,
): { title: string; text: string } | null {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    if (!article) return null;
    const text = (article.textContent ?? "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length < MIN_CONTENT_CHARS) return null;
    return { title: (article.title ?? "").trim(), text };
  } catch {
    return null;
  }
}

/**
 * Heuristic markers of bot-protection / JS-challenge pages (Cloudflare,
 * DataDome, PerimeterX, ...).  Checked case-insensitively against the start
 * of the document, where these pages carry their challenge markup.
 */
const BOT_CHALLENGE_MARKERS = [
  "just a moment",
  "checking your browser",
  "checking if the site connection is secure",
  "verify you are human",
  "cf-challenge",
  "challenge-platform",
  "cf-browser-verification",
  "ddjskey", // DataDome
  "datadome",
  "px-captcha", // PerimeterX
  "are you a robot",
  "enable javascript and cookies to continue",
];

/** Detect bot-protection / JS-challenge interstitials. */
export function isBotChallengePage(html: string): boolean {
  const head = html.slice(0, 50_000).toLowerCase();
  return BOT_CHALLENGE_MARKERS.some((marker) => head.includes(marker));
}

/** Recursively collect long human-readable strings from parsed JSON. */
function collectLongStrings(
  value: unknown,
  out: string[],
  depth: number,
): void {
  if (depth > 12 || out.length >= 100) return;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length >= 80) out.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectLongStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value))
      collectLongStrings(item, out, depth + 1);
  }
}

function parseJsonScript(block: string): unknown | null {
  try {
    return JSON.parse(block);
  } catch {
    return null;
  }
}

/**
 * Extract readable text embedded in the page's structured data, for pages
 * whose visible body is rendered client-side (so plain HTML extraction
 * yields nothing):
 * - `<script type="application/ld+json">` (news articles often carry the
 *   full `articleBody` here)
 * - Next.js `<script id="__NEXT_DATA__">` server-rendered props
 */
export function extractEmbeddedContent(html: string): string {
  const candidates: string[] = [];

  const ldRe =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch: RegExpExecArray | null;
  while ((ldMatch = ldRe.exec(html)) !== null) {
    const parsed = parseJsonScript(ldMatch[1].trim());
    if (parsed) collectLongStrings(parsed, candidates, 0);
  }

  const nextMatch = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (nextMatch) {
    const parsed = parseJsonScript(nextMatch[1].trim());
    if (parsed) collectLongStrings(parsed, candidates, 0);
  }

  // Fields often contain HTML fragments; strip tags, then keep the longest
  // unique texts (body first, short metadata last).
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const candidate of candidates) {
    const text = stripHtml(candidate).trim();
    if (text.length < 80 || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  texts.sort((a, b) => b.length - a.length);
  return texts.slice(0, 5).join("\n\n").trim();
}
