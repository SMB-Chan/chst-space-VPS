import { describe, expect, it, vi } from "vitest";
import { sanitizeReturnTo } from "./google";
import { getGoogleAuthScopes } from "../lib/google-auth";

describe("sanitizeReturnTo", () => {
  it("accepts same-origin relative paths", () => {
    expect(sanitizeReturnTo("/projects/12")).toBe("/projects/12");
    expect(sanitizeReturnTo("/settings?tab=google")).toBe(
      "/settings?tab=google",
    );
  });
  it("rejects absolute, protocol-relative and traversal targets", () => {
    expect(sanitizeReturnTo("https://evil.example/")).toBeNull();
    expect(sanitizeReturnTo("//evil.example/")).toBeNull();
    expect(sanitizeReturnTo("/\\evil.example")).toBeNull();
    expect(sanitizeReturnTo("/projects/../admin")).toBeNull();
    expect(sanitizeReturnTo("javascript:alert(1)")).toBeNull();
    expect(sanitizeReturnTo(undefined)).toBeNull();
  });
});

describe("getGoogleAuthScopes", () => {
  it("defaults to calendar + gmail + drive", () => {
    vi.stubEnv("GOOGLE_OAUTH_SCOPES", "");
    expect(getGoogleAuthScopes()).toContain(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
    vi.unstubAllEnvs();
  });
  it("narrows to Drive only", () => {
    vi.stubEnv("GOOGLE_OAUTH_SCOPES", "drive");
    expect(getGoogleAuthScopes()).toEqual([
      "openid",
      "email",
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
    vi.unstubAllEnvs();
  });
});
