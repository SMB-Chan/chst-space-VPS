import { classifySearchIntent, type SearchIntent } from "./search-enhance";

export type SearchTaskKind =
  | "lookup"
  | "latest"
  | "fact_check"
  | "comparison"
  | "research"
  | "technical"
  | "weather"
  | "finance";

export type SearchTemporalNeed =
  "realtime" | "current" | "historical" | "timeless";

export type SearchEvidenceDimension =
  | "primary_source"
  | "freshness"
  | "independence"
  | "counterevidence"
  | "academic"
  | "technical"
  | "comparison";

export type SearchRetrievalLaneKind =
  | "primary_source"
  | "freshness"
  | "counterevidence"
  | "comparison"
  | "academic"
  | "technical"
  | "independent";

export interface SearchRetrievalLane {
  kind: SearchRetrievalLaneKind;
  priority: number;
  required: boolean;
  reason: string;
}

export interface SearchTaskProfile {
  intent: SearchIntent;
  task: SearchTaskKind;
  temporalNeed: SearchTemporalNeed;
  dimensions: SearchEvidenceDimension[];
  lanes: SearchRetrievalLane[];
  recommendedMaxQueries: number;
}

const FRESH_RE =
  /最新|現在|今日|本日|今週|今月|速報|直近|リアルタイム|recent|latest|current|today|this week|breaking|real[- ]?time/i;
const REALTIME_RE =
  /現在|今|今日|本日|速報|リアルタイム|now|current|today|breaking|real[- ]?time/i;
const HISTORICAL_RE =
  /過去|以前|当時|歴史|昨年|去年|先月|先週|\d+年前|historical|history|previous|last year|ago/i;
const FACT_CHECK_RE =
  /本当|事実|正しい|真偽|検証|ファクトチェック|根拠|証拠|裏付け|verify|fact[- ]?check|is this true|correct|evidence/i;
const COMPARISON_RE =
  /比較|違い|差|対照|どちら|優れる|vs\.?|versus|compare|comparison|difference|benchmark/i;
const RESEARCH_RE =
  /論文|研究|査読|学術|プレプリント|arxiv|paper|papers|study|studies|research|preprint|benchmark/i;
const TECHNICAL_RE =
  /github|リポジトリ|repository|repo\b|oss\b|open source|ソースコード|source code|api\b|sdk\b|library|ライブラリ|framework|フレームワーク|仕様|documentation|docs\b/i;
const COUNTER_RE =
  /反証|反対意見|批判|異論|例外|限界|弱点|欠点|監査|問題点|課題|包括的|総合的|counter|critique|criticism|exception|limitation|audit|comprehensive/i;
const PRIMARY_RE =
  /公式|一次資料|一次情報|原文|官公庁|省庁|法令|規則|規制|仕様書|official|primary source|government|regulation|standard/i;

function uniqueDimensions(
  dimensions: SearchEvidenceDimension[],
): SearchEvidenceDimension[] {
  return [...new Set(dimensions)];
}

function inferTask(
  query: string,
  intent: SearchIntent,
  dimensions: SearchEvidenceDimension[],
): SearchTaskKind {
  if (intent === "weather") return "weather";
  if (intent === "finance") return "finance";
  if (FACT_CHECK_RE.test(query)) return "fact_check";
  if (COMPARISON_RE.test(query)) return "comparison";
  if (RESEARCH_RE.test(query)) return "research";
  if (TECHNICAL_RE.test(query)) return "technical";
  if (intent === "news" || dimensions.includes("freshness")) return "latest";
  return "lookup";
}

function inferTemporalNeed(
  query: string,
  intent: SearchIntent,
): SearchTemporalNeed {
  if (HISTORICAL_RE.test(query)) return "historical";
  if (intent === "weather" || intent === "finance" || REALTIME_RE.test(query)) {
    return "realtime";
  }
  if (intent === "news" || FRESH_RE.test(query)) return "current";
  return "timeless";
}

function buildLanes(
  task: SearchTaskKind,
  dimensions: SearchEvidenceDimension[],
): SearchRetrievalLane[] {
  const lanes: SearchRetrievalLane[] = [];
  const add = (
    kind: SearchRetrievalLaneKind,
    priority: number,
    required: boolean,
    reason: string,
  ) => {
    if (lanes.some((lane) => lane.kind === kind)) return;
    lanes.push({ kind, priority, required, reason });
  };

  if (dimensions.includes("primary_source")) {
    add(
      "primary_source",
      100,
      task === "fact_check" ||
        task === "weather" ||
        task === "finance" ||
        task === "research",
      "重要な主張を一次資料・公式資料で直接確認する",
    );
  }
  if (dimensions.includes("freshness")) {
    add(
      "freshness",
      95,
      task === "latest" || task === "weather" || task === "finance",
      "現在性が必要なため最新・更新日時を明示できる資料を取得する",
    );
  }
  if (dimensions.includes("counterevidence")) {
    add(
      "counterevidence",
      85,
      task === "fact_check",
      "反証・例外・限界を別経路で探し一面的な結論を避ける",
    );
  }
  if (dimensions.includes("comparison")) {
    add(
      "comparison",
      80,
      task === "comparison",
      "比較対象を同じ評価軸で確認できる資料を集める",
    );
  }
  if (dimensions.includes("academic")) {
    add(
      "academic",
      78,
      task === "research",
      "原著論文・プレプリント・査読情報を優先して取得する",
    );
  }
  if (dimensions.includes("technical")) {
    add(
      "technical",
      78,
      task === "technical",
      "公式ドキュメント・リポジトリ・仕様を優先して取得する",
    );
  }
  if (dimensions.includes("independence")) {
    add(
      "independent",
      70,
      task === "fact_check" || task === "comparison",
      "同一系列の転載だけに依存せず独立した確認元を確保する",
    );
  }

  return lanes.sort((a, b) => b.priority - a.priority);
}

/**
 * Deterministic task profiling for bounded multi-dimensional retrieval.
 *
 * The profile deliberately keeps evidence dimensions separate rather than
 * collapsing them into one score. Downstream planners can therefore repair a
 * missing dimension (for example freshness or counterevidence) without
 * repeating already-satisfied retrieval work.
 */
export function buildSearchTaskProfile(query: string): SearchTaskProfile {
  const normalized = query.replace(/\s+/g, " ").trim();
  const intent = classifySearchIntent(normalized);
  const temporalNeed = inferTemporalNeed(normalized, intent);
  const dimensions: SearchEvidenceDimension[] = [];

  if (
    PRIMARY_RE.test(normalized) ||
    FACT_CHECK_RE.test(normalized) ||
    RESEARCH_RE.test(normalized) ||
    intent === "weather" ||
    intent === "finance"
  ) {
    dimensions.push("primary_source");
  }
  if (temporalNeed === "realtime" || temporalNeed === "current") {
    dimensions.push("freshness");
  }
  if (
    intent === "news" ||
    FACT_CHECK_RE.test(normalized) ||
    COMPARISON_RE.test(normalized) ||
    RESEARCH_RE.test(normalized)
  ) {
    dimensions.push("independence");
  }
  if (FACT_CHECK_RE.test(normalized) || COUNTER_RE.test(normalized)) {
    dimensions.push("counterevidence");
  }
  if (RESEARCH_RE.test(normalized)) dimensions.push("academic");
  if (TECHNICAL_RE.test(normalized)) dimensions.push("technical");
  if (COMPARISON_RE.test(normalized)) dimensions.push("comparison");

  const unique = uniqueDimensions(dimensions);
  const task = inferTask(normalized, intent, unique);
  const lanes = buildLanes(task, unique);
  const complex =
    task === "fact_check" ||
    task === "comparison" ||
    task === "research" ||
    task === "technical" ||
    unique.length >= 3;

  return {
    intent,
    task,
    temporalNeed,
    dimensions: unique,
    lanes,
    recommendedMaxQueries: complex ? 4 : 3,
  };
}
