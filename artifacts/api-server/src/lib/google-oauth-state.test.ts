import { describe, expect, it } from "vitest";
import {
  createGoogleOAuthState,
  GOOGLE_OAUTH_STATE_TTL_MS,
  readCookie,
  verifyGoogleOAuthState,
} from "./google-oauth-state";

describe("google oauth state", () => {
  it("round-trips the user id when signed and bound to the browser", () => {
    const { state, nonce } = createGoogleOAuthState("u_alice");
    expect(
      verifyGoogleOAuthState(state, {
        cookieNonce: nonce,
        requireCookie: true,
      }),
    ).toBe("u_alice");
  });

  it("rejects the legacy unsigned state that named any user id", () => {
    const forged = Buffer.from(
      JSON.stringify({ userId: "u_victim", nonce: "x" }),
    ).toString("base64url");
    expect(
      verifyGoogleOAuthState(forged, {
        cookieNonce: "x",
        requireCookie: false,
      }),
    ).toBeNull();
  });

  it("rejects a state whose payload was swapped to another user", () => {
    const { state, nonce } = createGoogleOAuthState("u_attacker");
    const [, mac] = state.split(".");
    const payload = Buffer.from(
      JSON.stringify({ u: "u_victim", n: nonce, e: Date.now() + 60_000 }),
    ).toString("base64url");
    expect(
      verifyGoogleOAuthState(`${payload}.${mac}`, {
        cookieNonce: nonce,
        requireCookie: true,
      }),
    ).toBeNull();
  });

  it("rejects a valid state completed in a different browser (OAuth CSRF)", () => {
    const { state } = createGoogleOAuthState("u_attacker");
    expect(
      verifyGoogleOAuthState(state, { cookieNonce: null, requireCookie: true }),
    ).toBeNull();
    expect(
      verifyGoogleOAuthState(state, {
        cookieNonce: "victims-own-nonce",
        requireCookie: true,
      }),
    ).toBeNull();
  });

  it("expires", () => {
    const now = Date.now();
    const { state, nonce } = createGoogleOAuthState("u_alice", now);
    expect(
      verifyGoogleOAuthState(state, {
        cookieNonce: nonce,
        requireCookie: true,
        now: now + GOOGLE_OAUTH_STATE_TTL_MS + 1,
      }),
    ).toBeNull();
  });

  it("reads a single cookie from the header", () => {
    expect(
      readCookie("a=1; cs_google_oauth=abc%2D1; b=2", "cs_google_oauth"),
    ).toBe("abc-1");
    expect(readCookie(undefined, "cs_google_oauth")).toBeNull();
  });
});
