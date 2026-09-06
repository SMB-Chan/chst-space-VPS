import { text, timestamp, pgTable } from "drizzle-orm/pg-core";

/**
 * Account-scoped application settings (default model, audit toggles, ...).
 * Stored as the serialized settings JSON so the schema can evolve without a
 * migration; the API validates the shape on write.
 */
export const userSettings = pgTable("user_settings", {
  userId: text("user_id").primaryKey(),
  data: text("data").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});
