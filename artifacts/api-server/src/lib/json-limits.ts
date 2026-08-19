export const LARGE_JSON_LIMIT = "30mb";
export const DEFAULT_JSON_LIMIT = "256kb";

/** Chat posts may include structured data-URL image attachments. */
export const LARGE_JSON_PATHS = [
  "/api/openai/conversations/:id/messages",
  "/api/openai/ephemeral/messages",
] as const;
