import { Router, type RequestHandler } from "express";
import { requireAuth, resolveAuthMode } from "../middlewares/requireAuth";
import {
  createGoogleOAuthState,
  GOOGLE_OAUTH_COOKIE,
  googleOAuthCookie,
  readCookie,
  verifyGoogleOAuthState,
} from "../lib/google-oauth-state";
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
// below are guarded via requireAuth. The state parameter carries the user id,
// signed by the server and bound to the starting browser by a cookie (see
// lib/google-oauth-state.ts).
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
    // AUTH_MODE=local has a single operator account, so there is no other
    // user to confuse; multi-user modes also require the browser cookie.
    const userId = verifyGoogleOAuthState(stateRaw, {
      cookieNonce: readCookie(req.headers.cookie, GOOGLE_OAUTH_COOKIE),
      requireCookie: resolveAuthMode() !== "local",
    });
    res.setHeader("Set-Cookie", googleOAuthCookie(null));
    if (!userId) {
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
    const { state, nonce } = createGoogleOAuthState(userId);
    res.setHeader("Set-Cookie", googleOAuthCookie(nonce));
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
