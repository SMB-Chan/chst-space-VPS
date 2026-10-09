import {
  text,
  timestamp,
  pgTable,
  integer,
  boolean,
} from "drizzle-orm/pg-core";

/**
 * LLM providers available to the chat and admin API.
 *
 * Built-in providers (openai/dashscope/openrouter/xiaomi) are seeded at
 * boot from the in-code catalog with kind='builtin' and no key. Custom
 * providers are admin-defined, store their own API key encrypted with
 * AES-256-GCM, and are the only kind that may be hard-deleted.
 */
export const llmProviders = pgTable("llm_providers", {
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  /** 'builtin' (seeded) or 'custom' (admin-defined). */
  kind: text("kind").notNull(),
  baseUrl: text("base_url"),
  /** AES-256-GCM ciphertext (iv.tag.ciphertext, base64url). null for built-ins. */
  apiKeyEncrypted: text("api_key_encrypted"),
  /** Last 4 chars of the plaintext key, for the admin UI. */
  keyHint: text("key_hint"),
  enabled: boolean("enabled").notNull().default(true),
  /** Built-in providers only: when false, the server env key is ignored (the "disconnect"). */
  useEnvKey: boolean("use_env_key").notNull().default(true),
  /** Built-in providers only: soft delete; survives re-seeding. */
  deleted: boolean("deleted").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * Catalog of chat-capable models across all providers.
 *
 * Built-in rows are seeded from the in-code AVAILABLE_MODELS at boot.
 * Tombstoning a built-in (deleted=true) hides it from non-admins but keeps
 * its id reserved; re-adding with the same id revives it. Custom-provider
 * rows are hard-deleted when their provider is removed.
 */
export const llmModels = pgTable("llm_models", {
  /** The model id as sent to the provider. May contain '/' (e.g. 'openai/gpt-4o'). */
  id: text("id").primaryKey(),
  providerId: text("provider_id")
    .notNull()
    .references(() => llmProviders.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  description: text("description").notNull().default(""),
  supportsVision: boolean("supports_vision").notNull().default(false),
  supportsReasoning: boolean("supports_reasoning").notNull().default(false),
  enabled: boolean("enabled").notNull().default(true),
  /** Visible to non-admin users (OpenRouter budget tier). */
  userVisible: boolean("user_visible").notNull().default(false),
  builtin: boolean("builtin").notNull().default(false),
  /** Soft-delete tombstone for built-ins. Custom rows use hard delete. */
  deleted: boolean("deleted").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
