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
  "ameblo",
  "blog.livedoor",
  " plaza.rakuten",
  "fc2.com",
]);

function domainScore(url: string): number {
  const lower = url.toLowerCase();
  let score = 0;
  for (const domain of AUTHORITY_DOMAINS) {
    if (lower.includes(domain)) {
      score += 8;
      break;
    }
  }
  for (const domain of LOW_QUALITY_DOMAINS) {
    if (lower.includes(domain)) {
      score -= 6;
      break;
    }
  }
  return score;
}

function recencyScore(text: string): number {
  const combined = `${text}`;
  // Year 2024-2099
  if (/\b20(2[4-9]|[3-9]\d)\b/.test(combined)) return 4;
  // Japanese date patterns
  if (/[0-9]{1,2}月[0-9]{1,2}日/.test(combined)) return 3;
  // Relative time words
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
