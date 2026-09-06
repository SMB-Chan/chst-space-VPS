import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import {
  denyNotAllowedUser,
  getUserRole,
  isUserAllowed,
  type UserRole,
} from "./allowedUsers";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userRole?: UserRole;
    }
  }
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
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
  next();
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
