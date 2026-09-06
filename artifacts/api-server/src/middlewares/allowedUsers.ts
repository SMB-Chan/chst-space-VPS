import type { Response } from "express";
import { logger } from "../lib/logger";

/**
 * Family/invite gate and role model.
 *
 * - `ALLOWED_CLERK_USER_IDS` — when set, only these Clerk user ids may use
 *   the API. Unset/empty disables the gate (open to any authenticated user).
 * - `ADMIN_CLERK_USER_IDS` — admins keep full access (all providers, all
 *   capabilities, moderation endpoints). Admins are implicitly allowed even
 *   when the family gate is enabled, so the operator can never lock
 *   themselves out by forgetting their own id in both lists.
 *
 * Denied users receive a generic 403 that does not reveal whether the
 * account exists. Clerk user ids are visible in the Clerk dashboard
 * (Users → detail view) and are stable per account.
 */

export const USER_NOT_ALLOWED_CODE = "USER_NOT_ALLOWED";

export type UserRole = "admin" | "user";

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

export function getAdminUserIds(
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  return new Set(
    (env.ADMIN_CLERK_USER_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

export function getUserRole(userId: string): UserRole {
  if (getAdminUserIds().has(userId)) return "admin";
  return "user";
}

export function isUserAllowed(userId: string): boolean {
  const allowed = getAllowedUserIds();
  // A disabled gate never denies; every access path stays authenticated.
  // Admins bypass the family gate by design (operator lockout protection).
  return (
    allowed === null || allowed.has(userId) || getUserRole(userId) === "admin"
  );
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
