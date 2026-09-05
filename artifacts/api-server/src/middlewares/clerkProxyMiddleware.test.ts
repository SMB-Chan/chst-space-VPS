import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import {
  clerkProxyMiddleware,
  getAllowedClerkHost,
  getClerkProxyUrlForRequest,
  getConfiguredClerkHosts,
  getConfiguredClerkProxyUrl,
  resolveTrustedClientIp,
} from "./clerkProxyMiddleware";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Clerk proxy trust boundary", () => {
  it("accepts only an explicit canonical HTTPS proxy URL on the fixed path", () => {
    expect(
      getConfiguredClerkProxyUrl({
        CLERK_PROXY_URL: "https://app.example.com/api/__clerk/",
      }),
    ).toBe("https://app.example.com/api/__clerk");

    expect(getConfiguredClerkProxyUrl({})).toBeUndefined();
    expect(
      getConfiguredClerkProxyUrl({
        CLERK_PROXY_URL: "/api/__clerk",
      }),
    ).toBeUndefined();
    expect(
      getConfiguredClerkProxyUrl({
        CLERK_PROXY_URL: "http://app.example.com/api/__clerk",
      }),
    ).toBeUndefined();
    expect(
      getConfiguredClerkProxyUrl({
        CLERK_PROXY_URL: "https://app.example.com/not-clerk",
      }),
    ).toBeUndefined();
    expect(
      getConfiguredClerkProxyUrl({
        CLERK_PROXY_URL: "https://app.example.com/api/__clerk?redirect=evil",
      }),
    ).toBeUndefined();
  });

  it("builds the dynamic Clerk hostname allowlist only from configured sources", () => {
    const hosts = getConfiguredClerkHosts({
      CLERK_ALLOWED_HOSTS: "app.example.com:443,alt.example.com.",
      FRONTEND_URL: "https://front.example.com,https://other.example.com/path",
      REPLIT_DOMAINS: "chat-smb.replit.app,custom.example.com",
      REPLIT_DEV_DOMAIN: "workspace.example.replit.dev",
      CLERK_PROXY_URL: "https://proxy.example.com/api/__clerk",
    });

    expect(hosts).toEqual(
      new Set([
        "app.example.com",
        "alt.example.com",
        "front.example.com",
        "other.example.com",
        "chat-smb.replit.app",
        "custom.example.com",
        "workspace.example.replit.dev",
        "proxy.example.com",
      ]),
    );
  });

  it("treats request host headers only as selectors into the allowlist", () => {
    const allowed = new Set(["app.example.com", "alt.example.com"]);

    expect(
      getAllowedClerkHost(
        {
          headers: {
            "x-forwarded-host": "evil.example, app.example.com",
            host: "app.example.com:443",
          },
        },
        allowed,
      ),
    ).toBe("app.example.com");

    expect(
      getAllowedClerkHost(
        {
          headers: {
            "x-forwarded-host": "alt.example.com:443",
            host: "app.example.com",
          },
        },
        allowed,
      ),
    ).toBe("alt.example.com");

    expect(
      getAllowedClerkHost(
        {
          headers: {
            "x-forwarded-host": "evil.example",
            host: "also-evil.example",
          },
        },
        allowed,
      ),
    ).toBeUndefined();
  });

  it("derives HTTPS proxy URLs only from configured request hosts", () => {
    const allowed = new Set(["chat-smb.replit.app", "app.example.com"]);

    expect(
      getClerkProxyUrlForRequest(
        {
          headers: {
            "x-forwarded-host": "app.example.com",
            host: "chat-smb.replit.app",
          },
        },
        allowed,
      ),
    ).toBe("https://app.example.com/api/__clerk");

    expect(
      getClerkProxyUrlForRequest(
        {
          headers: {
            "x-forwarded-host": "evil.example, app.example.com",
            host: "chat-smb.replit.app:443",
          },
        },
        allowed,
      ),
    ).toBe("https://chat-smb.replit.app/api/__clerk");

    expect(
      getClerkProxyUrlForRequest(
        {
          headers: {
            "x-forwarded-host": "evil.example",
            host: "also-evil.example",
          },
        },
        allowed,
      ),
    ).toBeUndefined();
  });

  it("does not expose the production FAPI proxy from CLERK_SECRET_KEY alone", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLERK_SECRET_KEY", "sk_live_test");
    vi.stubEnv("CLERK_PROXY_URL", "");
    vi.stubEnv("CLERK_ALLOWED_HOSTS", "");
    vi.stubEnv("REPLIT_DOMAINS", "");
    vi.stubEnv("REPLIT_DEV_DOMAIN", "");
    vi.stubEnv("FRONTEND_URL", "");

    const next = vi.fn();
    clerkProxyMiddleware()({} as Request, {} as Response, next as NextFunction);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe("resolveTrustedClientIp (issue #46)", () => {
  it("never attests a client-seeded leftmost XFF entry", () => {
    // Client seeds "6.6.6.6" and the honest edge appends the real client IP.
    expect(
      resolveTrustedClientIp(
        { "x-forwarded-for": "6.6.6.6, 203.0.113.7" },
        "10.0.0.1",
      ),
    ).toBe("203.0.113.7");
  });

  it("uses the edge-appended value when the chain is a single entry", () => {
    expect(
      resolveTrustedClientIp({ "x-forwarded-for": "203.0.113.42" }, "10.0.0.1"),
    ).toBe("203.0.113.42");
  });

  it("joins duplicate XFF header lines before taking the rightmost entry", () => {
    expect(
      resolveTrustedClientIp(
        {
          "x-forwarded-for": [
            "6.6.6.6, 6.6.6.7",
            " 203.0.113.9",
          ] as unknown as string,
        },
        "10.0.0.1",
      ),
    ).toBe("203.0.113.9");
  });

  it("falls back to the TCP peer without a forwarded chain", () => {
    expect(resolveTrustedClientIp({}, "10.0.0.1")).toBe("10.0.0.1");
    expect(resolveTrustedClientIp({ "x-forwarded-for": "" }, "10.0.0.1")).toBe(
      "10.0.0.1",
    );
    expect(resolveTrustedClientIp({}, undefined)).toBeUndefined();
  });

  it("prefers an operator-declared trusted edge header", () => {
    expect(
      resolveTrustedClientIp(
        {
          "cf-connecting-ip": "198.51.100.5",
          "x-forwarded-for": "6.6.6.6, 203.0.113.7",
        },
        "10.0.0.1",
        { CLERK_TRUSTED_CLIENT_IP_HEADER: "CF-Connecting-IP" },
      ),
    ).toBe("198.51.100.5");
  });

  it("falls back to the chain rule when the declared edge header is absent", () => {
    expect(
      resolveTrustedClientIp(
        { "x-forwarded-for": "6.6.6.6, 203.0.113.7" },
        "10.0.0.1",
        { CLERK_TRUSTED_CLIENT_IP_HEADER: "cf-connecting-ip" },
      ),
    ).toBe("203.0.113.7");
  });
});
