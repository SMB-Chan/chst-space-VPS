export const LARGE_JSON_LIMIT = "30mb";
export const DEFAULT_JSON_LIMIT = "256kb";

/**
 * Project reference-file uploads arrive as base64 JSON. The body limit is
 * derived from the per-file byte limit (base64 is 4/3 of the raw size, plus
 * a little room for the filename and JSON framing) so raising
 * PROJECT_FILE_MAX_BYTES never leaves the parser rejecting valid uploads.
 */
export function projectFileJsonLimitBytes(fileMaxBytes: number): number {
  return Math.ceil((fileMaxBytes * 4) / 3) + 64 * 1024;
}

/** Body limit for the default 20 MiB per-file limit (≈ 26.7 MiB + 64 KiB). */
export const PROJECT_FILE_JSON_LIMIT = projectFileJsonLimitBytes(
  20 * 1024 * 1024,
);

/** Chat posts may include structured data-URL image attachments. */
export const LARGE_JSON_PATHS = [
  "/api/openai/conversations/:id/messages",
  "/api/openai/conversations/:conversationId/video-jobs",
  "/api/openai/ephemeral/messages",
] as const;

/**
 * Paths that accept a base64-encoded project file (limit derived from
 * PROJECT_FILE_MAX_BYTES). Authenticated before the parser runs (see app.ts).
 */
export const PROJECT_FILE_JSON_PATHS = ["/api/projects/:id/files"] as const;
