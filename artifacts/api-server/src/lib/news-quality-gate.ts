import type { SearchResult } from "./search-parse";
export {
  buildNewsFastPathQueries,
  buildNewsSearchCircuit,
  isNewsFastPathQuestion,
  type NewsSearchCircuit,
  type NewsSearchCircuitMode,
  type NewsSearchTemporalScope,
} from "./news-search-circuit";

export type NewsQuality = "good" | "partial" | "poor";
export type TaskSuccess = "succeeded" | "failed" | "unknown";

export interface NewsQualityReport {
  kind: "news";
  quality: NewsQuality;
  taskSuccess: TaskSuccess;
  acceptedSourceCount: number;
  freshSourceCount: number;
  independentDomainCount: number;
  officialOrMajorSourceCount: number;
  queries: string[];
  rejected: Array<{
    title: string;
    url: string;
    reason:
      | "search-page"
      | "error-page"
      | "product-page"
      | "not-news"
      | "missing-date";
  }>;
}

export function normalizeNewsQualityReport(
  value: unknown,
): NewsQualityReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.kind !== "news" ||
    (raw.quality !== "good" &&
      raw.quality !== "partial" &&
      raw.quality !== "poor") ||
    (raw.taskSuccess !== "succeeded" &&
      raw.taskSuccess !== "failed" &&
      raw.taskSuccess !== "unknown")
  ) {
    return null;
  }
  const boundedCount = (input: unknown) =>
    typeof input === "number" && Number.isSafeInteger(input)
      ? Math.max(0, Math.min(input, 100))
      : 0;
  const queries = Array.isArray(raw.queries)
    ? raw.queries
        .filter((query): query is string => typeof query === "string")
        .map((query) => query.slice(0, 240))
        .slice(0, 3)
    : [];
  return {
    kind: "news",
    quality: raw.quality,
    taskSuccess: raw.taskSuccess,
    acceptedSourceCount: boundedCount(raw.acceptedSourceCount),
    freshSourceCount: boundedCount(raw.freshSourceCount),
    independentDomainCount: boundedCount(raw.independentDomainCount),
    officialOrMajorSourceCount: boundedCount(raw.officialOrMajorSourceCount),
    queries,
    rejected: [],
  };
}

const SEARCH_HOSTS = new Set([
  "www.google.com",
  "google.com",
  "news.google.com",
  "www.bing.com",
  "bing.com",
  "duckduckgo.com",
  "www.duckduckgo.com",
  "search.yahoo.com",
]);

const MAJOR_OR_OFFICIAL_HOSTS = new Set([
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "nhk.or.jp",
  "nikkei.com",
  "asahi.com",
  "yomiuri.co.jp",
  "mainichi.jp",
  "jiji.com",
  "kyodonews.net",
  "npr.org",
  "theguardian.com",
  "whitehouse.gov",
  "gov.uk",
  "mofa.go.jp",
]);

const NEWS_TERMS =
  /ニュース|速報|報道|発表|声明|会見|最新|breaking|news|update|report|statement|press/i;
const ERROR_TERMS =
  /404|not found|page not found|error|access denied|forbidden|unavailable|server error|something went wrong|エラー|見つかりません|アクセスできません/i;
const PRODUCT_TERMS =
  /商品|価格|円|税込|カート|購入|product|price|buy now|add to cart|meesho|amazon|ebay/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function evidenceUrl(result: SearchResult): string {
  return result.articleUrl || result.publisherUrl || result.url;
}

function evidenceHostOf(result: SearchResult): string | null {
  return hostOf(evidenceUrl(result));
}

function matchesKnownHost(
  host: string,
  knownHosts: ReadonlySet<string>,
): boolean {
  for (const known of knownHosts) {
    if (host === known || host.endsWith(`.${known}`)) return true;
  }
  return false;
}

function baseDomain(host: string): string {
  const parts = host.split(".");
  const suffix = parts.slice(-2).join(".");
  const secondLevelSuffixes = new Set([
    "co.uk",
    "co.jp",
    "com.au",
    "co.nz",
    "co.in",
    "com.br",
  ]);
  return parts.length > 2 && secondLevelSuffixes.has(suffix)
    ? parts.slice(-3).join(".")
    : parts.length > 2
      ? parts.slice(-2).join(".")
      : host;
}

function isSearchPage(result: SearchResult): boolean {
  const host = hostOf(result.url);
  if (!host) return true;
  if (SEARCH_HOSTS.has(host)) {
    // Google News RSS uses /rss/articles/* wrapper URLs. They are not useful
    // as article URLs by themselves, but a normalized <source url> identifies
    // the publisher and makes the RSS item usable evidence.
    if (
      host === "news.google.com" &&
      result.publisherUrl &&
      /^\/rss\/articles\//i.test(new URL(result.url).pathname)
    ) {
      return false;
    }
    return true;
  }
  try {
    const url = new URL(result.url);
    return (
      url.pathname === "" ||
      url.pathname === "/" ||
      /\/(search|results|search-results|top|home)\/?$/i.test(url.pathname) ||
      /(?:^|[?&])(q|query|search|keyword)=/i.test(url.search)
    );
  } catch {
    return true;
  }
}

function isProductPage(result: SearchResult): boolean {
  const titleAndSnippet = `${result.title} ${result.snippet ?? ""}`;
  if (PRODUCT_TERMS.test(titleAndSnippet) && !NEWS_TERMS.test(result.title)) {
    return true;
  }
  try {
    const path = new URL(result.articleUrl || result.url).pathname;
    return /\/(products?|items?|p|cart|checkout|buy)\b/i.test(path);
  } catch {
    return true;
  }
}

function hasArticlePath(result: SearchResult): boolean {
  try {
    const path = new URL(result.url).pathname;
    return path.length > 1 && !/\/(search|results|top|home)\/?$/i.test(path);
  } catch {
    return false;
  }
}

function rejectionReason(
  result: SearchResult,
): NewsQualityReport["rejected"][number]["reason"] | null {
  if (isSearchPage(result)) return "search-page";
  if (ERROR_TERMS.test(`${result.title} ${result.snippet ?? ""}`)) {
    return "error-page";
  }
  if (isProductPage(result)) return "product-page";
  const host = evidenceHostOf(result);
  const recognizedPublisher = host
    ? matchesKnownHost(host, MAJOR_OR_OFFICIAL_HOSTS)
    : false;
  if (
    !NEWS_TERMS.test(`${result.title} ${result.snippet ?? ""}`) &&
    !recognizedPublisher &&
    !hasArticlePath(result)
  ) {
    return "not-news";
  }
  if (!result.publishedAt) return "missing-date";
  return null;
}

function isFresh(publishedAt: string, now: Date, maxAgeDays = 7): boolean {
  const timestamp = Date.parse(publishedAt);
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = now.getTime() - timestamp;
  return ageMs >= -86_400_000 && ageMs <= maxAgeDays * 86_400_000;
}

export function assessNewsRetrieval(args: {
  results: SearchResult[];
  queries?: string[];
  now?: Date;
}): NewsQualityReport {
  const now = args.now ?? new Date();
  const accepted: SearchResult[] = [];
  const rejected: NewsQualityReport["rejected"] = [];
  const seenUrls = new Set<string>();

  for (const result of args.results) {
    const identity = result.articleUrl || result.url;
    if (seenUrls.has(identity)) continue;
    seenUrls.add(identity);
    const reason = rejectionReason(result);
    if (reason) {
      rejected.push({ title: result.title, url: result.url, reason });
      continue;
    }
    accepted.push(result);
  }

  const fresh = accepted.filter((result) =>
    result.publishedAt ? isFresh(result.publishedAt, now) : false,
  );
  const domains = new Set(
    accepted
      .map((result) => evidenceHostOf(result))
      .filter((host): host is string => Boolean(host))
      .map(baseDomain),
  );
  const officialOrMajorSourceCount = accepted.filter((result) => {
    const host = evidenceHostOf(result);
    return host ? matchesKnownHost(host, MAJOR_OR_OFFICIAL_HOSTS) : false;
  }).length;

  const quality: NewsQuality =
    fresh.length >= 2 && domains.size >= 2 && accepted.length >= 2
      ? "good"
      : accepted.length > 0
        ? "partial"
        : "poor";

  return {
    kind: "news",
    quality,
    taskSuccess: quality === "good" ? "succeeded" : "failed",
    acceptedSourceCount: accepted.length,
    freshSourceCount: fresh.length,
    independentDomainCount: domains.size,
    officialOrMajorSourceCount,
    queries: args.queries ?? [],
    rejected,
  };
}

/**
 * Keep only sources that can become news evidence. The full assessment still
 * runs over the retained set so rejected search portals and error pages cannot
 * inflate domain or freshness coverage.
 */
export function filterNewsResults(results: SearchResult[]): SearchResult[] {
  // A normal search result may not expose its publication date until its page
  // is fetched. Keep that candidate for the bounded page-fetch stage; the
  // final assessment still rejects it if no date can be recovered.
  return results.filter((result) => {
    const reason = rejectionReason(result);
    return reason === null || reason === "missing-date";
  });
}
