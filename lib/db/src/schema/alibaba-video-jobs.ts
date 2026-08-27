import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { assets } from "./assets";
import { conversations } from "./conversations";
import { messages } from "./messages";

/**
 * Durable state for asynchronous HappyHorse jobs.
 *
 * Provider result URLs are intentionally not stored: they are signed,
 * short-lived URLs. A worker queries by providerTaskId and immediately copies
 * a successful MP4 into the assets table before linking assetId here.
 */
export const alibabaVideoJobs = pgTable(
  "alibaba_video_jobs",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    requestMessageId: integer("request_message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    resultMessageId: integer("result_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    assetId: integer("asset_id").references(() => assets.id, { onDelete: "set null" }),
    providerTaskId: text("provider_task_id").notNull(),
    providerRequestId: text("provider_request_id"),
    modelId: text("model_id").notNull(),
    mode: text("mode").notNull(),
    status: text("status").notNull().default("PENDING"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    providerExpiresAt: timestamp("provider_expires_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("alibaba_video_jobs_provider_task_id_uidx").on(table.providerTaskId),
    index("alibaba_video_jobs_user_created_at_idx").on(table.userId, table.createdAt),
    index("alibaba_video_jobs_due_idx").on(table.status, table.nextPollAt),
    index("alibaba_video_jobs_conversation_idx").on(table.conversationId),
  ],
);

export const insertAlibabaVideoJobSchema = createInsertSchema(alibabaVideoJobs).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type AlibabaVideoJob = typeof alibabaVideoJobs.$inferSelect;
export type InsertAlibabaVideoJob = z.infer<typeof insertAlibabaVideoJobSchema>;