export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Accept only ordinary credential-free HTTP(S) URLs for search results and
 * source cards. Returns a canonical URL string or null when unsafe/invalid.
 */
export function normalizeExternalHttpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
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
  /最新|きょう|今日|昨日|明日|ニュース|天気|気温|株価|為替|円安|円高|選挙|速報|発売|リリース|試合結果|スコア|開場|いまの|今の|現在の|202[5-9]年|\b(today|tonight|latest|breaking|news|weather|price|who won|current|released?)\b/i;
const SMALLTALK_RE = /^(こんにちは|おはよう|こんばんは|ありがとう|よろしく|hello|hi|hey)[\s!！。．]*$/i;

/** Cheap, model-free search decision so a slow judge LLM cannot skip the web. */
export function inferSearchQuery(text: string): { needed: boolean; query: string } {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed || SMALLTALK_RE.test(trimmed)) return { needed: false, query: "" };
  if (/^https?:\/\/\S+$/i.test(trimmed)) return { needed: false, query: "" };
  const query = trimmed.slice(0, 80);
  return { needed: STRONG_SEARCH_RE.test(trimmed), query };
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
    results.push({ title: stripHtml(title) || url, url, snippet: stripHtml(snippet) });
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
