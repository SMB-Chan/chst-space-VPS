import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

import { conversations } from "./conversations";
import { messages } from "./messages";

export const RUN_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_STEP_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStepStatus = (typeof RUN_STEP_STATUSES)[number];

export const RUN_STEP_TYPES = [
  "request",
  "attachment",
  "memory",
  "search",
  "retrieval",
  "model",
  "tool",
  "verification",
  "audit",
  "artifact",
  "persistence",
] as const;

export type RunStepType = (typeof RUN_STEP_TYPES)[number];

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    conversationId: integer("conversation_id").references(
      () => conversations.id,
      { onDelete: "cascade" },
    ),
    triggerMessageId: integer("trigger_message_id").references(
      () => messages.id,
      { onDelete: "set null" },
    ),
    userId: text("user_id").notNull(),
    status: text("status").$type<RunStatus>().notNull(),
    provider: text("provider"),
    modelId: text("model_id"),
    traceId: text("trace_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("runs_user_created_at_idx").on(table.userId, table.createdAt),
    index("runs_conversation_created_at_idx").on(
      table.conversationId,
      table.createdAt,
    ),
    index("runs_status_created_at_idx").on(table.status, table.createdAt),
    index("runs_trace_id_idx").on(table.traceId),
  ],
);

export const runSteps = pgTable(
  "run_steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type").$type<RunStepType>().notNull(),
    status: text("status").$type<RunStepStatus>().notNull(),
    attempt: integer("attempt").notNull().default(1),
    inputRef: text("input_ref"),
    outputRef: text("output_ref"),
    provider: text("provider"),
    modelId: text("model_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: doublePrecision("cost_usd").notNull().default(0),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("run_steps_run_sequence_idx").on(table.runId, table.sequence),
    index("run_steps_run_type_idx").on(table.runId, table.type),
    index("run_steps_status_created_at_idx").on(table.status, table.createdAt),
  ],
);

export const insertRunSchema = createInsertSchema(runs).omit({
  createdAt: true,
  updatedAt: true,
});

export const insertRunStepSchema = createInsertSchema(runSteps).omit({
  createdAt: true,
  updatedAt: true,
});

export type Run = typeof runs.$inferSelect;
export type InsertRun = z.infer<typeof insertRunSchema>;
export type RunStep = typeof runSteps.$inferSelect;
export type InsertRunStep = z.infer<typeof insertRunStepSchema>;
