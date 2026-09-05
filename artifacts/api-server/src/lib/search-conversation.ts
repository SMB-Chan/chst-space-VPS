import type OpenAI from "openai";
import { classifySearchIntent } from "./search-enhance";

const MAX_CONTEXT_TURNS = 8;
const MAX_CONTEXT_CHARS = 4_000;
const MAX_TURN_CHARS = 1_200;

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

function compactTurnText(text: string): string {
  return text
    .replace(/data:[^\s;,]+;base64,[A-Za-z0-9+/=]+/gi, "[添付データ]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TURN_CHARS);
}

/**
 * Build a small, text-only slice of the conversation for search planning.
 * The current user message is removed when it is already the last history
 * item, preventing duplication. Images, tool payloads, and system messages
 * are deliberately excluded.
 */
export function buildRecentSearchConversation(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  currentUserMessage: string,
): string {
  const turns = messages
    .filter(
      (
        message,
      ): message is Extract<
        OpenAI.Chat.Completions.ChatCompletionMessageParam,
        { role: "user" | "assistant" }
      > => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      text: compactTurnText(messageText(message.content)),
    }))
    .filter((turn) => turn.text);

  const current = compactTurnText(currentUserMessage);
  const last = turns.at(-1);
  if (last?.role === "user" && last.text === current) turns.pop();

  const recent = turns.slice(-MAX_CONTEXT_TURNS);
  const lines: string[] = [];
  let used = 0;
  for (let index = recent.length - 1; index >= 0; index--) {
    const turn = recent[index];
    const line = `${turn.role === "user" ? "ユーザー" : "アシスタント"}: ${turn.text}`;
    if (used + line.length > MAX_CONTEXT_CHARS) break;
    lines.unshift(line);
    used += line.length;
  }
  return lines.join("\n");
}

const FOLLOW_UP_LANGUAGE_RE =
  /^(?:では|じゃあ|それ(?:では|なら|について)?|これ(?:では|なら|について)?|その|同じ|両方|どちら)|比較して|比べて|詳しく|もう少し|続けて|要約して|まとめて|説明して|解説して|どう(?:なの|ですか)|してくれる|してもらえる/i;

/** True when the current message cannot safely stand alone as a query. */
export function needsConversationAwareSearchPlan(
  userMessage: string,
  recentConversation: string,
): boolean {
  const message = userMessage.replace(/\s+/g, " ").trim();
  if (!message) return false;

  const looksLikeQuestion =
    /[?？]$/.test(message) ||
    /(?:教えて|調べて|比較して|比べて|要約して|まとめて|説明して|解説して|してくれる|してもらえる|でしょうか|ですか|なのか|どちら|適している)/.test(
      message,
    );
  if (looksLikeQuestion) return true;
  return Boolean(recentConversation && FOLLOW_UP_LANGUAGE_RE.test(message));
}

/**
 * Last-resort query when the planning model times out. Context is included
 * only for messages that need it; standalone keyword queries stay compact.
 */
export function buildSearchFallbackQuery(
  userMessage: string,
  recentConversation: string,
  now = new Date(),
): string {
  const current = compactTurnText(userMessage);
  if (!needsConversationAwareSearchPlan(current, recentConversation)) {
    return current;
  }

  const previousUser = recentConversation
    .split("\n")
    .filter((line) => line.startsWith("ユーザー: "))
    .at(-1)
    ?.slice("ユーザー: ".length);

  if (classifySearchIntent(current) === "weather") {
    const source = [previousUser, current].filter(Boolean).join(" ");
    const locations = extractLocationHints(source);
    if (locations.length === 0) return "";

    const dates = extractJstDateHints(source, now);
    return [
      ...locations,
      ...dates,
      "天気予報",
      /比較|比べ|どちら/.test(current) ? "比較" : "",
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 200);
  }

  // Raw concatenation produces sentence-shaped noise; trim trailing request
  // phrasing and cap each side so the query stays keyword-shaped.
  return [previousUser, current]
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(REQUEST_TAIL_RE, "").trim().slice(0, 120))
    .filter(Boolean)
    .join(" ")
    .slice(0, 200);
}

const REQUEST_TAIL_RE =
  /(?:よろしくお願いします|お願いします|を)?(?:教えて|おしえて|調べて|検索して|見せて|まとめて|要約して|説明して|解説して)(?:ください|くれる|もらえますか|もらえませんか|いただけますか)?[。.!?！？\s]*$/;

function extractLocationHints(text: string): string[] {
  const locations = new Set<string>();
  const addMatches = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1]?.trim();
      if (candidate && !/^(?:今日|明日|昨日|今夜|天気|天候)$/.test(candidate)) {
        locations.add(candidate);
      }
    }
  };

  addMatches(
    /([\p{Script=Han}々ヶ\p{Script=Katakana}ー]{2,14}(?:都|道|府|県|市|区|町|村))/gu,
  );
  addMatches(
    /(?:^|[、。\s])([\p{Script=Han}々ヶ\p{Script=Katakana}ー]{2,12})(?=(?:で|の|は)(?:今日|明日|明後日|今夜|映画|天気|天候|上映|外出|イベント))/gu,
  );
  addMatches(
    /(?:^|[、。\s])([\p{Script=Han}々ヶ\p{Script=Katakana}ー]{2,12})(?=について)/gu,
  );
  return [...locations].slice(0, 2);
}

function extractJstDateHints(text: string, now: Date): string[] {
  const dates = new Set<string>();
  const jstParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(jstParts.find((item) => item.type === type)?.value);
  const baseUtc = Date.UTC(part("year"), part("month") - 1, part("day"));
  const atOffset = (offset: number) =>
    new Date(baseUtc + offset * 86_400_000).toISOString().slice(0, 10);

  const relativeDates: Array<[RegExp, number]> = [
    [/昨日/, -1],
    [/今日|きょう/, 0],
    [/明日/, 1],
    [/明後日/, 2],
  ];
  for (const [pattern, offset] of relativeDates) {
    if (pattern.test(text)) dates.add(atOffset(offset));
  }
  for (const match of text.matchAll(
    /\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\b/g,
  )) {
    const [, year, month, day] = match;
    dates.add(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`);
  }
  return [...dates];
}
