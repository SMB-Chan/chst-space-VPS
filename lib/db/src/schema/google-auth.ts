import { text, timestamp, pgTable } from "drizzle-orm/pg-core";

/**
 * Google OAuth 2.0 tokens per user (Calendar / Gmail / Drive integrations).
 * The refresh token is a long-lived secret scoped to this single deployment.
 */
export const googleAuth = pgTable("google_auth", {
  userId: text("user_id").primaryKey(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  accountEmail: text("account_email"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
