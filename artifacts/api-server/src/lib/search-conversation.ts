import type OpenAI from "openai";

const MAX_CONTEXT_TURNS = 6;
const MAX_CONTEXT_CHARS = 3_000;
const MAX_TURN_CHARS = 900;

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
  /^(?:では|じゃあ|それ(?:では|なら|について)?|これ(?:では|なら|について)?|その|同じ|両方|どちら)|比較して|比べて|詳しく|もう少し|続けて|どう(?:なの|ですか)|してくれる|してもらえる/i;

/** True when the current message cannot safely stand alone as a query. */
export function needsConversationAwareSearchPlan(
  userMessage: string,
  recentConversation: string,
): boolean {
  const message = userMessage.replace(/\s+/g, " ").trim();
  if (!message) return false;

  const looksLikeQuestion =
    /[?？]$/.test(message) ||
    /(?:教えて|調べて|比較して|比べて|してくれる|してもらえる|でしょうか|ですか|なのか|どちら|適している)/.test(
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
  return [previousUser, current].filter(Boolean).join(" ").slice(0, 200);
}
