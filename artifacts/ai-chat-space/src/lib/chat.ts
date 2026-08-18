const TITLE_MAX_CHARS = 24;

/** Build a sidebar title that works for Japanese (no spaces) and English. */
export function conversationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "新しい会話";
  return normalized.length > TITLE_MAX_CHARS
    ? `${normalized.slice(0, TITLE_MAX_CHARS)}…`
    : normalized;
}

export function timeGreeting(now = new Date()): { title: string; subtitle: string } {
  const hour = now.getHours();
  if (hour >= 5 && hour < 11) {
    return {
      title: "おはようございます。",
      subtitle: "今日は何から始めますか？ドキュメントを添付するか、そのまま入力してください。",
    };
  }
  if (hour >= 11 && hour < 18) {
    return {
      title: "こんにちは。",
      subtitle: "何を進めましょうか？ドキュメントを添付するか、そのまま入力してください。",
    };
  }
  return {
    title: "こんばんは。",
    subtitle: "今夜は何を進めますか？ドキュメントを添付するか、そのまま入力してください。",
  };
}
