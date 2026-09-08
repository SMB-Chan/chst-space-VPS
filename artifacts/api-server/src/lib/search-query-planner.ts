import { normalizeQuery, sanitizeSearchQuery } from "./search-enhance";
import {
  buildSearchTaskProfile,
  type SearchRetrievalLane,
  type SearchTaskProfile,
} from "./search-task-profile";

export type SearchSubqueryRole =
  | "primary"
  | "official"
  | "freshness"
  | "counterevidence"
  | "comparison"
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
  taskProfile: SearchTaskProfile;
}

export interface SearchQueryPlannerOptions {
  /** Optional LLM/planner-provided variants. They are still sanitized and capped. */
  suggestedQueries?: Array<{
    query: string;
    role?: Exclude<SearchSubqueryRole, "primary">;
  }>;
  maxQueries?: number;
}

const HARD_MAX_PLAN_QUERIES = 4;

const JAPANESE_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
const OFFICIAL_QUERY_CONSTRAINT_RE =
  /(?:\bsite:[^\s]+|気象庁|官報|e-Gov|(?:公式|official)\s*(?:一次資料|一次情報|原文|発表|声明|文書|documentation|docs?)|primary\s+source|official\s+(?:government|documentation|docs?)|government\s+site)/i;
const FRESHNESS_QUERY_CONSTRAINT_RE =
  /最新|速報|現在|今日|本日|明日|今週|今月|今年|latest|breaking|current|today|tomorrow|tonight|this\s+(?:week|month|year)/i;

function boundedMaxQueries(
  requested: number | undefined,
  fallback: number,
): number {
  const value =
    requested === undefined || !Number.isFinite(requested)
      ? fallback
      : Math.floor(requested);
  return Math.min(HARD_MAX_PLAN_QUERIES, Math.max(1, value));
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
    case "counterevidence":
    case "comparison":
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
  // A user asking for "official sources" is not the same as an already
  // constrained official-source query. Suppress the lane only when the query
  // itself already targets a concrete official surface (site:, JMA, e-Gov,
  // "official docs", etc.). This keeps fact-check and research tasks from
  // falsely satisfying their primary-source requirement with a generic query.
  if (OFFICIAL_QUERY_CONSTRAINT_RE.test(base)) return null;
  if (/天気|天候|気象|weather|forecast/i.test(base)) {
    return isJapanese ? `${base} 気象庁` : `${base} official weather service`;
  }
  if (/法律|法令|規制|規則|制度|law\b|regulation/i.test(base)) {
    return isJapanese ? `${base} site:go.jp` : `${base} official government`;
  }
  return isJapanese
    ? `${base} 公式 一次資料`
    : `${base} official primary source`;
}

function laneVariant(
  lane: SearchRetrievalLane,
  base: string,
  isJapanese: boolean,
): { query: string; role: SearchSubqueryRole } | null {
  switch (lane.kind) {
    case "primary_source": {
      const query = officialVariant(base, isJapanese);
      return query ? { query, role: "official" } : null;
    }
    case "freshness":
      // Do not spend a bounded query slot merely to append "latest" when the
      // base query already carries a concrete current-time constraint such as
      // today/tomorrow/this week. The temporal signal is already available to
      // providers; a separate freshness query should represent new evidence,
      // not lexical duplication.
      if (FRESHNESS_QUERY_CONSTRAINT_RE.test(base)) return null;
      return {
        query: isJapanese ? `${base} 最新` : `${base} latest`,
        role: "freshness",
      };
    case "counterevidence":
      return {
        query: isJapanese
          ? `${base} 反証 例外 限界`
          : `${base} counterevidence exceptions limitations`,
        role: "counterevidence",
      };
    case "comparison":
      return {
        query: isJapanese
          ? `${base} 比較 benchmark`
          : `${base} comparison benchmark`,
        role: "comparison",
      };
    case "academic":
      return { query: `${base} arXiv paper`, role: "research" };
    case "technical":
      return {
        query: `${base} GitHub documentation`,
        role: "technical",
      };
    case "independent":
      // Independence is enforced by provider/result diversity rather than by
      // inventing a weaker query. Gap-directed recovery can later request a
      // different domain without perturbing the first-pass query semantics.
      return null;
  }
}

/**
 * Deterministic, bounded query planning used after the conversation-aware LLM
 * has selected the base search query. A multi-dimensional task profile keeps
 * freshness, primary-source, counterevidence, academic and technical needs
 * separate, then spends the bounded query budget on the highest-priority
 * retrieval lanes. Optional LLM-provided variants remain untrusted input and
 * pass through the same sanitizer and hard cap.
 */
export function planSearchQueries(
  rawQuery: string,
  options: SearchQueryPlannerOptions = {},
): SearchQueryPlan {
  const originalQuery = sanitizeSearchQuery(rawQuery);
  const taskProfile = buildSearchTaskProfile(originalQuery);
  const maxQueries = boundedMaxQueries(
    options.maxQueries,
    taskProfile.recommendedMaxQueries,
  );
  if (!originalQuery) {
    return { originalQuery: "", queries: [], maxQueries, taskProfile };
  }

  const queries: SearchSubquery[] = [];
  addCandidate(queries, originalQuery, "primary", maxQueries);

  const isJapanese = JAPANESE_RE.test(originalQuery);
  if (taskProfile.temporalNeed !== "historical") {
    for (const lane of taskProfile.lanes) {
      if (queries.length >= maxQueries) break;
      const variant = laneVariant(lane, originalQuery, isJapanese);
      if (!variant) continue;
      addCandidate(queries, variant.query, variant.role, maxQueries);
    }
  } else {
    for (const lane of taskProfile.lanes) {
      if (queries.length >= maxQueries) break;
      if (lane.kind === "freshness") continue;
      const variant = laneVariant(lane, originalQuery, isJapanese);
      if (!variant) continue;
      addCandidate(queries, variant.query, variant.role, maxQueries);
    }
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

  return { originalQuery, queries, maxQueries, taskProfile };
}
