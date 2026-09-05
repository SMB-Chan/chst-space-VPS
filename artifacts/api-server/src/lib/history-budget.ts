/**
 * Bounded replay budget for conversation history.
 *
 * Without a budget, every turn of a long-lived conversation is re-sent to the
 * model verbatim — including attachment text of past turns (up to 2 MB each) —
 * until the request exceeds the provider context window. Providers then either
 * reject the request or silently drop the oldest turns, which reads to the
 * user as "the thread forgot its own context". This module walks history from
 * newest to oldest, keeps recent turns verbatim, middle-abbreviates the next
 * tier of older turns, and explicitly marks what was omitted so the model can
 * say so instead of guessing.
 */

export interface HistoryTurn {
  role: "user" | "assistant" | "system";
  content: unknown;
}

export interface HistoryBudgetOptions {
  /** Total character budget for historical turns (images count as a fixed weight). */
  maxChars?: number;
  /** Newest turns always kept verbatim (subject only to the global budget). */
  recentFullTurns?: number;
}

export interface HistoryBudgetResult {
  messages: HistoryTurn[];
  /** Turns left out entirely. */
  omittedTurnCount: number;
  /** Turns kept but shortened in the middle. */
  truncatedTurnCount: number;
}

/** Default budget ≈ 48k chars, leaving room for system prompts, web data, and output. */
export const DEFAULT_HISTORY_CHAR_BUDGET = 48_000;
const MIN_HISTORY_CHAR_BUDGET = 8_000;
const MAX_HISTORY_CHAR_BUDGET = 200_000;
export const DEFAULT_RECENT_FULL_TURNS = 6;
/** Do not keep a truncated turn that carries less text than this. */
const MIN_TRUNCATED_TURN_CHARS = 300;
/** Images cannot be abbreviated; they pay a fixed token-weight surcharge. */
const IMAGE_PART_CHAR_WEIGHT = 800;
const TRUNCATION_MARK = "…（長さ制限のため中略）…";
const SAFETY_MARGIN_CHARS = 40;

export function resolveHistoryCharBudget(
  raw: string | undefined = process.env.HISTORY_CONTEXT_CHAR_BUDGET,
): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_HISTORY_CHAR_BUDGET;
  return Math.min(
    MAX_HISTORY_CHAR_BUDGET,
    Math.max(MIN_HISTORY_CHAR_BUDGET, Math.floor(parsed)),
  );
}

function isImagePart(part: unknown): boolean {
  return (
    !!part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "image_url"
  );
}

function isTextPart(part: unknown): part is { type: "text"; text: string } {
  return (
    !!part &&
    typeof part === "object" &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

function measureContent(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  return content.reduce(
    (sum, part) => sum + (isTextPart(part) ? part.text.length : 0),
    content.filter(isImagePart).length * IMAGE_PART_CHAR_WEIGHT,
  );
}

/** Middle abbreviation: keep the head (topic) and the tail (recent referents). */
export function truncateTextMiddle(text: string, targetChars: number): string {
  if (targetChars <= 0) return "";
  if (text.length <= targetChars) return text;
  const budget = Math.max(0, targetChars - TRUNCATION_MARK.length);
  if (budget <= 0) return TRUNCATION_MARK;
  const headChars = Math.max(1, Math.floor(budget * 0.7));
  const tailChars = Math.max(0, budget - headChars);
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(-tailChars) : "";
  return `${head}${TRUNCATION_MARK}${tail}`;
}

function truncateContent(content: unknown, targetChars: number): unknown {
  if (typeof content === "string") {
    return truncateTextMiddle(content, targetChars);
  }
  if (!Array.isArray(content)) return content;
  const textLength = content.reduce(
    (sum, part) => sum + (isTextPart(part) ? part.text.length : 0),
    0,
  );
  const imageCount = content.filter(isImagePart).length;
  const imageWeight = imageCount * IMAGE_PART_CHAR_WEIGHT;
  const textBudget = Math.max(0, targetChars - imageWeight);
  if (textLength <= textBudget) return content;
  // Shrink each text part proportionally; images are bounded elsewhere.
  const scale = textLength > 0 ? textBudget / textLength : 0;
  return content.map((part) => {
    if (!isTextPart(part)) return part;
    return {
      ...part,
      text: truncateTextMiddle(part.text, Math.floor(part.text.length * scale)),
    };
  });
}

/**
 * Apply the newest-first replay budget. The returned messages stay in
 * chronological order; when turns were omitted, a leading system note tells
 * the model the history is partial.
 */
export function budgetConversationHistory(
  messages: HistoryTurn[],
  options: HistoryBudgetOptions = {},
): HistoryBudgetResult {
  const maxChars = Math.max(
    1,
    Math.floor(options.maxChars ?? resolveHistoryCharBudget()),
  );
  const recentFullTurns = Math.max(
    0,
    Math.floor(options.recentFullTurns ?? DEFAULT_RECENT_FULL_TURNS),
  );

  const measured = messages.map((message) => ({
    message,
    cost: measureContent(message.content),
  }));

  const kept: HistoryTurn[] = [];
  let remaining = maxChars;
  let omittedTurnCount = 0;
  let truncatedTurnCount = 0;

  for (let index = measured.length - 1; index >= 0; index -= 1) {
    const { message, cost } = measured[index];
    const isRecent = measured.length - 1 - index < recentFullTurns;

    if (cost <= remaining) {
      kept.unshift(message);
      remaining -= cost;
      continue;
    }
    // The turn no longer fits: keep an abbreviated version while the budget
    // can still carry meaningful text, then omit everything older.
    const keepBudget = remaining - SAFETY_MARGIN_CHARS;
    if (keepBudget >= MIN_TRUNCATED_TURN_CHARS) {
      kept.unshift({
        ...message,
        content: truncateContent(message.content, keepBudget),
      });
      truncatedTurnCount += 1;
      omittedTurnCount += index;
      remaining = 0;
    } else {
      omittedTurnCount += index + 1;
    }
    break;
  }

  const result: HistoryTurn[] = [];
  if (omittedTurnCount > 0) {
    result.push({
      role: "system",
      content:
        `【会話履歴の省略】これより前の会話 ${omittedTurnCount} ターン分はコンテキスト長の制約により省略されています。` +
        `省略された内容について聞かれた場合は、推測で答えずユーザーに要点を確認してください。`,
    });
  }
  result.push(...kept);

  return { messages: result, omittedTurnCount, truncatedTurnCount };
}
