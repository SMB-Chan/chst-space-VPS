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

// "local" mode serves a single-operator deployment (VPS/Tailnet) where the
// network perimeter is the authentication boundary. "clerk" keeps the
// original Clerk-based flow. Select with AUTH_MODE=local.
export const AUTH_MODE: "local" | "clerk" =
  process.env.AUTH_MODE === "local" ? "local" : "clerk";

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (AUTH_MODE === "local") {
    const userId = process.env.LOCAL_USER_ID || "local-user";
    req.userId = userId;
    req.userRole = "admin";
    void warmProviderOverrides(userId).catch(() => {
      /* non-fatal: falls back to env keys until warm succeeds */
    });
    requestUserContext.run({ userId, userRole: "admin" }, () => next());
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

