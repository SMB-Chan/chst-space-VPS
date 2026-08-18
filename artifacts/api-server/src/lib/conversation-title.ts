export const CONVERSATION_TITLE_MAX = 80;

/** Trim, collapse whitespace, and cap length. Returns null when empty. */
export function normalizeConversationTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, " ").trim();
  if (!title) return null;
  return title.length > CONVERSATION_TITLE_MAX
    ? title.slice(0, CONVERSATION_TITLE_MAX)
    : title;
}
