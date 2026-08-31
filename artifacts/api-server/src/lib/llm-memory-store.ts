import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  content TEXT NOT NULL,
  source_url TEXT,
  learned_at TEXT NOT NULL,
  valid_as_of TEXT,
  expires_at TEXT,
  confidence REAL DEFAULT 1.0,
  superseded_by TEXT,
  access_count INTEGER DEFAULT 0,
  last_accessed_at TEXT,
  tags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic);
CREATE INDEX IF NOT EXISTS idx_memories_expires ON memories(expires_at);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(superseded_by, expires_at);
`;

export interface MemoryEntry {
  id: string;
  topic: string;
  content: string;
  source_url: string | null;
  learned_at: string;
  valid_as_of: string | null;
  expires_at: string | null;
  confidence: number;
  superseded_by: string | null;
  access_count: number;
  last_accessed_at: string | null;
  tags: string[];
}

export interface StoreMemoryInput {
  topic: string;
  content: string;
  source_url?: string;
  valid_as_of?: string;
  expires_at?: string;
  confidence?: number;
  tags?: string[];
}

export interface UpdateMemoryInput {
  topic?: string;
  content?: string;
  confidence?: number;
  expires_at?: string;
  tags?: string[];
}

const DEFAULT_EXPIRY_DAYS = 180;
const MAX_MEMORIES = 500;
const MAX_CONTENT_CHARS = 4000;
const MAX_TOPIC_CHARS = 200;

function resolveDbPath(): string {
  const dataDir =
    process.env.LLM_MEMORY_DIR ?? join(process.cwd(), "data", "llm-memory");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }
  return join(dataDir, "memories.db");
}

let dbInstance: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!dbInstance) {
    const dbPath = resolveDbPath();
    dbInstance = new DatabaseSync(dbPath);
    dbInstance.exec("PRAGMA journal_mode = WAL");
    dbInstance.exec(SCHEMA);
    logger.info({ dbPath }, "LLM memory store initialized");
  }
  return dbInstance;
}

export function closeMemoryStore(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function rowToEntry(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row.id as string,
    topic: row.topic as string,
    content: row.content as string,
    source_url: (row.source_url as string) ?? null,
    learned_at: row.learned_at as string,
    valid_as_of: (row.valid_as_of as string) ?? null,
    expires_at: (row.expires_at as string) ?? null,
    confidence: (row.confidence as number) ?? 1.0,
    superseded_by: (row.superseded_by as string) ?? null,
    access_count: (row.access_count as number) ?? 0,
    last_accessed_at: (row.last_accessed_at as string) ?? null,
    tags: JSON.parse((row.tags as string) ?? "[]"),
  };
}

function defaultExpiry(): string {
  const d = new Date();
  d.setDate(d.getDate() + DEFAULT_EXPIRY_DAYS);
  return d.toISOString();
}

/**
 * Store a new memory. If a memory with a very similar topic exists,
 * the caller should use `supersedeMemory` instead.
 */
export function storeMemory(input: StoreMemoryInput): MemoryEntry {
  const db = getDb();
  const id = `mem_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const now = new Date().toISOString();
  const topic = input.topic.slice(0, MAX_TOPIC_CHARS);
  const content = input.content.slice(0, MAX_CONTENT_CHARS);

  enforceMemoryCap(db);

  db.prepare(
    `INSERT INTO memories (id, topic, content, source_url, learned_at, valid_as_of, expires_at, confidence, tags)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    topic,
    content,
    input.source_url ?? null,
    now,
    input.valid_as_of ?? null,
    input.expires_at ?? defaultExpiry(),
    input.confidence ?? 1.0,
    JSON.stringify(input.tags ?? []),
  );

  logger.debug({ id, topic }, "Memory stored");
  return getMemory(id)!;
}

/**
 * Escape SQL LIKE wildcard characters so they are treated as literals.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/**
 * Recall memories matching keywords in topic or content.
 * Only returns active (non-superseded, non-expired) memories.
 */
export function recallMemories(query: string, limit = 10): MemoryEntry[] {
  const db = getDb();
  const pattern = `%${escapeLikePattern(query)}%`;
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE superseded_by IS NULL
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (topic LIKE ? OR content LIKE ? OR tags LIKE ?)
       ORDER BY confidence DESC, access_count DESC, learned_at DESC
       LIMIT ?`,
    )
    .all(pattern, pattern, pattern, limit) as Record<string, unknown>[];

  const ids = rows.map((r) => r.id as string);
  if (ids.length > 0) {
    db.prepare(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now')
       WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).run(...ids);
  }

  return rows.map(rowToEntry);
}

/**
 * Get a single memory by ID.
 */
export function getMemory(id: string): MemoryEntry | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    Record<string, unknown> | undefined;
  return row ? rowToEntry(row) : null;
}

/**
 * Update an existing memory's content/metadata.
 */
export function updateMemory(
  id: string,
  input: UpdateMemoryInput,
): MemoryEntry | null {
  const db = getDb();
  const existing = getMemory(id);
  if (!existing) return null;

  const sets: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const values: any[] = [];

  if (input.topic !== undefined) {
    sets.push("topic = ?");
    values.push(input.topic.slice(0, MAX_TOPIC_CHARS));
  }
  if (input.content !== undefined) {
    sets.push("content = ?");
    values.push(input.content.slice(0, MAX_CONTENT_CHARS));
  }
  if (input.confidence !== undefined) {
    sets.push("confidence = ?");
    values.push(Math.max(0, Math.min(1, input.confidence)));
  }
  if (input.expires_at !== undefined) {
    sets.push("expires_at = ?");
    values.push(input.expires_at);
  }
  if (input.tags !== undefined) {
    sets.push("tags = ?");
    values.push(JSON.stringify(input.tags));
  }

  if (sets.length === 0) return existing;

  values.push(id);
  db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(
    ...values,
  );

  logger.debug({ id }, "Memory updated");
  return getMemory(id)!;
}

/**
 * Mark a memory as superseded by a new one. The old memory is kept
 * for reference but won't appear in recall results.
 */
export function supersedeMemory(oldId: string, newId: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE memories SET superseded_by = ? WHERE id = ?")
    .run(newId, oldId);
  return result.changes > 0;
}

/**
 * Soft-delete a memory by marking it superseded with a sentinel value.
 * It won't appear in recall results but remains in the DB for audit.
 */
export function forgetMemory(id: string): boolean {
  const db = getDb();
  const result = db
    .prepare("UPDATE memories SET superseded_by = '__forgotten__' WHERE id = ?")
    .run(id);
  logger.debug({ id }, "Memory forgotten");
  return result.changes > 0;
}

/**
 * Get all active memories for injection into the LLM context.
 * Returns a summary string suitable for a system prompt.
 */
export function getActiveMemorySummary(limit = 20): MemoryEntry[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE superseded_by IS NULL
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY confidence DESC, learned_at DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToEntry);
}

/**
 * Find memories relevant to a user message by keyword matching.
 */
export function findRelevantMemories(
  userMessage: string,
  limit = 5,
): MemoryEntry[] {
  const keywords = extractKeywords(userMessage);
  if (keywords.length === 0) return [];

  const db = getDb();
  const conditions = keywords
    .slice(0, 5)
    .map(() => "(topic LIKE ? OR content LIKE ? OR tags LIKE ?)");
  const params: string[] = keywords.slice(0, 5).flatMap((kw) => {
    const escaped = escapeLikePattern(kw);
    return [`%${escaped}%`, `%${escaped}%`, `%${escaped}%`];
  });
  params.push(String(limit));

  const rows = db
    .prepare(
      `SELECT * FROM memories
       WHERE superseded_by IS NULL
         AND (expires_at IS NULL OR expires_at > datetime('now'))
         AND (${conditions.join(" OR ")})
       ORDER BY confidence DESC, access_count DESC, learned_at DESC
       LIMIT ?`,
    )
    .all(...params) as Record<string, unknown>[];

  const ids = rows.map((r) => r.id as string);
  if (ids.length > 0) {
    db.prepare(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = datetime('now')
       WHERE id IN (${ids.map(() => "?").join(",")})`,
    ).run(...ids);
  }

  return rows.map(rowToEntry);
}

/**
 * Run maintenance: clean up permanently deleted memories and
 * log stats. Called periodically.
 */
export function runMemoryMaintenance(): {
  totalActive: number;
  totalSuperseded: number;
  totalExpired: number;
} {
  const db = getDb();
  const active = db
    .prepare(
      `SELECT COUNT(*) as count FROM memories
       WHERE superseded_by IS NULL
         AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
    .get() as { count: number };
  const superseded = db
    .prepare(
      `SELECT COUNT(*) as count FROM memories WHERE superseded_by IS NOT NULL`,
    )
    .get() as { count: number };
  const expired = db
    .prepare(
      `SELECT COUNT(*) as count FROM memories
       WHERE superseded_by IS NULL AND expires_at <= datetime('now')`,
    )
    .get() as { count: number };

  // Purge old superseded/forgotten memories (keep last 100 for audit)
  db.prepare(
    `DELETE FROM memories WHERE superseded_by IS NOT NULL
     AND id NOT IN (SELECT id FROM memories WHERE superseded_by IS NOT NULL ORDER BY created_at DESC LIMIT 100)`,
  ).run();

  logger.debug(
    {
      active: active.count,
      superseded: superseded.count,
      expired: expired.count,
    },
    "Memory maintenance completed",
  );

  return {
    totalActive: active.count,
    totalSuperseded: superseded.count,
    totalExpired: expired.count,
  };
}

function enforceMemoryCap(db: DatabaseSync): void {
  const count = db
    .prepare(
      `SELECT COUNT(*) as count FROM memories
       WHERE superseded_by IS NULL
         AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
    .get() as { count: number };

  if (count.count >= MAX_MEMORIES) {
    // Remove lowest-priority memories: low confidence, low access, old
    const toRemove = db
      .prepare(
        `SELECT id FROM memories
         WHERE superseded_by IS NULL
           AND (expires_at IS NULL OR expires_at > datetime('now'))
         ORDER BY confidence ASC, access_count ASC, learned_at ASC
         LIMIT ?`,
      )
      .all(Math.max(1, Math.floor(MAX_MEMORIES * 0.1))) as { id: string }[];

    for (const row of toRemove) {
      db.prepare(
        "UPDATE memories SET superseded_by = '__cap_evicted__' WHERE id = ?",
      ).run(row.id);
    }

    logger.info(
      { evicted: toRemove.length },
      "Memory cap enforced; evicted low-priority memories",
    );
  }
}

/**
 * Extract simple keywords from a message for memory matching.
 * Strips common particles and short words.
 */
function extractKeywords(text: string): string[] {
  const cleaned = text
    .replace(/[。！？、．,\.\!\?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Split on spaces and Japanese particles
  const tokens = cleaned
    .split(/[\sはがをのにへでとやもからまでより]+/)
    .filter((token) => token.length >= 2);

  // Deduplicate and limit
  return [...new Set(tokens)].slice(0, 8);
}

/**
 * Format memories into a system prompt block for LLM injection.
 */
export function formatMemoriesForPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map(
    (m, i) =>
      `[記憶${i + 1}] (ID: ${m.id}, 学習日: ${m.learned_at.slice(0, 10)}, 信頼度: ${m.confidence.toFixed(1)})\n` +
      `  トピック: ${m.topic}\n` +
      `  内容: ${m.content}${m.source_url ? `\n  出典: ${m.source_url}` : ""}`,
  );

  return (
    `<llm_memory>\n` +
    `以下はあなたが過去の会話で学習した記憶です。これらはあなたの知識として扱ってください。\n` +
    `ただし、信頼度が低いものや古い情報には注意してください。必要に応じてmemory_recallツールで詳細を検索できます。\n` +
    `新しい情報で更新すべきだと判断した場合はmemory_updateツールを使用してください。\n\n` +
    `${lines.join("\n\n")}\n` +
    `</llm_memory>`
  );
}
