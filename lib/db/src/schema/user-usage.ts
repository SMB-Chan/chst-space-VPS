import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Per-user, per-month, per-model token accounting for AI chat traffic.
 * Rows are upserted by the usage tracker after each streamed turn; the
 * monthly budget check for general users reads these aggregates.
 */
export const userUsageMonthly = pgTable(
  "user_usage_monthly",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    /** UTC month key "YYYY-MM" — the accounting period boundary. */
    month: text("month").notNull(),
    modelId: text("model_id").notNull(),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    requests: integer("requests").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_usage_monthly_user_month_model_uidx").on(
      table.userId,
      table.month,
      table.modelId,
    ),
    index("user_usage_monthly_month_idx").on(table.month),
  ],
);

/**
 * Per-user admin controls. One row per moderated user, created lazily by the
 * admin API. monthlyBudgetUsd null = inherit the server default budget.
 */
export const userBudgets = pgTable("user_budgets", {
  userId: text("user_id").primaryKey(),
  monthlyBudgetUsd: doublePrecision("monthly_budget_usd"),
  suspended: boolean("suspended").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
