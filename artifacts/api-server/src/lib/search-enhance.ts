import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { stripHtml, type SearchResult } from "./search-parse";

/** Number of top-scored results whose pages are fetched for full-text context. */
export const FETCH_TOP_N = 3;
/** Maximum results to return from a merged search. */
export const MAX_MERGED_RESULTS = 6;

/** Normalize a query for cache keys and comparison. */
export function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/[\s　]+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
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

  const hasLatest = /最新|latest|current|now|きょう|今日|現在/i.test(normalized);
  const hasNews = /ニュース|news|速報|headlines?/i.test(normalized);
  const hasJapanese = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(normalized);

  // Only add angle variants when the query does not already contain them.
  if (!hasLatest && !hasNews) {
    variants.add(hasJapanese ? `${normalized} 最新` : `${normalized} latest`);
    if (hasJapanese) {
      variants.add(`${normalized} ニュース`);
    }
  }

  return Array.from(variants).slice(0, 3);
}

const AUTHORITY_DOMAINS = new Set([
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
    return normalizedHost === normalizedIndicator || normalizedHost.endsWith(`.${normalizedIndicator}`);
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

function recencyScore(text: string, now = new Date()): number {
  const combined = `${text}`;
  const currentYear = now.getUTCFullYear();
  const previousYear = currentYear - 1;
  const years = Array.from(combined.matchAll(/\b(20\d{2})\b/g), (match) => Number(match[1]));
  if (years.includes(currentYear)) return 4;
  if (years.includes(previousYear)) return 2;
  // Japanese date patterns.  Without a year this is only a modest signal.
  if (/[0-9]{1,2}月[0-9]{1,2}日/.test(combined)) return 2;
  // Relative time words.
  if (/今週|先週|今月|先月|最近|昨日|今日|きょう|this week|last week|today|yesterday/i.test(combined)) {
    return 2;
  }
  return 0;
}

/** Score a search result for relevance to the original query. */
export function scoreSearchResult(result: SearchResult, originalQuery: string): number {
  const query = originalQuery.toLowerCase();
  const title = result.title.toLowerCase();
  const snippet = result.snippet.toLowerCase();
  const combined = `${title} ${snippet}`;

  let score = 0;

  // Exact/partial title match is the strongest signal.
  if (title.includes(query)) score += 12;
  else if (title.split(/\s+/).some((w) => query.includes(w) && w.length > 1)) score += 6;

  // Snippet match.
  if (snippet.includes(query)) score += 6;

  // Word overlap.
  const queryWords = query.split(/\s+/).filter((w) => w.length > 1);
  const matchedWords = queryWords.filter((w) => combined.includes(w));
  score += matchedWords.length * 2;

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

/**
 * Merge results from multiple queries, deduplicate by URL, score, and return
 * the top results sorted by relevance.
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

  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, maxResults);
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
function collectLongStrings(value: unknown, out: string[], depth: number): void {
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
    for (const item of Object.values(value)) collectLongStrings(item, out, depth + 1);
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

  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
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
