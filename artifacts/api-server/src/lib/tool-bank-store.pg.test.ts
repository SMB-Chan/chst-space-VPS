import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureToolBankSchema } from "./ensure-schema";
import {
  TOOL_BANK_POLICY,
  ToolBankPolicyError,
  copyToolToProject,
  createToolBankItem,
  listArchiveCandidates,
  listProjectToolCopies,
  listToolBank,
  purgeToolBankItem,
  softDeleteToolBankItem,
  updateToolBankItem,
} from "./tool-bank-store";

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

let pool: (typeof import("@workspace/db"))["pool"];
const createdToolIds: number[] = [];
const createdProjectIds: number[] = [];

function testUserId(label: string): string {
  return `tool-bank-test:${label}:${randomUUID()}`;
}

async function freshProject(userId: string, label: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    "INSERT INTO projects (user_id, name, slug) VALUES ($1, $2, $3) RETURNING id",
    [userId, label, `tool-bank-test-${label}-${randomUUID()}`],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("failed to create test project");
  createdProjectIds.push(id);
  return id;
}

afterAll(async () => {
  if (!pool) return;
  if (createdToolIds.length > 0) {
    await pool.query(
      "DELETE FROM project_tool_copies WHERE tool_id = ANY($1::int[])",
      [createdToolIds],
    );
    await pool.query("DELETE FROM tool_bank WHERE id = ANY($1::int[])", [
      createdToolIds,
    ]);
  }
  if (createdProjectIds.length > 0) {
    await pool.query("DELETE FROM projects WHERE id = ANY($1::int[])", [
      createdProjectIds,
    ]);
  }
});

describePostgres("tool-bank-store", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    await ensureToolBankSchema((sql) => pool.query(sql));
  });

  it("rejects empty names", async () => {
    await expect(
      createToolBankItem(testUserId("name"), {
        name: "   ",
        code: "x",
        summary: "",
      }),
    ).rejects.toBeInstanceOf(ToolBankPolicyError);
  });

  it("rejects code that exceeds the policy cap", async () => {
    const tooBig = "x".repeat(TOOL_BANK_POLICY.MAX_CODE_CHARS + 1);
    await expect(
      createToolBankItem(testUserId("oversize"), {
        name: "oversize",
        code: tooBig,
      }),
    ).rejects.toBeInstanceOf(ToolBankPolicyError);
  });

  it("persists, increments, and copies without breaking invariants", async () => {
    const userId = testUserId("crud");
    const projectId = await freshProject(userId, "crud");

    const created = await createToolBankItem(userId, {
      name: "Format JSON",
      code: "export function ok(){return 1;}\n",
      summary: "整形ユーティリティ",
      language: "typescript",
      tags: ["json", "format"],
      sourceProjectId: projectId,
    });
    createdToolIds.push(created.id);

    expect(created.version).toBe(1);
    expect(created.useCount).toBe(0);
    expect(created.status).toBe("active");
    expect(created.tags).toEqual(["json", "format"]);

    // Update bumps version only when code or status changes.
    const tagsOnly = await updateToolBankItem(userId, created.id, {
      tags: ["json", "format", "lint"],
      changeSummary: "lint タグ追加",
    });
    expect(tagsOnly?.version).toBe(1);

    const codeOnly = await updateToolBankItem(userId, created.id, {
      code: "export function ok(){return 2;}\n",
      changeSummary: "リターン値修正",
    });
    expect(codeOnly?.version).toBe(2);

    // Copying increments use_count and stores a snapshot in project_tool_copies.
    const { toolVersion } = await copyToolToProject(
      userId,
      created.id,
      projectId,
    );
    expect(toolVersion).toBe(2);

    const copies = await listProjectToolCopies(userId, projectId);
    expect(copies).toHaveLength(1);
    expect(copies[0].toolId).toBe(created.id);
    expect(copies[0].toolVersion).toBe(2);

    const afterCopy = await listToolBank(userId, {
      status: "active",
    });
    expect(afterCopy.find((t) => t.id === created.id)?.useCount).toBe(1);

    // Re-copying the same tool to the same project updates the snapshot but
    // does not crash (ON CONFLICT clause).
    const second = await copyToolToProject(userId, created.id, projectId);
    expect(second.toolVersion).toBe(2);
    expect(await listProjectToolCopies(userId, projectId)).toHaveLength(1);
  });

  it("soft-deletes, then refuses to re-update, and is reported via listArchiveCandidates once idle", async () => {
    const userId = testUserId("softdelete");
    const created = await createToolBankItem(userId, {
      name: "Disposable",
      code: "echo ok\n",
    });
    createdToolIds.push(created.id);

    const archived = await softDeleteToolBankItem(userId, created.id);
    expect(archived?.status).toBe("archived");
    expect(archived?.deletedAt).not.toBeNull();

    // Archived rows should not surface in active listings.
    const active = await listToolBank(userId, { status: "active" });
    expect(active.find((t) => t.id === created.id)).toBeUndefined();

    // Updating an archived tool throws.
    await expect(
      updateToolBankItem(userId, created.id, {
        changeSummary: "noop",
        summary: "never",
      }),
    ).rejects.toBeInstanceOf(ToolBankPolicyError);

    // Archived + 180d idle + soft-deleted >= 30d ⇒ eligible for physical purge.
    const { pool: pgPool } = await import("@workspace/db");
    const farPast = new Date(Date.now() - 200 * 86_400_000);
    await pgPool.query(
      "UPDATE tool_bank SET updated_at=$2, last_used_at=$2 WHERE id=$1",
      [created.id, farPast],
    );
    const candidates = await listArchiveCandidates(userId);
    // candidates may include the soft-deleted row's "should-archive" branch via the
    // filter chain; we only assert here that the row is observable to the listing
    // (real purge logic guards against double-purge, tested by the next assertion).
    expect(candidates.find((c) => c.id === created.id)).toBeDefined();

    const purged = await purgeToolBankItem(userId, created.id);
    expect(purged).toBe(true);

    const afterPurge = await listToolBank(userId, { includeDeleted: true });
    expect(afterPurge.find((t) => t.id === created.id)).toBeUndefined();
  });

  it("forbids copying a soft-deleted tool but allows listing historical copies", async () => {
    const userId = testUserId("deletecopy");
    const projectId = await freshProject(userId, "deletecopy");
    const tool = await createToolBankItem(userId, {
      name: "CopyBlocked",
      code: "x",
    });
    createdToolIds.push(tool.id);

    await copyToolToProject(userId, tool.id, projectId);
    await softDeleteToolBankItem(userId, tool.id);

    await expect(
      copyToolToProject(userId, tool.id, projectId),
    ).rejects.toBeInstanceOf(ToolBankPolicyError);

    const copies = await listProjectToolCopies(userId, projectId);
    expect(copies).toHaveLength(1);
    expect(copies[0].toolId).toBe(tool.id);
  });

  it("refuses to copy a tool into another user's project", async () => {
    const owner = testUserId("owner");
    const intruder = testUserId("intruder");
    const ownersProject = await freshProject(owner, "owner");
    const tool = await createToolBankItem(intruder, {
      name: "Intruder",
      code: "x",
    });
    createdToolIds.push(tool.id);

    await expect(
      copyToolToProject(intruder, tool.id, ownersProject),
    ).rejects.toBeInstanceOf(ToolBankPolicyError);
    const rows = await pool.query(
      "SELECT 1 FROM project_tool_copies WHERE project_id = $1",
      [ownersProject],
    );
    expect(rows.rowCount).toBe(0);
  });
});
