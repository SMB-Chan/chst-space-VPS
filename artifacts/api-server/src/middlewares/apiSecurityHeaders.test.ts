import { describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { apiSecurityHeaders } from "./apiSecurityHeaders";

describe("apiSecurityHeaders", () => {
  it("sets conservative private API defaults and removes Express disclosure", () => {
    const headers = new Map<string, string>();
    const removeHeader = vi.fn();
    const setHeader = vi.fn((name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    });
    const next = vi.fn();

    apiSecurityHeaders(
      {} as Request,
      { removeHeader, setHeader } as unknown as Response,
      next as NextFunction,
    );

    expect(removeHeader).toHaveBeenCalledWith("X-Powered-By");
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("pragma")).toBe("no-cache");
    expect(headers.get("x-content-type-options")).toBe("nosniff");
    expect(headers.get("x-frame-options")).toBe("DENY");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("x-permitted-cross-domain-policies")).toBe("none");
    expect(headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(next).toHaveBeenCalledOnce();
  });
});
