import { text, timestamp, pgTable, index } from "drizzle-orm/pg-core";

/**
 * Local password-auth accounts. Each row represents one human user that
 * can log in with username/password when AUTH_MODE=password.
 */
export const appUsers = pgTable("app_users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  displayName: text("display_name"),
  passwordHash: text("password_hash").notNull(),
  role: text("role").notNull().default("user"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
});

/**
 * Active login sessions. The id is the sha256 of the random token that
 * lives only in the cs_session cookie; the plaintext is never stored.
 */
export const appSessions = pgTable(
  "app_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    userIdIdx: index("app_sessions_user_id_idx").on(table.userId),
  }),
);
