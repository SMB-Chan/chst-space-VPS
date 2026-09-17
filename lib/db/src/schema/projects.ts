import {
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Named work unit that spans conversations and model switches.
 * Project memory (TODO / credentials / structure / …) is scoped here so a
 * new LLM can continue without re-explaining context.
 */
export const projects = pgTable(
  "projects",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("projects_user_slug_uidx").on(table.userId, table.slug),
    index("projects_user_idx").on(table.userId),
  ],
);

export type Project = typeof projects.$inferSelect;

export const PROJECT_MEMORY_SECTIONS = [
  "todo",
  "credentials",
  "structure",
  "decisions",
  "notes",
] as const;

export type ProjectMemorySection = (typeof PROJECT_MEMORY_SECTIONS)[number];

/** One row per project; free-text markdown per section. */
export const projectMemory = pgTable("project_memory", {
  projectId: integer("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  todo: text("todo").notNull().default(""),
  credentials: text("credentials").notNull().default(""),
  structure: text("structure").notNull().default(""),
  decisions: text("decisions").notNull().default(""),
  notes: text("notes").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export type ProjectMemoryRow = typeof projectMemory.$inferSelect;
