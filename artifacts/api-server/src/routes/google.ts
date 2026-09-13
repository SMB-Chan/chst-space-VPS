import { Router, type RequestHandler } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import {
  buildGoogleAuthUrl,
  deleteGoogleAuth,
  exchangeGoogleCode,
  fetchGoogleAccountEmail,
  getGoogleAuthRow,
  getGoogleRedirectUri,
  isGoogleOAuthConfigured,
  saveGoogleAuth,
} from "../lib/google-auth";

const router = Router();

const handle =
  (handler: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };

function resolveUserId(req: { userId?: string }): string {
  return req.userId || process.env.LOCAL_USER_ID || "local-user";
}

// The OAuth callback runs in the user's browser right after the Google
// consent screen and is therefore unauthenticated; the signed-in sub-paths
// below are guarded via requireAuth. The state parameter carries the user id.
router.get(
  "/google/callback",
  handle(async (req, res) => {
    const frontend =
      process.env.FRONTEND_URL?.replace(/\/$/, "") ||
      `${req.protocol}://${req.get("host") ?? ""}`;
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const stateRaw = typeof req.query.state === "string" ? req.query.state : "";
    if (req.query.error) {
      res.redirect(`${frontend}/settings?google=denied`);
      return;
    }
    if (!code || !stateRaw) {
      res.redirect(`${frontend}/settings?google=error`);
      return;
    }
    let userId = process.env.LOCAL_USER_ID || "local-user";
    try {
      const state = JSON.parse(Buffer.from(stateRaw, "base64url").toString());
      if (typeof state.userId === "string") userId = state.userId;
    } catch {
      res.redirect(`${frontend}/settings?google=error`);
      return;
    }
    try {
      const redirectUri = getGoogleRedirectUri();
      const tokens = await exchangeGoogleCode(code, redirectUri);
      const accountEmail = await fetchGoogleAccountEmail(tokens.accessToken);
      await saveGoogleAuth({
        userId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
        expiresIn: tokens.expiresIn,
        scope: tokens.scope ?? null,
        accountEmail,
      });
      res.redirect(`${frontend}/settings?google=connected`);
    } catch {
      res.redirect(`${frontend}/settings?google=error`);
    }
  }),
);

router.use("/google", requireAuth);

router.get(
  "/google/status",
  handle(async (req, res) => {
    const userId = resolveUserId(req);
    const row = await getGoogleAuthRow(userId);
    res.json({
      configured: isGoogleOAuthConfigured(),
      connected: Boolean(row?.refreshToken),
      accountEmail: row?.accountEmail ?? null,
      scope: row?.scope ?? null,
      updatedAt: row?.updatedAt ?? null,
    });
  }),
);

router.get(
  "/google/auth",
  handle(async (req, res) => {
    if (!isGoogleOAuthConfigured()) {
      res.status(400).json({
        error:
          "Google連携がサーバー側で設定されていません（GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET）",
      });
      return;
    }
    const userId = resolveUserId(req);
    const redirectUri = getGoogleRedirectUri(req.headers.origin as string);
    const state = Buffer.from(
      JSON.stringify({ userId, nonce: Math.random().toString(36).slice(2) }),
    ).toString("base64url");
    res.redirect(buildGoogleAuthUrl(state, redirectUri));
  }),
);

router.delete(
  "/google",
  handle(async (req, res) => {
    const userId = resolveUserId(req);
    await deleteGoogleAuth(userId);
    res.json({ ok: true });
  }),
);

export default router;
