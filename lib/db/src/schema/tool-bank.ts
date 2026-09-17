import {
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Cross-project reusable code / tool snippets.
 * Tools are banked during project work, then copied into other projects
 * when judged reusable. Lifecycle is governed by tool-bank policy.
 */
export const toolBank = pgTable(
  "tool_bank",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** Stable slug for search and copy targets. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    summary: text("summary").notNull().default(""),
    language: text("language").notNull().default("text"),
    /** Primary reusable body (function / script / snippet). */
    code: text("code").notNull(),
    /** How to call / integrate the tool. */
    usage: text("usage").notNull().default(""),
    /** Free-form tags for search. */
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    /** Source project this was banked from (optional). */
    sourceProjectId: integer("source_project_id"),
    /** active | deprecated | archived */
    status: text("status").default("active").notNull(),
    /** Monotonic version; updates must bump. */
    version: integer("version").default(1).notNull(),
    /** Last update rationale (required on update per policy). */
    changeSummary: text("change_summary").notNull().default(""),
    useCount: integer("use_count").default(0).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Soft-delete marker; hard purge is separate. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("tool_bank_user_slug_uidx").on(table.userId, table.slug),
    index("tool_bank_user_status_idx").on(table.userId, table.status),
    index("tool_bank_user_updated_idx").on(table.userId, table.updatedAt),
  ],
);

export type ToolBankRow = typeof toolBank.$inferSelect;

export const TOOL_BANK_STATUSES = ["active", "deprecated", "archived"] as const;
export type ToolBankStatus = (typeof TOOL_BANK_STATUSES)[number];

/**
 * Project-level copy of a banked tool. Copying (not linking) keeps the
 * project self-contained when the bank entry later changes or is retired.
 */
export const projectToolCopies = pgTable(
  "project_tool_copies",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id").notNull(),
    userId: text("user_id").notNull(),
    toolId: integer("tool_id").notNull(),
    /** Snapshot copied at use time. */
    code: text("code").notNull(),
    toolVersion: integer("tool_version").notNull(),
    copiedAt: timestamp("copied_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("project_tool_copies_project_tool_uidx").on(
      table.projectId,
      table.toolId,
    ),
    index("project_tool_copies_user_idx").on(table.userId),
  ],
);

export type ProjectToolCopyRow = typeof projectToolCopies.$inferSelect;
