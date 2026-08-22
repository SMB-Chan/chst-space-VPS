import type { NextFunction, Request, Response } from "express";

/**
 * Conservative defaults for JSON/SSE/download API responses.
 *
 * This middleware is mounted only under /api, after the Clerk proxy route, so
 * it does not alter Clerk's proxied browser assets. Individual endpoints may
 * replace a header with a stricter/more specific value when necessary (for
 * example HTML artifact downloads add `Content-Security-Policy: sandbox`).
 */
export function apiSecurityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Avoid leaking the Express implementation through the default header.
  res.removeHeader("X-Powered-By");

  // Conversation data and AI responses are authenticated/private by default.
  // Streaming routes can replace this with an SSE-specific no-cache policy.
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Pragma", "no-cache");

  // API responses should never be MIME-sniffed or framed as active documents.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");

  next();
}
