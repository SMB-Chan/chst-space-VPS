import {
  boolean,
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
    /**
     * User-authored system prompt injected at the start of every
     * conversation bound to this project. Empty string = no instructions.
     */
    instructions: text("instructions").notNull().default(""),
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

/**
 * Reference files attached to a project. Their extracted text (PDF / DOCX /
 * XLSX / PPTX / plain UTF-8) is injected into the context of every
 * conversation bound to that project. Raw bytes are kept base64-encoded in
 * PostgreSQL text so we can stay on the existing text-storage pattern.
 */
export const projectFiles = pgTable(
  "project_files",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    /** Base64-encoded file bytes; mirrors the assets table convention. */
    data: text("data").notNull(),
    /** Server-extracted text (capped) — empty when extraction was unsupported. */
    extractedText: text("extracted_text").notNull().default(""),
    /** Number of UTF-8 characters actually persisted in extractedText. */
    textChars: integer("text_chars").notNull().default(0),
    includeInContext: boolean("include_in_context").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("project_files_project_idx").on(table.projectId),
    index("project_files_user_idx").on(table.userId),
  ],
);

export type ProjectFile = typeof projectFiles.$inferSelect;
