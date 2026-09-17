import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  toolBank,
  projectToolCopies,
  TOOL_BANK_STATUSES,
  type ToolBankRow,
  type ToolBankStatus,
} from "@workspace/db";
import { TOOL_BANK_POLICY, TOOL_BANK_POLICY_DOC_JA } from "./tool-bank-policy";

export { TOOL_BANK_POLICY, TOOL_BANK_POLICY_DOC_JA };
export type { ToolBankStatus };

export interface ToolBankItem {
  id: number;
  slug: string;
  name: string;
  summary: string;
  language: string;
  code: string;
  usage: string;
  tags: string[];
  sourceProjectId: number | null;
  status: ToolBankStatus;
  version: number;
  changeSummary: string;
  useCount: number;
  lastUsedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export class ToolBankPolicyError extends Error {}

function slugifyToolName(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^a-z0-9぀-ヿ一-鿿_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "tool"
  );
}

function toItem(row: ToolBankRow): ToolBankItem {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    language: row.language,
    code: row.code,
    usage: row.usage,
    tags: Array.isArray(row.tags) ? row.tags : [],
    sourceProjectId: row.sourceProjectId,
    status: row.status as ToolBankStatus,
    version: row.version,
    changeSummary: row.changeSummary,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function validateCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) throw new ToolBankPolicyError("コードが空です。");
  if (trimmed.length > TOOL_BANK_POLICY.MAX_CODE_CHARS) {
    throw new ToolBankPolicyError(
      `コードが長すぎます（最大 ${TOOL_BANK_POLICY.MAX_CODE_CHARS} 文字）。`,
    );
  }
  return trimmed;
}

export interface ListToolBankOptions {
  includeDeleted?: boolean;
  status?: ToolBankStatus | "all";
  query?: string;
}

export async function listToolBank(
  userId: string,
  options: ListToolBankOptions = {},
): Promise<ToolBankItem[]> {
  const conditions = [eq(toolBank.userId, userId)];
  if (!options.includeDeleted) {
    conditions.push(isNull(toolBank.deletedAt));
  }
  if (options.status && options.status !== "all") {
    conditions.push(eq(toolBank.status, options.status));
  }
  const rows = await db
    .select()
    .from(toolBank)
    .where(and(...conditions))
    .orderBy(desc(toolBank.updatedAt));

  const q = options.query?.trim().toLowerCase();
  const items = rows.map(toItem);
  if (!q) return items;
  return items.filter((item) => {
    const hay = [
      item.name,
      item.slug,
      item.summary,
      item.usage,
      item.language,
      item.tags.join(" "),
      item.code.slice(0, 2000),
    ]
      .join("\n")
      .toLowerCase();
    return hay.includes(q);
  });
}

export async function getToolBankItem(
  userId: string,
  id: number,
): Promise<ToolBankItem | null> {
  const [row] = await db
    .select()
    .from(toolBank)
    .where(and(eq(toolBank.userId, userId), eq(toolBank.id, id)))
    .limit(1);
  return row ? toItem(row) : null;
}

export async function createToolBankItem(
  userId: string,
  input: {
    name: string;
    code: string;
    summary?: string;
    language?: string;
    usage?: string;
    tags?: string[];
    slug?: string;
    sourceProjectId?: number | null;
  },
): Promise<ToolBankItem> {
  const name = input.name.trim();
  if (!name) throw new ToolBankPolicyError("名前を入力してください。");
  const code = validateCode(input.code);
  const summary = (input.summary ?? "").trim().slice(0, TOOL_BANK_POLICY.MAX_SUMMARY_CHARS);
  const slugBase = (input.slug?.trim() || slugifyToolName(name)).toLowerCase();
  let slug = slugBase;
  for (let i = 2; i < 50; i += 1) {
    const [existing] = await db
      .select({ id: toolBank.id })
      .from(toolBank)
      .where(and(eq(toolBank.userId, userId), eq(toolBank.slug, slug)))
      .limit(1);
    if (!existing) break;
    slug = `${slugBase}-${i}`;
  }

  const [row] = await db
    .insert(toolBank)
    .values({
      userId,
      slug,
      name,
      summary,
      language: (input.language ?? "text").trim() || "text",
      code,
      usage: (input.usage ?? "").trim(),
      tags: (input.tags ?? []).map((t) => t.trim()).filter(Boolean),
      sourceProjectId: input.sourceProjectId ?? null,
      status: "active",
      version: 1,
      changeSummary: "初回登録",
      updatedAt: new Date(),
    })
    .returning();
  return toItem(row);
}

export async function updateToolBankItem(
  userId: string,
  id: number,
  input: {
    name?: string;
    summary?: string;
    language?: string;
    usage?: string;
    tags?: string[];
    code?: string;
    status?: ToolBankStatus;
    changeSummary: string;
  },
): Promise<ToolBankItem | null> {
  const existing = await getToolBankItem(userId, id);
  if (!existing) return null;
  if (existing.deletedAt) {
    throw new ToolBankPolicyError("削除済みツールは更新できません。");
  }
  if (existing.status === "archived") {
    throw new ToolBankPolicyError(
      "archived ツールは更新できません。新規に bank してください。",
    );
  }

  const changeSummary = input.changeSummary?.trim();
  if (!changeSummary) {
    throw new ToolBankPolicyError(
      "更新には changeSummary（何をなぜ変えたか）が必須です。",
    );
  }

  const codeChanged = input.code != null && validateCode(input.code) !== existing.code;
  const statusChanged =
    input.status != null &&
    TOOL_BANK_STATUSES.includes(input.status) &&
    input.status !== existing.status;

  const nextVersion =
    codeChanged || statusChanged ? existing.version + 1 : existing.version;

  const [row] = await db
    .update(toolBank)
    .set({
      ...(input.name != null ? { name: input.name.trim() } : {}),
      ...(input.summary != null
        ? {
            summary: input.summary
              .trim()
              .slice(0, TOOL_BANK_POLICY.MAX_SUMMARY_CHARS),
          }
        : {}),
      ...(input.language != null
        ? { language: input.language.trim() || "text" }
        : {}),
      ...(input.usage != null ? { usage: input.usage.trim() } : {}),
      ...(input.tags != null
        ? { tags: input.tags.map((t) => t.trim()).filter(Boolean) }
        : {}),
      ...(input.code != null ? { code: validateCode(input.code) } : {}),
      ...(input.status != null && TOOL_BANK_STATUSES.includes(input.status)
        ? { status: input.status }
        : {}),
      version: nextVersion,
      changeSummary,
      updatedAt: new Date(),
    })
    .where(and(eq(toolBank.userId, userId), eq(toolBank.id, id)))
    .returning();
  return toItem(row);
}

/** Soft delete. Physical purge is allowed later per policy. */
export async function softDeleteToolBankItem(
  userId: string,
  id: number,
): Promise<ToolBankItem | null> {
  const existing = await getToolBankItem(userId, id);
  if (!existing) return null;
  if (existing.deletedAt) return existing;
  const [row] = await db
    .update(toolBank)
    .set({
      deletedAt: new Date(),
      status: "archived",
      updatedAt: new Date(),
      changeSummary: "soft delete",
    })
    .where(and(eq(toolBank.userId, userId), eq(toolBank.id, id)))
    .returning();
  return toItem(row);
}

/** Hard delete. Allowed when soft-deleted long enough or archived & idle. */
export async function purgeToolBankItem(
  userId: string,
  id: number,
): Promise<boolean> {
  const existing = await getToolBankItem(userId, id);
  if (!existing) return false;

  const now = Date.now();
  const idleMs =
    now -
    Math.max(
      existing.lastUsedAt ? Date.parse(existing.lastUsedAt) : 0,
      Date.parse(existing.updatedAt),
    );
  const softDeletedMs = existing.deletedAt
    ? now - Date.parse(existing.deletedAt)
    : null;

  const softDeleteOk =
    softDeletedMs != null &&
    softDeletedMs >= TOOL_BANK_POLICY.PURGE_SOFT_DELETE_DAYS * 86_400_000;
  const archivedIdleOk =
    existing.status === "archived" &&
    idleMs >= TOOL_BANK_POLICY.PURGE_ARCHIVED_IDLE_DAYS * 86_400_000;

  if (!softDeleteOk && !archivedIdleOk) {
    throw new ToolBankPolicyError(
      "物理削除は soft delete 後30日、または archived かつ180日未使用のときのみ許可されます。まず soft delete してください。",
    );
  }

  await db
    .delete(projectToolCopies)
    .where(eq(projectToolCopies.toolId, id));
  await db.delete(toolBank).where(and(eq(toolBank.userId, userId), eq(toolBank.id, id)));
  return true;
}

/**
 * Copy a banked tool into a project (snapshot). Increments use stats.
 * Re-copy refreshes the snapshot to the current bank version.
 */
export async function copyToolToProject(
  userId: string,
  toolId: number,
  projectId: number,
): Promise<{ tool: ToolBankItem; toolVersion: number }> {
  const tool = await getToolBankItem(userId, toolId);
  if (!tool) throw new ToolBankPolicyError("ツールが見つかりません。");
  if (tool.deletedAt) {
    throw new ToolBankPolicyError("削除済みツールはコピーできません。");
  }
  if (tool.status === "archived") {
    throw new ToolBankPolicyError("archived ツールはコピーできません。");
  }

  await db
    .insert(projectToolCopies)
    .values({
      projectId,
      userId,
      toolId,
      code: tool.code,
      toolVersion: tool.version,
      copiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [projectToolCopies.projectId, projectToolCopies.toolId],
      set: {
        code: tool.code,
        toolVersion: tool.version,
        copiedAt: new Date(),
      },
    });

  await db
    .update(toolBank)
    .set({
      useCount: sql`${toolBank.useCount} + 1`,
      lastUsedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(toolBank.id, toolId));

  const refreshed = await getToolBankItem(userId, toolId);
  return { tool: refreshed!, toolVersion: tool.version };
}

export async function listProjectToolCopies(
  userId: string,
  projectId: number,
): Promise<
  {
    id: number;
    toolId: number;
    toolVersion: number;
    code: string;
    copiedAt: string;
    name: string | null;
    slug: string | null;
  }[]
> {
  const copies = await db
    .select()
    .from(projectToolCopies)
    .where(
      and(
        eq(projectToolCopies.userId, userId),
        eq(projectToolCopies.projectId, projectId),
      ),
    )
    .orderBy(desc(projectToolCopies.copiedAt));

  const toolIds = copies.map((c) => c.toolId);
  const tools =
    toolIds.length > 0
      ? await db.select().from(toolBank).where(eq(toolBank.userId, userId))
      : [];
  const toolById = new Map(tools.map((t) => [t.id, t]));

  return copies.map((copy) => ({
    id: copy.id,
    toolId: copy.toolId,
    toolVersion: copy.toolVersion,
    code: copy.code,
    copiedAt: copy.copiedAt.toISOString(),
    name: toolById.get(copy.toolId)?.name ?? null,
    slug: toolById.get(copy.toolId)?.slug ?? null,
  }));
}

/** Tools idle long enough to be archived (policy helper for UI / maintenance). */
export async function listArchiveCandidates(
  userId: string,
): Promise<ToolBankItem[]> {
  const cutoff = new Date(
    Date.now() - TOOL_BANK_POLICY.ARCHIVE_IDLE_DAYS * 86_400_000,
  );
  const rows = await db
    .select()
    .from(toolBank)
    .where(
      and(
        eq(toolBank.userId, userId),
        isNull(toolBank.deletedAt),
        ne(toolBank.status, "archived"),
        or(
          sql`${toolBank.lastUsedAt} IS NULL OR ${toolBank.lastUsedAt} < ${cutoff}`,
        ),
        sql`${toolBank.updatedAt} < ${cutoff}`,
      ),
    );
  return rows.map(toItem).filter((item) => item.useCount === 0);
}

export function formatToolBankContext(items: ToolBankItem[]): string | null {
  const active = items
    .filter((item) => !item.deletedAt && item.status === "active")
    .slice(0, 12);
  if (active.length === 0) return null;
  const parts = [
    `<tool_bank>`,
    `他プロジェクトから流用可能なツール候補です。必要なら tool_bank_get で本文を取得し、プロジェクトへコピーして使ってください。`,
  ];
  for (const item of active) {
    parts.push(
      `- #${item.id} ${item.name} [${item.language}] v${item.version} — ${item.summary || "(no summary)"}`,
    );
  }
  parts.push(`</tool_bank>`);
  return parts.join("\n");
}
