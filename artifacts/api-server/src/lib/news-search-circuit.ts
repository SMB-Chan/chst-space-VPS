import { normalizeQuery, sanitizeSearchQuery } from "./search-enhance";

export type NewsSearchCircuitMode = "headlines" | "topic";
export type NewsSearchTemporalScope = "current" | "today" | "yesterday";

export interface NewsSearchCircuit {
  kind: "news";
  mode: NewsSearchCircuitMode;
  temporalScope: NewsSearchTemporalScope;
  dateAnchor: string;
  topic?: string;
  queries: string[];
}

const NEWS_REQUEST_RE =
  /ニュース|速報|報道|ヘッドライン|時事|今日の出来事|本日の出来事|何が起き(?:た|ている)|news|headlines?|breaking|current events|what(?:'s| is) happening/i;
const NEWS_META_RE =
  /(?:ニュース|news).{0,24}(?:意味|定義|語源|翻訳|英訳|和訳|単語|mean(?:s|ing)?|definition|etymology|translate)|(?:意味|定義|語源|翻訳|英訳|和訳|mean(?:s|ing)?|definition|etymology|translate).{0,24}(?:ニュース|news)/i;
const HISTORICAL_NEWS_RE =
  /去年|昨年|一昨年|先月|先週|当時|過去|歴史|historical|history|last year|last month|last week|(?:19|20)\d{2}\s*(?:年|年度)?(?!\d)/i;
const TODAY_RE = /今日|本日|今朝|今夜|きょう|today|this morning|tonight/i;
const YESTERDAY_RE = /昨日|きのう|yesterday/i;
const JAPANESE_RE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;

function jstCalendarDate(now: Date, offsetDays = 0): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const base = Date.UTC(value("year"), value("month") - 1, value("day"));
  return new Date(base + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

function explicitRecentDate(
  question: string,
  now: Date,
): { date: string; historical: boolean } | null {
  const match = question.match(
    /(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?!\d)/,
  );
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const valid =
    Number.isFinite(timestamp) &&
    new Date(timestamp).getUTCFullYear() === year &&
    new Date(timestamp).getUTCMonth() === month - 1 &&
    new Date(timestamp).getUTCDate() === day;
  if (!valid) return null;
  const today = Date.parse(`${jstCalendarDate(now)}T00:00:00.000Z`);
  const ageDays = Math.floor((today - timestamp) / 86_400_000);
  return {
    date: new Date(timestamp).toISOString().slice(0, 10),
    // The strict fast path is for current-news retrieval. Older requests still
    // need Web search, but should use the ordinary historical-search route
    // rather than failing a seven-day freshness gate by construction.
    historical: ageDays > 7 || ageDays < -1,
  };
}

function temporalAnchor(
  question: string,
  now: Date,
): {
  dateAnchor: string;
  temporalScope: NewsSearchTemporalScope;
  historical: boolean;
} {
  const explicit = explicitRecentDate(question, now);
  if (explicit) {
    const today = jstCalendarDate(now);
    const yesterday = jstCalendarDate(now, -1);
    return {
      dateAnchor: explicit.date,
      temporalScope:
        explicit.date === today
          ? "today"
          : explicit.date === yesterday
            ? "yesterday"
            : "current",
      historical: explicit.historical,
    };
  }
  if (YESTERDAY_RE.test(question)) {
    return {
      dateAnchor: jstCalendarDate(now, -1),
      temporalScope: "yesterday",
      historical: false,
    };
  }
  if (TODAY_RE.test(question)) {
    return {
      dateAnchor: jstCalendarDate(now),
      temporalScope: "today",
      historical: false,
    };
  }
  return {
    dateAnchor: jstCalendarDate(now),
    temporalScope: "current",
    historical: HISTORICAL_NEWS_RE.test(question),
  };
}

function extractNewsTopic(question: string): string {
  let topic = question
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?(?!\d)/g, " ")
    .replace(
      /今日の出来事|本日の出来事|何が起き(?:た|ている)|今日|本日|今朝|今夜|きょう|昨日|きのう|最新|最近|直近|速報|ニュース|報道|ヘッドライン|時事/g,
      " ",
    )
    .replace(
      /what(?:'s| is) happening|\b(?:today|this morning|tonight|yesterday|latest|recent|breaking|news|headlines?|current events)\b/gi,
      " ",
    )
    .replace(
      /(?:について|に関する|をめぐる|の件|を)?(?:教えて|おしえて|調べて|検索して|まとめて|要約して|説明して|解説して|知りたい)(?:ください|くれる|もらえますか|いただけますか)?/g,
      " ",
    )
    .replace(
      /(?:について|に関して)?(?:分かる|わかる|知って(?:いる|る)|ありますか|あるか|何(?:ですか|がある)|どう(?:なっている|なった|ですか)|挙げて|列挙して)(?:か|ますか|ください)?/g,
      " ",
    )
    .replace(
      /\b(?:tell me|show me|find|search for|summari[sz]e|explain|about|regarding|with|current|please)\b/gi,
      " ",
    )
    .replace(/[?？!！。、,:：;；()[\]{}「」『』【】]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip grammatical residue only at the edges. Removing these tokens in the
  // middle could damage entity names or meaningful compound phrases.
  topic = topic
    .replace(
      /^(?:(?:の|は|を|が|で|に|と|や|主要|国内外|国内|国際|世界|について)\s*)+/g,
      "",
    )
    .replace(
      /(?:\s*(?:の|は|を|が|で|に|と|や|主要|ありますか|どうですか|について))+$/g,
      "",
    )
    .trim();

  const comparable = normalizeQuery(topic);
  if (
    !comparable ||
    /^(?:主要|国内|国際|世界|日本|global|world|top|major|updates?)$/i.test(
      comparable,
    )
  ) {
    return "";
  }
  return topic.slice(0, 120).trim();
}

function boundedQueries(candidates: string[]): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const query = sanitizeSearchQuery(candidate);
    if (!query) continue;
    const comparable = normalizeQuery(query);
    if (!comparable || seen.has(comparable)) continue;
    seen.add(comparable);
    queries.push(query);
    if (queries.length >= 3) break;
  }
  return queries;
}

/**
 * Build a deterministic current-news retrieval circuit. It separates broad
 * headline prompts from topic-specific prompts, keeps a concrete JST date, and
 * deliberately declines historical requests so they can use the ordinary
 * time-aware search planner without being judged by a current-news freshness
 * gate.
 */
export function buildNewsSearchCircuit(
  question: string,
  now = new Date(),
): NewsSearchCircuit | null {
  const normalized = question.replace(/\s+/g, " ").trim();
  if (
    !normalized ||
    !NEWS_REQUEST_RE.test(normalized) ||
    NEWS_META_RE.test(normalized)
  ) {
    return null;
  }

  const temporal = temporalAnchor(normalized, now);
  if (temporal.historical) return null;

  const topic = extractNewsTopic(normalized);
  const isJapanese = JAPANESE_RE.test(normalized);
  const candidates = topic
    ? isJapanese
      ? [
          `${temporal.dateAnchor} ${topic} ニュース`,
          `${temporal.dateAnchor} ${topic} 公式 発表`,
          `${temporal.dateAnchor} ${topic} 最新 報道`,
        ]
      : [
          `${temporal.dateAnchor} ${topic} latest news`,
          `${temporal.dateAnchor} ${topic} official announcement`,
          `${temporal.dateAnchor} ${topic} major reporting`,
        ]
    : isJapanese
      ? [
          `${temporal.dateAnchor} 日本 国内 主要ニュース 公式 報道`,
          `${temporal.dateAnchor} 国際 主要ニュース 公式 報道`,
          `${temporal.dateAnchor} 最新ニュース 主要報道`,
        ]
      : [
          `${temporal.dateAnchor} top world news official reporting`,
          `${temporal.dateAnchor} top US news official reporting`,
          `${temporal.dateAnchor} business science technology major news`,
        ];
  const queries = boundedQueries(candidates);
  if (queries.length === 0) return null;
  return {
    kind: "news",
    mode: topic ? "topic" : "headlines",
    temporalScope: temporal.temporalScope,
    dateAnchor: temporal.dateAnchor,
    ...(topic ? { topic } : {}),
    queries,
  };
}

/** Backward-compatible query-only entry point. */
export function buildNewsFastPathQueries(
  question: string,
  now = new Date(),
): string[] {
  return buildNewsSearchCircuit(question, now)?.queries ?? [];
}

export function isNewsFastPathQuestion(
  question: string,
  now = new Date(),
): boolean {
  return buildNewsSearchCircuit(question, now) !== null;
}
