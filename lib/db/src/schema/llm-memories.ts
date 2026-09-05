import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const llmMemories = pgTable(
  "llm_memories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    topic: text("topic").notNull(),
    content: text("content").notNull(),
    sourceUrl: text("source_url"),
    sourceRef: text("source_ref"),
    kind: text("kind").default("unverified").notNull(),
    category: text("category").default("knowledge").notNull(),
    revision: integer("revision").default(1).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    invalidationReason: text("invalidation_reason"),
    learnedAt: timestamp("learned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    validAsOf: date("valid_as_of"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    confidence: doublePrecision("confidence").default(0.5).notNull(),
    supersededBy: text("superseded_by"),
    accessCount: integer("access_count").default(0).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("llm_memories_retention_idx").on(
      table.expiresAt,
      table.invalidatedAt,
    ),
    index("llm_memories_user_topic_idx").on(table.userId, table.topic),
    index("llm_memories_user_active_idx").on(
      table.userId,
      table.supersededBy,
      table.expiresAt,
    ),
  ],
);

export type LlmMemory = typeof llmMemories.$inferSelect;

export const llmMemoryRevisions = pgTable(
  "llm_memory_revisions",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => llmMemories.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    reason: text("reason").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.revision] }),
    index("llm_memory_revisions_recorded_idx").on(table.recordedAt),
  ],
);
