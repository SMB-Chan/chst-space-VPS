export const OPTIMISTIC_USER_ID = -1;
export const STREAMING_ASSISTANT_ID = -2;

const TITLE_MAX_CHARS = 24;
export const CONVERSATION_TITLE_MAX = 80;

/** Trim, collapse whitespace, and cap length. Returns null when empty. */
export function normalizeConversationTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > CONVERSATION_TITLE_MAX
    ? title.slice(0, CONVERSATION_TITLE_MAX)
    : title;
}

/** Build a sidebar title that works for Japanese (no spaces) and English. */
export function conversationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "新しい会話";
  return normalized.length > TITLE_MAX_CHARS
    ? `${normalized.slice(0, TITLE_MAX_CHARS)}…`
    : normalized;
}

export function timeGreeting(now = new Date()): {
  title: string;
  subtitle: string;
} {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) {
    return {
      title: "おはようございます。",
      subtitle: "用件を下の入力欄に書いてください。",
    };
  }
  if (hour >= 11 && hour < 18) {
    return {
      title: "こんにちは。",
      subtitle: "用件を下の入力欄に書いてください。",
    };
  }
  return {
    title: "こんばんは。",
      subtitle: "用件を下の入力欄に書いてください。",
  };
}
