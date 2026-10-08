import { resetRoleCache } from "@/hooks/use-is-admin";

/** Session-scoped keys that hold the signed-in user's own data. */
export const USER_SESSION_STORAGE_KEYS = [
  "chat-space.mobile.pending-send",
] as const;

/**
 * Clear per-user browser state before signing out, so the next account on
 * the same device/tab does not see or auto-send the previous user's pending
 * message, and re-reads its own role. UI preferences (chat-space.settings.v1)
 * are deliberately kept: they hold no personal data.
 */
export function clearUserBrowserState(): void {
  resetRoleCache();
  try {
    for (const key of USER_SESSION_STORAGE_KEYS) {
      window.sessionStorage.removeItem(key);
    }
  } catch {
    /* storage may be unavailable (private mode); nothing to clear */
  }
}
