import type { Request, Response, NextFunction } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { getAuth } from "@clerk/express";
import {
  denyNotAllowedUser,
  getUserRole,
  isUserAllowed,
  type UserRole,
} from "./allowedUsers";
import { warmProviderOverrides } from "../lib/provider-credentials";
import { SESSION_COOKIE, resolveSession } from "../lib/password-auth";
import { logger } from "../lib/logger";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: UserRole;
    }
  }
}

/** Request-scoped user context for libraries that cannot take `req` (e.g. LLM clients). */
export const requestUserContext = new AsyncLocalStorage<{
  userId: string;
  userRole: UserRole;
}>();

export function getRequestUserId(): string | undefined {
  return requestUserContext.getStore()?.userId;
}

/** Effective auth mode for the running process. */
export type AuthMode = "local" | "clerk" | "password";

/**
 * Resolve the auth mode from process.env. "password" is the new
 * multi-user local mode backed by app_users + app_sessions. "local"
 * remains the single-operator deployment. Default is "clerk" for
 * backwards compatibility.
 */
export function resolveAuthMode(
  env: NodeJS.ProcessEnv = process.env,
): AuthMode {
  const raw = (env.AUTH_MODE ?? "").trim().toLowerCase();
  if (raw === "local") return "local";
  if (raw === "password") return "password";
  return "clerk";
}

/** Raw `cs_session` token from the Cookie header (password mode). */
export function readSessionCookie(req: Request): string | null {
  const header = req.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value) || null;
    } catch {
      return null;
    }
  }
  return null;
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const authMode = resolveAuthMode();
  if (authMode === "local") {
    const userId = process.env.LOCAL_USER_ID || "local-user";
    req.userId = userId;
    req.userRole = "admin";
    void warmProviderOverrides(userId).catch(() => {
      /* non-fatal: falls back to env keys until warm succeeds */
    });
    requestUserContext.run({ userId, userRole: "admin" }, () => next());
    return;
  }
  if (authMode === "password") {
    void handlePasswordAuth(req, res, next);
    return;
  }
  const auth = getAuth(req);
  const userId =
    (auth?.sessionClaims?.userId as string | undefined) || auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!isUserAllowed(userId)) {
    denyNotAllowedUser(res);
    return;
  }
  req.userId = userId;
  req.userRole = getUserRole(userId);
  const userRole = req.userRole;
  void warmProviderOverrides(userId).catch(() => {
    /* non-fatal */
  });
  requestUserContext.run({ userId, userRole }, () => next());
}

async function handlePasswordAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  let session: Awaited<ReturnType<typeof resolveSession>> = null;
  try {
    session = await resolveSession(readSessionCookie(req));
  } catch (err) {
    logger.warn(
      { component: "requireAuth", err },
      "Failed to resolve password-mode session",
    );
    res.status(503).json({ error: "認証情報を確認できませんでした。" });
    return;
  }
  if (!session) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const { userId, role: userRole } = session;
  req.userId = userId;
  req.userRole = userRole;
  void warmProviderOverrides(userId).catch(() => {
    /* non-fatal */
  });
  requestUserContext.run({ userId, userRole }, () => next());
}

/** Moderator boundary: admin-only endpoints mount this after requireAuth. */
export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.userRole === "admin") {
    next();
    return;
  }
  res.status(403).json({
    error: "この操作は管理者のみ実行できます。",
    code: "ADMIN_ONLY",
  });
}
