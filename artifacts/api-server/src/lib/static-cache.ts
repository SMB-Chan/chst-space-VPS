import path from "node:path";
import type { ServerResponse } from "node:http";

/**
 * The app shell (index.html), the service worker and the manifest must always
 * be revalidated: a cached copy pins phones to an old bundle after a deploy.
 * `no-store` is also honoured by Cloudflare, whose zone-wide Browser Cache TTL
 * would otherwise rewrite `max-age=0` to hours.
 */
export const SHELL_CACHE_CONTROL = "no-cache, no-store, must-revalidate";

/** Vite emits content-hashed files under /assets; they never change. */
export const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

const SHELL_FILES = new Set(["index.html", "sw.js", "manifest.webmanifest"]);

export function cacheControlForStaticFile(filePath: string): string | null {
  const base = path.basename(filePath);
  if (SHELL_FILES.has(base)) return SHELL_CACHE_CONTROL;
  const parts = filePath.split(/[\\/]/);
  if (parts.includes("assets")) return HASHED_ASSET_CACHE_CONTROL;
  return null;
}

export function setStaticCacheHeaders(
  res: ServerResponse,
  filePath: string,
): void {
  const value = cacheControlForStaticFile(filePath);
  if (value) res.setHeader("Cache-Control", value);
}
