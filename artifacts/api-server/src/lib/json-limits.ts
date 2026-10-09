export const LARGE_JSON_LIMIT = "30mb";
export const DEFAULT_JSON_LIMIT = "256kb";

/**
 * Project reference-file uploads: 5 MiB raw is ≈ 6.7 MiB as base64, which fits
 * in 8 MiB. Kept separate from (and far below) LARGE_JSON_LIMIT.
 */
export const PROJECT_FILE_JSON_LIMIT = "8mb";

/** Chat posts may include structured data-URL image attachments. */
export const LARGE_JSON_PATHS = [
  "/api/openai/conversations/:id/messages",
  "/api/openai/conversations/:conversationId/video-jobs",
  "/api/openai/ephemeral/messages",
] as const;

/**
 * Paths that accept a base64-encoded project file (up to 5 MiB raw ≈ 6.7 MiB
 * base64). Authenticated before the parser runs (see app.ts).
 */
export const PROJECT_FILE_JSON_PATHS = ["/api/projects/:id/files"] as const;
