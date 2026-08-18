import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";
import { messages } from "./messages";

export const artifacts = pgTable(
  "artifacts",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: integer("message_id")
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    /** Text artifacts are stored as UTF-8 text. Binary generation is intentionally out of scope. */
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("artifacts_user_id_created_at_idx").on(table.userId, table.createdAt),
    index("artifacts_conversation_id_idx").on(table.conversationId),
    index("artifacts_message_id_idx").on(table.messageId),
  ],
);

export const insertArtifactSchema = createInsertSchema(artifacts).omit({
  id: true,
  createdAt: true,
});

export type Artifact = typeof artifacts.$inferSelect;
export type InsertArtifact = z.infer<typeof insertArtifactSchema>;
