import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";

export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    modelId: text("model_id"),
    /** JSON-encoded array of {title, url} objects for web search sources */
    sources: text("sources"),
    auditContent: text("audit_content"),
    auditModelId: text("audit_model_id"),
    /** JSON-encoded claim-level evidence verification report */
    factuality: text("factuality"),
    /** JSON-encoded array of asset ids generated for this assistant message */
    assetIds: text("asset_ids"),
    /** Wall-clock milliseconds for this assistant turn. */
    durationMs: integer("duration_ms"),
    /** JSON list of files touched this turn: {path, kind, added, removed} */
    filesMeta: text("files_meta"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("messages_conversation_id_created_at_idx").on(
      table.conversationId,
      table.createdAt,
    ),
  ],
);

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
