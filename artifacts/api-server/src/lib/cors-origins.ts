/** Parse a comma-separated origin allowlist and normalize each entry to URL.origin. */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of (raw ?? "").split(",")) {
    const candidate = entry.trim();
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      origins.add(parsed.origin);
    } catch {
      // Invalid entries are ignored rather than widening access accidentally.
    }
  }
  return origins;
}

/**
 * Requests without Origin are non-browser/same-origin and may proceed.
 * Development may intentionally allow arbitrary origins when no allowlist is
 * configured; production fails closed in that case.
 */
export function isAllowedCorsOrigin(
  origin: string | undefined,
  allowedOrigins: ReadonlySet<string>,
  allowAnyDevelopmentOrigin: boolean,
): boolean {
  if (!origin) return true;
  if (allowAnyDevelopmentOrigin) return true;
  try {
    return allowedOrigins.has(new URL(origin).origin);
  } catch {
    return false;
  }
}
