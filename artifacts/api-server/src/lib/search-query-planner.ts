import {
  classifySearchIntent,
  normalizeQuery,
  sanitizeSearchQuery,
} from "./search-enhance";

export type SearchSubqueryRole =
  | "primary"
  | "official"
  | "freshness"
  | "research"
  | "technical"
  | "cross_language";

export interface SearchSubquery {
  query: string;
  role: SearchSubqueryRole;
  weight: number;
}

export interface SearchQueryPlan {
  originalQuery: string;
  queries: SearchSubquery[];
  maxQueries: number;
}

export interface SearchQueryPlannerOptions {
  /** Optional LLM/planner-provided variants. They are still sanitized and capped. */
  suggestedQueries?: Array<{
    query: string;
    role?: Exclude<SearchSubqueryRole, "primary">;
  }>;
  maxQueries?: number;
}

const DEFAULT_MAX_PLAN_QUERIES = 3;
const HARD_MAX_PLAN_QUERIES = 4;

const JAPANESE_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const FRESHNESS_RE =
  /最新|現在|今日|今週|今月|速報|直近|recent|latest|current|today|this week|breaking/i;
const HISTORICAL_RE =
  /過去|以前|当時|歴史|昨年|去年|先月|先週|\d+年前|historical|history|previous|last year|ago/i;
const RESEARCH_RE =
  /論文|研究|査読|学術|プレプリント|arxiv|paper|papers|study|studies|research|preprint|benchmark/i;
const TECHNICAL_RE =
  /github|リポジトリ|repository|repo\b|oss\b|open source|ソースコード|source code|api\b|sdk\b|library|ライブラリ|framework|フレームワーク/i;
const OFFICIAL_RE =
  /公式|一次資料|一次情報|原文|官公庁|省庁|規則|規制|法令|法律|仕様書|standard|official|primary source|government|regulation|law\b/i;

function boundedMaxQueries(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_MAX_PLAN_QUERIES;
  }
  return Math.min(HARD_MAX_PLAN_QUERIES, Math.max(1, Math.floor(requested)));
}

function compactComparable(query: string): string {
  return normalizeQuery(query).replace(/\s+/g, "");
}

function isNearDuplicate(
  candidate: SearchSubquery,
  existing: SearchSubquery,
): boolean {
  if (candidate.role !== existing.role) return false;
  const left = compactComparable(candidate.query);
  const right = compactComparable(existing.query);
  if (!left || !right) return true;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  return longer.includes(shorter) && shorter.length / longer.length >= 0.9;
}

function weightedRole(role: SearchSubqueryRole): number {
  switch (role) {
    case "primary":
      return 1.2;
    case "official":
      return 1.1;
    case "research":
    case "technical":
      return 1.05;
    case "freshness":
    case "cross_language":
      return 1;
  }
}

function addCandidate(
  target: SearchSubquery[],
  rawQuery: string,
  role: SearchSubqueryRole,
  maxQueries: number,
): void {
  if (target.length >= maxQueries) return;
  const query = sanitizeSearchQuery(rawQuery);
  if (!query) return;
  const candidate: SearchSubquery = {
    query,
    role,
    weight: weightedRole(role),
  };
  if (target.some((item) => isNearDuplicate(candidate, item))) return;
  if (
    target.some((item) => normalizeQuery(item.query) === normalizeQuery(query))
  ) {
    return;
  }
  target.push(candidate);
}

function officialVariant(base: string, isJapanese: boolean): string | null {
  if (OFFICIAL_RE.test(base)) return null;
  if (/天気|天候|気象|weather|forecast/i.test(base)) {
    return isJapanese ? `${base} 気象庁` : `${base} official weather service`;
  }
  if (/法律|法令|規制|規則|制度|law\b|regulation/i.test(base)) {
    return isJapanese ? `${base} site:go.jp` : `${base} official government`;
  }
  return null;
}

/**
 * Deterministic, bounded query planning used after the conversation-aware LLM
 * has selected the base search query. The original sanitized query is always
 * first. Supplemental angles are added only when the query itself indicates a
 * useful distinct retrieval path. Optional LLM-provided variants are treated
 * as untrusted input and pass through the same sanitizer and hard cap.
 */
export function planSearchQueries(
  rawQuery: string,
  options: SearchQueryPlannerOptions = {},
): SearchQueryPlan {
  const originalQuery = sanitizeSearchQuery(rawQuery);
  const maxQueries = boundedMaxQueries(options.maxQueries);
  if (!originalQuery) {
    return { originalQuery: "", queries: [], maxQueries };
  }

  const queries: SearchSubquery[] = [];
  addCandidate(queries, originalQuery, "primary", maxQueries);

  const isJapanese = JAPANESE_RE.test(originalQuery);
  const intent = classifySearchIntent(originalQuery);
  const historical = HISTORICAL_RE.test(originalQuery);

  const official = officialVariant(originalQuery, isJapanese);
  if (official) addCandidate(queries, official, "official", maxQueries);

  if (
    queries.length < maxQueries &&
    !historical &&
    (intent === "news" ||
      intent === "finance" ||
      FRESHNESS_RE.test(originalQuery)) &&
    !/最新|latest|速報|breaking/i.test(originalQuery)
  ) {
    addCandidate(
      queries,
      isJapanese ? `${originalQuery} 最新` : `${originalQuery} latest`,
      "freshness",
      maxQueries,
    );
  }

  if (queries.length < maxQueries && RESEARCH_RE.test(originalQuery)) {
    addCandidate(
      queries,
      `${originalQuery} arXiv paper`,
      "research",
      maxQueries,
    );
  }

  if (queries.length < maxQueries && TECHNICAL_RE.test(originalQuery)) {
    addCandidate(
      queries,
      `${originalQuery} GitHub documentation`,
      "technical",
      maxQueries,
    );
  }

  for (const suggested of options.suggestedQueries ?? []) {
    if (queries.length >= maxQueries) break;
    addCandidate(
      queries,
      suggested.query,
      suggested.role ?? "cross_language",
      maxQueries,
    );
  }

  return { originalQuery, queries, maxQueries };
}
