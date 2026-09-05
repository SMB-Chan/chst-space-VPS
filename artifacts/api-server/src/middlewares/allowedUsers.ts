import type { Response } from "express";
import { logger } from "../lib/logger";

/**
 * Family/invite gate.
 *
 * When `ALLOWED_CLERK_USER_IDS` is configured, only the listed Clerk user IDs
 * may use the API. Unset or empty disables the gate, preserving the previous
 * open-to-any-authenticated-user behavior. Denied users receive a generic 403
 * that does not reveal whether the account exists.
 *
 * Clerk user IDs are visible in the Clerk dashboard (Users → detail view) and
 * are stable per account.
 */

export const USER_NOT_ALLOWED_CODE = "USER_NOT_ALLOWED";

export function getAllowedUserIds(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> | null {
  const raw = env.ALLOWED_CLERK_USER_IDS;
  if (!raw?.trim()) return null;
  const ids = new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return ids.size > 0 ? ids : null;
}

export function isUserAllowed(userId: string): boolean {
  const allowed = getAllowedUserIds();
  // A disabled gate never denies; every access path stays authenticated.
  return allowed === null || allowed.has(userId);
}

export function denyNotAllowedUser(res: Response): void {
  logger.warn(
    { component: "allowed-users", errorCode: USER_NOT_ALLOWED_CODE },
    "Authenticated user is not on the allowlist",
  );
  res.status(403).json({
    error: "このサービスは招待されたユーザーのみ利用できます。",
    code: USER_NOT_ALLOWED_CODE,
  });
}
