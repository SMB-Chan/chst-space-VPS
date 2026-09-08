const BLANK_THREAD_ROUTES = new Set(["/chat", "/private"]);

/**
 * Translation is a per-thread working mode, not a global navigation mode.
 * Reset only when entering a blank/new thread route; once there, the user may
 * explicitly enable translation again without the route guard fighting them.
 */
export function shouldResetTranslationOnNavigation(
  previousLocation: string | null,
  nextLocation: string,
  previousConversationId: number | null = null,
  nextConversationId: number | null = null,
): boolean {
  const enteredBlankRoute =
    BLANK_THREAD_ROUTES.has(nextLocation) && previousLocation !== nextLocation;
  const enteredBlankConversation =
    BLANK_THREAD_ROUTES.has(nextLocation) &&
    previousConversationId !== null &&
    nextConversationId === null;
  return enteredBlankRoute || enteredBlankConversation;
}
