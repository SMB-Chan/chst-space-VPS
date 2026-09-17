import { text, timestamp, pgTable } from "drizzle-orm/pg-core";

/**
 * Per-user LLM provider API keys (BYOK). Values are stored encrypted
 * (AES-256-GCM) so a DB dump does not leak live credentials.
 */
export const providerCredentials = pgTable("provider_credentials", {
  userId: text("user_id").notNull(),
  provider: text("provider").notNull(),
  /** ciphertext: iv.tag.ciphertext (base64url) */
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  /** Optional provider base URL override (OpenAI-compatible gateways). */
  baseUrl: text("base_url"),
  /** Last 4 characters of the plaintext key, for the settings UI. */
  keyHint: text("key_hint"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ProviderId = "openai" | "dashscope" | "openrouter" | "xiaomi";
