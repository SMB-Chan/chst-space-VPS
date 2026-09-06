import type { FactualitySource } from "./factuality";
import { sanitizeSearchQuery } from "./search-enhance";
import type { SpecialistToolCall } from "./specialist-capabilities";

export type ResearchDepth = "quick" | "standard" | "deep";

export interface ResearchDepthPolicy {
  depth: ResearchDepth;
  maxSteps: number;
  maxToolCalls: number;
  maxForcedGapRounds: number;
  minSources: number;
  minDomains: number;
  minFetchedPages: number;
  minSearches: number;
}

export interface ResearchCoverage {
  sourceCount: number;
  domainCount: number;
  successfulSearches: number;
  fetchedPages: number;
}

const DEEP_RE =
  /(徹底|詳細|詳しく|深掘|掘り下|調査|分析|比較|検証|研究|論文|根拠|一次資料|背景|原因|影響|問題点|課題|論点|実態|動向|なぜ|どうして|評価|監査|総合的|包括的|deep\s*(?:research|dive)|thorough|comprehensive|research|analy[sz]e|comparison|compare|evidence|paper|study|background|impact|risk|critique|audit)/i;
const QUICK_RE =
  /(天気|気温|時刻|何時|営業時間|住所|電話番号|為替|株価|価格|いつ|どこ|誰|weather|time|opening hours|address|phone|exchange rate|price)/i;

function countQuestionMarkers(text: string): number {
  return (text.match(/[?？]/g) ?? []).length;
}

export function classifyResearchDepth(question: string): ResearchDepth {
  const normalized = question.replace(/\s+/g, " ").trim();
  if (!normalized) return "standard";
  if (
    DEEP_RE.test(normalized) ||
    normalized.length >= 160 ||
    countQuestionMarkers(normalized) >= 2
  ) {
    return "deep";
  }
  if (normalized.length <= 70 && QUICK_RE.test(normalized)) return "quick";
  return "standard";
}

export function researchDepthPolicy(question: string): ResearchDepthPolicy {
  const depth = classifyResearchDepth(question);
  if (depth === "quick") {
    return {
      depth,
      maxSteps: 3,
      maxToolCalls: 3,
      maxForcedGapRounds: 0,
      minSources: 1,
      minDomains: 1,
      minFetchedPages: 0,
      minSearches: 1,
    };
  }
  if (depth === "deep") {
    return {
      depth,
      maxSteps: 6,
      maxToolCalls: 12,
      maxForcedGapRounds: 3,
      minSources: 6,
      minDomains: 3,
      minFetchedPages: 2,
      minSearches: 2,
    };
  }
  return {
    depth,
    maxSteps: 6,
    maxToolCalls: 12,
    maxForcedGapRounds: 1,
    minSources: 3,
    minDomains: 2,
    minFetchedPages: 0,
    minSearches: 1,
  };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function researchCoverage(args: {
  sources: FactualitySource[];
  successfulSearches: number;
  fetchedPages: number;
}): ResearchCoverage {
  return {
    sourceCount: args.sources.length,
    domainCount: new Set(
      args.sources.map((source) => domainOf(source.url)).filter(Boolean),
    ).size,
    successfulSearches: Math.max(0, args.successfulSearches),
    fetchedPages: Math.max(0, args.fetchedPages),
  };
}

export function hasSufficientResearchCoverage(
  policy: ResearchDepthPolicy,
  coverage: ResearchCoverage,
): boolean {
  return (
    coverage.sourceCount >= policy.minSources &&
    coverage.domainCount >= policy.minDomains &&
    coverage.successfulSearches >= policy.minSearches &&
    coverage.fetchedPages >= policy.minFetchedPages
  );
}

export function describeResearchGaps(
  policy: ResearchDepthPolicy,
  coverage: ResearchCoverage,
): string[] {
  const gaps: string[] = [];
  if (coverage.sourceCount < policy.minSources) {
    gaps.push(`情報源 ${coverage.sourceCount}/${policy.minSources}`);
  }
  if (coverage.domainCount < policy.minDomains) {
    gaps.push(`独立ドメイン ${coverage.domainCount}/${policy.minDomains}`);
  }
  if (coverage.successfulSearches < policy.minSearches) {
    gaps.push(`検索角度 ${coverage.successfulSearches}/${policy.minSearches}`);
  }
  if (coverage.fetchedPages < policy.minFetchedPages) {
    gaps.push(`本文取得 ${coverage.fetchedPages}/${policy.minFetchedPages}`);
  }
  return gaps;
}

export function buildResearchGapInstruction(
  policy: ResearchDepthPolicy,
  coverage: ResearchCoverage,
): string {
  const gaps = describeResearchGaps(policy, coverage);
  if (gaps.length === 0) return "証拠充足条件を満たしています。";
  return `調査はまだ不十分です（${gaps.join("、")}）。この段階では最終回答を書かず、未充足の論点を埋める web_search または fetch_page を呼び出してください。Deep調査では、検索スニペットだけで断定せず、重要な一次資料・公式資料・反証または例外も確認してください。`;
}

function safeQuery(question: string, suffix: string): string {
  const room = Math.max(1, 500 - suffix.length - 1);
  return sanitizeSearchQuery(`${question.slice(0, room)} ${suffix}`);
}

export function selectDeepPageFetches(args: {
  sources: FactualitySource[];
  fetchedUrls: ReadonlySet<string>;
  remainingToolCalls: number;
  limit?: number;
}): SpecialistToolCall[] {
  const limit = Math.min(
    Math.max(0, args.limit ?? 2),
    Math.max(0, args.remainingToolCalls),
  );
  if (limit === 0) return [];
  const selected: FactualitySource[] = [];
  const selectedDomains = new Set<string>();
  for (const source of args.sources) {
    if (selected.length >= limit) break;
    if (args.fetchedUrls.has(source.url)) continue;
    const domain = domainOf(source.url);
    if (domain && selectedDomains.has(domain)) continue;
    selected.push(source);
    if (domain) selectedDomains.add(domain);
  }
  if (selected.length < limit) {
    for (const source of args.sources) {
      if (selected.length >= limit) break;
      if (
        args.fetchedUrls.has(source.url) ||
        selected.some((item) => item.url === source.url)
      ) {
        continue;
      }
      selected.push(source);
    }
  }
  return selected.map((source, index) => ({
    id: `research-depth-fetch-${index + 1}`,
    name: "fetch_page",
    arguments: JSON.stringify({ url: source.url }),
  }));
}

export function buildForcedGapSearch(args: {
  question: string;
  coverage: ResearchCoverage;
  forcedRound: number;
  seenQueries: ReadonlySet<string>;
}): SpecialistToolCall | undefined {
  const suffixes = [
    "公式 一次資料 根拠",
    "反対意見 批判 問題点 例外",
    "最新 動向 更新",
  ];
  const preferred =
    args.coverage.successfulSearches < 2
      ? 0
      : Math.min(suffixes.length - 1, Math.max(1, args.forcedRound));
  for (let offset = 0; offset < suffixes.length; offset += 1) {
    const suffix = suffixes[(preferred + offset) % suffixes.length];
    const query = safeQuery(args.question, suffix);
    if (!query || args.seenQueries.has(query)) continue;
    return {
      id: `research-depth-gap-${args.forcedRound + 1}-${offset + 1}`,
      name: "web_search",
      arguments: JSON.stringify({ query, fetchContent: true }),
    };
  }
  return undefined;
}
