import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Shared AI request-rate coordination (sharedAiUsageGuard). The API server
 * creates and reconciles these tables at boot (ENSURE_AI_USAGE_SCHEMA_SQL in
 * artifacts/api-server/src/lib/ensure-schema.ts) and queries them with raw
 * SQL. They are declared here so `drizzle-kit push` sees them and does not
 * drop them; names, types and constraints must stay identical to that SQL.
 */
export const aiUsageWindows = pgTable(
  "ai_usage_windows",
  {
    userId: text("user_id").primaryKey(),
    windowStartMs: bigint("window_start_ms", { mode: "number" }).notNull(),
    requestCount: integer("request_count").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "ai_usage_windows_request_count_check",
      sql`${table.requestCount} >= 0`,
    ),
  ],
);

export const aiUsageLeases = pgTable(
  "ai_usage_leases",
  {
    leaseId: text("lease_id").primaryKey(),
    userId: text("user_id").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("ai_usage_leases_user_expires_idx").on(table.userId, table.expiresAt),
  ],
);
