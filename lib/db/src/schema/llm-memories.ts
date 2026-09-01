import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
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
    learnedAt: timestamp("learned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    validAsOf: date("valid_as_of"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    confidence: doublePrecision("confidence").default(1).notNull(),
    supersededBy: text("superseded_by"),
    accessCount: integer("access_count").default(0).notNull(),
    lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("llm_memories_user_topic_idx").on(table.userId, table.topic),
    index("llm_memories_user_active_idx").on(
      table.userId,
      table.supersededBy,
      table.expiresAt,
    ),
  ],
);

export type LlmMemory = typeof llmMemories.$inferSelect;
