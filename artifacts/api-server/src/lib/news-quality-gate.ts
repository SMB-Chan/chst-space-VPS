import { normalizeExternalHttpUrl, type SearchResult } from "./search-parse";
export {
  buildNewsFastPathQueries,
  buildNewsSearchCircuit,
  isNewsFastPathQuestion,
  type NewsSearchCircuit,
  type NewsSearchCircuitMode,
  type NewsSearchTemporalScope,
} from "./news-search-circuit";
import type {
  NewsSearchCircuit,
  NewsSearchCircuitMode,
  NewsSearchTemporalScope,
} from "./news-search-circuit";

export type NewsQuality = "good" | "partial" | "poor";
export type TaskSuccess = "succeeded" | "failed" | "unknown";
const NEWS_QUERY_REPORT_LIMIT = 4;
/** Weighted relevance below this never reaches the LLM context. */
const RELEVANCE_ACCEPT_THRESHOLD = 0.38;
/** Filter-stage provisional temporal score when publishedAt is still unknown. */
const PROVISIONAL_TEMPORAL_SCORE = 0.42;

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
      | "missing-date"
      | "low-relevance";
  }>;
}

/** Question / circuit context used by the semantic relevance gate. */
export interface NewsRelevanceContext {
  question?: string;
  dateAnchor?: string;
  topic?: string;
  temporalScope?: NewsSearchTemporalScope;
  mode?: NewsSearchCircuitMode;
}

export function newsRelevanceContextFromCircuit(
  circuit: Pick<
    NewsSearchCircuit,
    "dateAnchor" | "topic" | "temporalScope" | "mode"
  >,
  question?: string,
): NewsRelevanceContext {
  return {
    ...(question ? { question } : {}),
    dateAnchor: circuit.dateAnchor,
    ...(circuit.topic ? { topic: circuit.topic } : {}),
    temporalScope: circuit.temporalScope,
    mode: circuit.mode,
  };
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
        .slice(0, NEWS_QUERY_REPORT_LIMIT)
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

const ENCYCLOPEDIC_HOSTS = new Set([
  "wikipedia.org",
  "wikimedia.org",
  "wikidata.org",
  "britannica.com",
  "fandom.com",
  "wikiwand.com",
]);

const NEWS_TERMS =
  /ニュース|速報|報道|発表|声明|会見|最新|breaking|news|update|report|statement|press/i;
const ERROR_TERMS =
  /404|not found|page not found|error|access denied|forbidden|unavailable|server error|something went wrong|エラー|見つかりません|アクセスできません/i;
const PRODUCT_TERMS =
  /商品|価格|円|税込|カート|購入|product|price|buy now|add to cart|meesho|amazon|ebay/i;
const REFERENCE_PATH_RE =
  /\/(?:wiki|wiktionary|timeline|history|encyclop(?:a|e)dia|outline_of|list_of|portal:|category:)/i;
const NEWS_PATH_RE =
  /\/(?:news|article|articles|story|stories|press|報道|速報|記事)\b/i;
const HEADLINE_GEO_RE =
  /日本|国内|東京|大阪|首相|官邸|日銀|自民|防衛|japan|tokyo|osaka|japanese|nikkei|nhk/i;
const ENCYCLOPEDIC_TOPIC_RE =
  /(?:の歴史|年表|概要|一覧|一覧表|ワールドカップ|world cup|fifa|history of|timeline of|list of|overview of|encyclopedia)/i;

export interface NewsRelevanceScores {
  temporal: number;
  topic: number;
  publisher: number;
  newsLikeness: number;
  combined: number;
}

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

function isGoogleNewsWrapperUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.toLowerCase() === "news.google.com" &&
      /^\/rss\/articles\//i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
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

function resultText(result: SearchResult): string {
  return `${result.title} ${result.snippet ?? ""}`;
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
      isGoogleNewsWrapperUrl(result.url)
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
  const titleAndSnippet = resultText(result);
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

function isEncyclopedicHost(host: string | null): boolean {
  if (!host) return false;
  return matchesKnownHost(host, ENCYCLOPEDIC_HOSTS);
}

function hasNewsLikePath(result: SearchResult): boolean {
  try {
    const path = new URL(evidenceUrl(result)).pathname;
    return (
      NEWS_PATH_RE.test(path) || /\/20\d{2}\/\d{1,2}\/\d{1,2}\b/.test(path)
    );
  } catch {
    return false;
  }
}

function hasReferencePath(result: SearchResult): boolean {
  try {
    const path = new URL(evidenceUrl(result)).pathname;
    return REFERENCE_PATH_RE.test(path);
  } catch {
    return false;
  }
}

function isRecognizedPublisher(result: SearchResult): boolean {
  const host = evidenceHostOf(result);
  return host ? matchesKnownHost(host, MAJOR_OR_OFFICIAL_HOSTS) : false;
}

/**
 * Structural news-likeness: encyclopedias, timelines, and bare "article-shaped"
 * paths no longer count as news by themselves.
 */
function isPseudoNewsPage(result: SearchResult): boolean {
  const host = evidenceHostOf(result) ?? hostOf(result.url);
  if (isEncyclopedicHost(host) || hasReferencePath(result)) return true;
  const text = resultText(result);
  if (
    ENCYCLOPEDIC_TOPIC_RE.test(text) &&
    !NEWS_TERMS.test(text) &&
    !isRecognizedPublisher(result) &&
    !hasNewsLikePath(result)
  ) {
    return true;
  }
  return false;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function tokenizeRelevance(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function topicOverlap(result: SearchResult, topic: string): number {
  const topicTokens = tokenizeRelevance(topic);
  if (topicTokens.length === 0) return 0.5;
  const haystack = new Set(
    tokenizeRelevance(`${resultText(result)} ${evidenceUrl(result)}`),
  );
  let hits = 0;
  for (const token of topicTokens) {
    if (haystack.has(token)) hits += 1;
  }
  return clamp01(hits / topicTokens.length);
}

function calendarDayDiff(a: string, b: string): number | null {
  const left = Date.parse(`${a}T00:00:00.000Z`);
  const right = Date.parse(`${b}T00:00:00.000Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round((left - right) / 86_400_000);
}

function temporalMatchScore(
  result: SearchResult,
  context: NewsRelevanceContext | undefined,
  options: { allowMissingDate: boolean },
): number {
  if (!context?.dateAnchor) {
    return options.allowMissingDate ? PROVISIONAL_TEMPORAL_SCORE : 0.5;
  }
  if (!result.publishedAt) {
    return options.allowMissingDate ? PROVISIONAL_TEMPORAL_SCORE : 0.15;
  }
  const publishedDay = result.publishedAt.slice(0, 10);
  const diff = calendarDayDiff(publishedDay, context.dateAnchor);
  if (diff === null) return 0.2;
  if (diff === 0) return 1;
  if (Math.abs(diff) <= 1) return 0.85;
  if (context.temporalScope === "current" && Math.abs(diff) <= 3) return 0.7;
  if (Math.abs(diff) <= 7) return 0.45;
  return 0.1;
}

function topicMatchScore(
  result: SearchResult,
  context: NewsRelevanceContext | undefined,
): number {
  if (!context) return 0.5;
  if (context.mode === "topic" && context.topic) {
    return topicOverlap(result, context.topic);
  }

  // Broad headline prompts: prefer domestic / major-news signals and demote
  // clearly encyclopedic subjects that are unrelated to current headlines.
  const text = resultText(result);
  if (isPseudoNewsPage(result)) return 0.1;
  if (isRecognizedPublisher(result) || HEADLINE_GEO_RE.test(text)) return 0.78;
  if (NEWS_TERMS.test(text)) return 0.62;
  if (ENCYCLOPEDIC_TOPIC_RE.test(text)) return 0.18;
  return 0.45;
}

function publisherConfidenceScore(result: SearchResult): number {
  if (isRecognizedPublisher(result)) return 1;
  if (
    hostOf(result.url) === "news.google.com" &&
    result.publisherUrl &&
    isGoogleNewsWrapperUrl(result.url)
  ) {
    const publisherHost = hostOf(result.publisherUrl);
    if (
      publisherHost &&
      matchesKnownHost(publisherHost, MAJOR_OR_OFFICIAL_HOSTS)
    ) {
      return 0.95;
    }
    return 0.72;
  }
  if (isEncyclopedicHost(evidenceHostOf(result) ?? hostOf(result.url))) {
    return 0.05;
  }
  if (hasNewsLikePath(result) || NEWS_TERMS.test(resultText(result))) {
    return 0.55;
  }
  return 0.35;
}

function newsLikenessScore(result: SearchResult): number {
  if (isPseudoNewsPage(result)) return 0.05;
  if (isRecognizedPublisher(result)) return 0.95;
  if (NEWS_TERMS.test(resultText(result))) return 0.8;
  if (hasNewsLikePath(result)) return 0.7;
  // Bare article-shaped paths are weak evidence of news-likeness.
  try {
    const path = new URL(evidenceUrl(result)).pathname;
    if (path.length > 1 && !/\/(search|results|top|home)\/?$/i.test(path)) {
      return 0.28;
    }
  } catch {
    return 0.1;
  }
  return 0.15;
}

/**
 * Independent semantic relevance: temporal × topic × publisher × news-likeness.
 * Combined score is the geometric mean so one strong dimension cannot fully
 * rescue three weak ones (e.g. a dated encyclopedia page).
 */
export function scoreNewsRelevance(
  result: SearchResult,
  context?: NewsRelevanceContext,
  options?: { allowMissingDate?: boolean },
): NewsRelevanceScores {
  const allowMissingDate = options?.allowMissingDate ?? false;
  const temporal = temporalMatchScore(result, context, { allowMissingDate });
  const topic = topicMatchScore(result, context);
  const publisher = publisherConfidenceScore(result);
  const newsLikeness = newsLikenessScore(result);
  const dims = [temporal, topic, publisher, newsLikeness];
  let combined = dims.every((dim) => dim > 0)
    ? clamp01(dims.reduce((product, dim) => product * dim, 1) ** 0.25)
    : 0;
  // Topic-mode queries require tangible subject overlap before page fetch /
  // LLM context; otherwise general "news-shaped" pages leak through.
  if (context?.mode === "topic" && context.topic && topic < 0.2) {
    combined = Math.min(combined, topic);
  }
  return { temporal, topic, publisher, newsLikeness, combined };
}

function rejectionReason(
  result: SearchResult,
  context: NewsRelevanceContext | undefined,
  options: { allowMissingDate: boolean },
): NewsQualityReport["rejected"][number]["reason"] | null {
  if (isSearchPage(result)) return "search-page";
  if (ERROR_TERMS.test(resultText(result))) return "error-page";
  if (isProductPage(result)) return "product-page";
  if (isPseudoNewsPage(result)) return "not-news";

  const recognizedPublisher = isRecognizedPublisher(result);
  if (
    !NEWS_TERMS.test(resultText(result)) &&
    !recognizedPublisher &&
    !hasNewsLikePath(result)
  ) {
    return "not-news";
  }

  const relevance = scoreNewsRelevance(result, context, {
    allowMissingDate: options.allowMissingDate,
  });
  if (relevance.combined < RELEVANCE_ACCEPT_THRESHOLD) {
    return "low-relevance";
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

function normalizedTitle(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function newsResultIdentities(result: SearchResult): string[] {
  const identities: string[] = [];
  const articleUrl = result.articleUrl
    ? normalizeExternalHttpUrl(result.articleUrl)
    : null;
  if (articleUrl) identities.push(`url:${articleUrl}`);

  const resultUrl = normalizeExternalHttpUrl(result.url);
  if (resultUrl) identities.push(`url:${resultUrl}`);

  const publisherHost = hostOf(result.publisherUrl ?? result.url);
  const title = normalizedTitle(result.title);
  if (publisherHost && title && !isSearchPage(result)) {
    identities.push(`publisher-title:${baseDomain(publisherHost)}:${title}`);
  }

  return identities.length > 0 ? identities : [`raw:${result.url}`];
}

export function assessNewsRetrieval(args: {
  results: SearchResult[];
  queries?: string[];
  now?: Date;
  context?: NewsRelevanceContext;
}): NewsQualityReport {
  const now = args.now ?? new Date();
  const accepted: SearchResult[] = [];
  const rejected: NewsQualityReport["rejected"] = [];
  const seenUrls = new Set<string>();

  for (const result of args.results) {
    const identities = newsResultIdentities(result);
    if (identities.some((identity) => seenUrls.has(identity))) continue;
    for (const identity of identities) seenUrls.add(identity);
    const reason = rejectionReason(result, args.context, {
      allowMissingDate: false,
    });
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
    fresh
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
export function filterNewsResults(
  results: SearchResult[],
  context?: NewsRelevanceContext,
): SearchResult[] {
  // A normal search result may not expose its publication date until its page
  // is fetched. Keep that candidate for the bounded page-fetch stage when the
  // rest of the semantic gate already looks news-relevant; the final
  // assessment still rejects it if no date can be recovered.
  return results.filter((result) => {
    const reason = rejectionReason(result, context, { allowMissingDate: true });
    return reason === null || reason === "missing-date";
  });
}
