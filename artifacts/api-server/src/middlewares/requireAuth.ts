import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { denyNotAllowedUser, isUserAllowed } from "./allowedUsers";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
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
  next();
}
