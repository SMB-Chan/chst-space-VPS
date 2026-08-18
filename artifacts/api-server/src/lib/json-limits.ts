export const LARGE_JSON_LIMIT = "25mb";
export const DEFAULT_JSON_LIMIT = "256kb";

/** Chat posts may include a data-URL image. Other routes stay small. */
export const LARGE_JSON_PATHS = [
  "/api/openai/conversations/:id/messages",
  "/api/openai/ephemeral/messages",
] as const;
