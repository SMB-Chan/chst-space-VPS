import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { eq } from "drizzle-orm";
import { db, appUsers } from "@workspace/db";
import { logSafeHttpError } from "../lib/http-error-observability";
import {
  readSessionCookie,
  requireAuth,
  resolveAuthMode,
} from "../middlewares/requireAuth";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  SESSION_COOKIE,
  createSession,
  deleteSession,
  deleteSessionsForUser,
  dummyPasswordVerify,
  findUserById,
  findUserByUsername,
  hashPassword,
  normalizeUsername,
  resolveSession,
  touchLastLogin,
  verifyPassword,
} from "../lib/password-auth";
import { logger } from "../lib/logger";

/**
 * Username/password session endpoints for AUTH_MODE=password. Deliberately
 * outside the OpenAPI contract (like /admin). In other auth modes only
 * GET /auth/me answers, so the frontend can discover the active mode.
 */

const router = Router();

const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const USERNAME_FAILURE_LIMIT = 10;
// Higher than the per-username limit: several people can share one egress
// address (office NAT, mobile carrier), and one of them mistyping a password
// should not lock the rest out.
const ADDRESS_FAILURE_LIMIT = 50;

interface FailureBucket {
  count: number;
  resetAt: number;
}

interface ThrottleKey {
  key: string;
  limit: number;
}

const loginFailures = new Map<string, FailureBucket>();

/**
 * True for socket peers that can only be a local reverse proxy: loopback, or
 * a private / unique-local address such as the Docker bridge gateway that
 * nginx connects through on the VPS.
 */
function isProxyPeer(peer: string): boolean {
  const addr = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  if (addr === "::1" || addr.startsWith("127.")) return true;
  if (addr.startsWith("10.") || addr.startsWith("192.168.")) return true;
  const m = /^172\.(\d+)\./.exec(addr);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/i.test(addr);
}

/**
 * Client address for throttling, or null when it cannot be determined.
 * Behind the VPS reverse proxy, use the rightmost X-Forwarded-For entry
 * (appended by that proxy); never the spoofable leftmost one. A proxied
 * request without the header would collapse every user into the proxy's
 * address, so it is not throttled per address at all (the per-username
 * bucket still applies).
 */
function clientAddress(req: Request): string | null {
  const peer = req.socket?.remoteAddress ?? "";
  if (!peer) return null;
  if (!isProxyPeer(peer)) return peer;
  const hops = (req.header("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops.length > 0 ? hops[hops.length - 1] : null;
}

function throttleKeys(req: Request, username: string): ThrottleKey[] {
  const keys: ThrottleKey[] = [
    { key: `user:${username}`, limit: USERNAME_FAILURE_LIMIT },
  ];
  const address = clientAddress(req);
  if (address) {
    keys.push({ key: `addr:${address}`, limit: ADDRESS_FAILURE_LIMIT });
  }
  return keys;
}

function isThrottled(keys: ThrottleKey[], now = Date.now()): number | null {
  for (const { key, limit } of keys) {
    const bucket = loginFailures.get(key);
    if (!bucket) continue;
    if (bucket.resetAt <= now) {
      loginFailures.delete(key);
      continue;
    }
    if (bucket.count >= limit) {
      return Math.ceil((bucket.resetAt - now) / 1000);
    }
  }
  return null;
}

function recordFailure(keys: ThrottleKey[], now = Date.now()): void {
  for (const { key } of keys) {
    const bucket = loginFailures.get(key);
    if (!bucket || bucket.resetAt <= now) {
      loginFailures.set(key, {
        count: 1,
        resetAt: now + LOGIN_FAILURE_WINDOW_MS,
      });
    } else {
      bucket.count += 1;
    }
  }
}

/** Test hook: clear the in-memory login throttle. */
export function resetLoginThrottleForTests(): void {
  loginFailures.clear();
}

function cookieIsSecure(): boolean {
  const configured = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.NODE_ENV === "production";
}

function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  const maxAge = Math.max(
    0,
    Math.floor((expiresAt.getTime() - Date.now()) / 1000),
  );
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (cookieIsSecure()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function clearSessionCookie(res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/"];
  parts.push("Max-Age=0");
  if (cookieIsSecure()) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function passwordModeOnly(res: Response): boolean {
  if (resolveAuthMode() === "password") return true;
  res.status(404).json({ error: "Not found" });
  return false;
}

const loginBody = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX),
});

const INVALID_CREDENTIALS = "ユーザー名またはパスワードが正しくありません。";

router.post("/auth/login", async (req: Request, res: Response) => {
  if (!passwordModeOnly(res)) return;
  const parsed = loginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "リクエストが不正です。" });
    return;
  }
  const username = normalizeUsername(parsed.data.username);
  const keys = throttleKeys(req, username);
  const retryAfter = isThrottled(keys);
  if (retryAfter !== null) {
    res.setHeader("Retry-After", String(retryAfter));
    res.status(429).json({
      error:
        "ログインの失敗が続いたため、一時的にログインを制限しています。しばらく待ってから再試行してください。",
    });
    return;
  }
  try {
    const user = await findUserByUsername(username);
    const ok = user
      ? await verifyPassword(parsed.data.password, user.passwordHash)
      : (await dummyPasswordVerify(parsed.data.password), false);
    if (!user || !ok) {
      recordFailure(keys);
      res.status(401).json({ error: INVALID_CREDENTIALS });
      return;
    }
    const session = await createSession(user.id);
    await touchLastLogin(user.id);
    setSessionCookie(res, session.token, session.expiresAt);
    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    });
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "ログインに失敗しました。" });
  }
});

router.post("/auth/logout", async (req: Request, res: Response) => {
  if (!passwordModeOnly(res)) return;
  const token = readSessionCookie(req);
  if (token) {
    try {
      await deleteSession(token);
    } catch (err) {
      logger.warn(
        { component: "auth", err },
        "Failed to delete session during logout",
      );
    }
  }
  clearSessionCookie(res);
  res.status(204).send();
});

/** Never 401: reports the auth mode and the signed-in account, if any. */
router.get("/auth/me", async (req: Request, res: Response) => {
  const authMode = resolveAuthMode();
  if (authMode === "local") {
    const userId = process.env.LOCAL_USER_ID || "local-user";
    res.json({
      authMode,
      user: { id: userId, username: userId, displayName: null, role: "admin" },
    });
    return;
  }
  if (authMode === "clerk") {
    res.json({ authMode, user: null });
    return;
  }
  try {
    const session = await resolveSession(readSessionCookie(req));
    res.json({
      authMode,
      user: session
        ? {
            id: session.userId,
            username: session.username,
            displayName: session.displayName,
            role: session.role,
          }
        : null,
    });
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "ログイン状態を確認できませんでした。" });
  }
});

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
});

router.post(
  "/auth/password",
  (req, res, next) => {
    if (passwordModeOnly(res)) next();
  },
  requireAuth,
  async (req: Request, res: Response) => {
    const parsed = passwordBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: `新しいパスワードは${PASSWORD_MIN}〜${PASSWORD_MAX}文字で指定してください。`,
      });
      return;
    }
    const userId = req.userId!;
    try {
      const user = await findUserById(userId);
      if (
        !user ||
        !(await verifyPassword(parsed.data.currentPassword, user.passwordHash))
      ) {
        res.status(400).json({ error: "現在のパスワードが正しくありません。" });
        return;
      }
      await db
        .update(appUsers)
        .set({
          passwordHash: await hashPassword(parsed.data.newPassword),
          updatedAt: new Date(),
        })
        .where(eq(appUsers.id, userId));
      // Sign out every other device; keep this browser signed in.
      await deleteSessionsForUser(userId);
      const session = await createSession(userId);
      setSessionCookie(res, session.token, session.expiresAt);
      res.status(204).send();
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "パスワードを変更できませんでした。" });
    }
  },
);

export default router;
