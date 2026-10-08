import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * OAuth `state` for the Google connect flow.
 *
 * The callback is unauthenticated (it runs right after Google's consent
 * screen), so the state must prove which account started the flow:
 *  - it is HMAC-signed by the server, so nobody can mint a state for another
 *    user's id and attach their own Google tokens to that account;
 *  - it carries a nonce that must match an HttpOnly cookie set on the
 *    browser that started the flow, so a victim cannot be tricked into
 *    completing someone else's flow (classic OAuth CSRF), which would hand
 *    the victim's Google tokens to the attacker's account;
 *  - it expires after 10 minutes.
 */

export const GOOGLE_OAUTH_COOKIE = "cs_google_oauth";
export const GOOGLE_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function stateKey(): Buffer {
  const raw = [
    "chat-space:google-oauth-state",
    process.env.GOOGLE_CLIENT_SECRET?.trim() ?? "",
    process.env.PROVIDER_CREDENTIALS_SECRET?.trim() ??
      process.env.DATABASE_URL?.trim() ??
      "",
  ].join("\n");
  return createHash("sha256").update(raw).digest();
}

function sign(payload: string): string {
  return createHmac("sha256", stateKey()).update(payload).digest("base64url");
}

export function createGoogleOAuthState(
  userId: string,
  now = Date.now(),
): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ u: userId, n: nonce, e: now + GOOGLE_OAUTH_STATE_TTL_MS }),
  ).toString("base64url");
  return { state: `${payload}.${sign(payload)}`, nonce };
}

/**
 * Returns the user id the flow was started for, or null when the state is
 * forged, expired, or (when `cookieNonce` is required) not bound to this
 * browser.
 */
export function verifyGoogleOAuthState(
  state: string,
  opts: { cookieNonce: string | null; requireCookie: boolean; now?: number },
): string | null {
  const [payload, mac, extra] = state.split(".");
  if (!payload || !mac || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  let parsed: { u?: unknown; n?: unknown; e?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed.u !== "string" || !parsed.u) return null;
  if (typeof parsed.n !== "string" || typeof parsed.e !== "number") return null;
  if ((opts.now ?? Date.now()) > parsed.e) return null;
  if (opts.requireCookie && opts.cookieNonce !== parsed.n) return null;
  return parsed.u;
}

export function readCookie(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function cookieIsSecure(): boolean {
  const configured = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true") return true;
  if (configured === "false") return false;
  return process.env.NODE_ENV === "production";
}

export function googleOAuthCookie(nonce: string | null): string {
  const parts = [
    `${GOOGLE_OAUTH_COOKIE}=${nonce ? encodeURIComponent(nonce) : ""}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${nonce ? Math.floor(GOOGLE_OAUTH_STATE_TTL_MS / 1000) : 0}`,
  ];
  if (cookieIsSecure()) parts.push("Secure");
  return parts.join("; ");
}
