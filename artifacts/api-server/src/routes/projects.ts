import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth, getUserId } from "./middleware";
import { logSafeHttpError } from "../lib/http-error-observability";
import {
  PROJECT_MEMORY_SECTIONS,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
  upsertProjectMemorySection,
  type ProjectMemorySection,
} from "../lib/project-memory-store";
import { db, projects, conversations } from "@workspace/db";
import { createProjectFolder, removeProjectFolder } from "./files";
import { projectNameToFolder } from "../lib/workspace-folders";
import {
  getProjectLimits,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
} from "../lib/project-limits";
import {
  addProjectFile,
  deleteProjectFile,
  getProjectFileForDownload,
  getUserProjectFilesUsage,
  listProjectFiles,
  ProjectFileError,
  setProjectFileIncluded,
} from "../lib/project-files-store";

/**
 * Project folders live in the operator's shared coding workspace, and two
 * projects (possibly of different users) with the same name share a folder.
 * Only admins get folders, and a folder is removed only once no remaining
 * project maps to it, so deleting one project never wipes another's files.
 */
async function folderStillReferenced(folder: string): Promise<boolean> {
  const rows = await db.select({ name: projects.name }).from(projects);
  return rows.some((row) => projectNameToFolder(row.name) === folder);
}

const router: Router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(64).optional(),
  description: z.string().max(2000).nullish(),
  instructions: z.string().max(PROJECT_INSTRUCTIONS_MAX_CHARS).nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullish(),
  instructions: z.string().max(PROJECT_INSTRUCTIONS_MAX_CHARS).nullish(),
});

const memorySchema = z.object({
  content: z.string().max(20000),
});

const fileUploadSchema = z.object({
  filename: z.string().min(1).max(200),
  dataBase64: z.string().min(1).max(20_000_000),
});

const filePatchSchema = z.object({
  includeInContext: z.boolean(),
});

const ASSIGN_CONVERSATIONS_LIMIT = 200;

function parseProjectId(raw: string | string[]): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseSection(raw: string | string[]): ProjectMemorySection | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return PROJECT_MEMORY_SECTIONS.includes(value as ProjectMemorySection)
    ? (value as ProjectMemorySection)
    : null;
}

/** Map a typed ProjectFileError to its HTTP status code + Japanese message. */
function projectFileErrorResponse(err: ProjectFileError): {
  status: number;
  body: { error: string; code: string };
} {
  switch (err.code) {
    case "too_large":
      return { status: 413, body: { error: err.message, code: "too_large" } };
    case "too_many_files":
      return {
        status: 409,
        body: { error: err.message, code: "too_many_files" },
      };
    case "quota_exceeded":
      return {
        status: 409,
        body: { error: err.message, code: "quota_exceeded" },
      };
    case "unsupported_type":
      return {
        status: 415,
        body: { error: err.message, code: "unsupported_type" },
      };
    case "empty":
      return { status: 400, body: { error: err.message, code: "empty" } };
    case "not_found":
      return { status: 404, body: { error: err.message, code: "not_found" } };
    case "extraction_failed":
      return {
        status: 422,
        body: { error: err.message, code: "extraction_failed" },
      };
  }
}

function rfc5987ContentDisposition(filename: string): string {
  const fallback = filename.replace(/[^a-zA-Z0-9._-]+/g, "_") || "file";
  const encoded = encodeURIComponent(filename).replace(/'/g, "%27");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

router.get("/projects", requireAuth, async (req: Request, res: Response) => {
  try {
    res.json({ projects: await listProjects(getUserId(req)) });
  } catch (err) {
    logSafeHttpError(req, 500, err);
    res.status(500).json({ error: "プロジェクト一覧を取得できませんでした。" });
  }
});

router.post("/projects", requireAuth, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "プロジェクト名が不正です。" });
    return;
  }
  try {
    const project = await createProject(getUserId(req), parsed.data);
    let folder: string | null = null;
    try {
      if (req.userRole !== "admin") throw new Error("workspace is admin-only");
      folder = createProjectFolder(project.name);
      await upsertProjectMemorySection(
        getUserId(req),
        project.id,
        "structure",
        `ワークスペース: \`${folder}/\``,
      );
    } catch {
      /* folder creation is best-effort */
    }
    const full = await getProject(getUserId(req), project.id);
    res.status(201).json({ project: full ?? project, folder });
  } catch (err) {
    res.status(400).json({
      error:
        err instanceof Error
          ? err.message
          : "プロジェクトを作成できませんでした。",
    });
  }
});

/** Limits + the caller's current usage. Must be registered BEFORE /projects/:id. */
router.get(
  "/projects/limits",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const usage = await getUserProjectFilesUsage(getUserId(req));
      res.json({ limits: getProjectLimits(), usage });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res
        .status(500)
        .json({ error: "プロジェクトの上限を取得できませんでした。" });
    }
  },
);

router.get(
  "/projects/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "不正なプロジェクトIDです。" });
      return;
    }
    try {
      const project = await getProject(getUserId(req), id);
      if (!project) {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      res.json({ project });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "プロジェクトを取得できませんでした。" });
    }
  },
);

router.patch(
  "/projects/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "不正なプロジェクトIDです。" });
      return;
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "更新内容が不正です。" });
      return;
    }
    try {
      const project = await updateProject(getUserId(req), id, parsed.data);
      if (!project) {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      res.json({ project });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : "更新できませんでした。",
      });
    }
  },
);

router.delete(
  "/projects/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "不正なプロジェクトIDです。" });
      return;
    }
    try {
      const project = await getProject(getUserId(req), id);
      if (!project) {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      // Drop the FK to the project before removing the row; files cascade via
      // the ON DELETE CASCADE FK so they need no extra step.
      await db.transaction(async (tx) => {
        await tx
          .update(conversations)
          .set({ projectId: null })
          .where(
            and(
              eq(conversations.projectId, id),
              eq(conversations.userId, getUserId(req)),
            ),
          );
        await tx
          .delete(projects)
          .where(and(eq(projects.userId, getUserId(req)), eq(projects.id, id)));
      });
      let folderDeleted = false;
      if (
        project &&
        req.userRole === "admin" &&
        !(await folderStillReferenced(projectNameToFolder(project.name)))
      ) {
        try {
          removeProjectFolder(project.name);
          folderDeleted = true;
        } catch {
          /* keep the deletion; the folder can be cleaned up manually */
        }
      }
      res.json({ deleted: true, folderDeleted });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "削除できませんでした。" });
    }
  },
);

router.get(
  "/projects/:id/memory",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "不正なプロジェクトIDです。" });
      return;
    }
    try {
      const project = await getProject(getUserId(req), id);
      if (!project) {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      res.json({
        projectId: project.id,
        name: project.name,
        memory: project.memory,
        sections: PROJECT_MEMORY_SECTIONS,
        updatedAt: project.memoryUpdatedAt,
      });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "メモリを取得できませんでした。" });
    }
  },
);

router.put(
  "/projects/:id/memory/:section",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    const section = parseSection(req.params.section);
    if (id == null || section == null) {
      res.status(400).json({ error: "不正なリクエストです。" });
      return;
    }
    const parsed = memorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "内容が長すぎるか不正です。" });
      return;
    }
    try {
      const memory = await upsertProjectMemorySection(
        getUserId(req),
        id,
        section,
        parsed.data.content,
      );
      if (!memory) {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      res.json({ projectId: id, section, memory });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "保存できませんでした。" });
    }
  },
);

// --- Reference files ----------------------------------------------------

const BASE64_REGEX = /^[A-Za-z0-9+/]*={0,2}$/;

router.get(
  "/projects/:id/files",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "不正なプロジェクトIDです。" });
      return;
    }
    try {
      const project = await getProject(getUserId(req), id);
      if (!project) {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      const files = await listProjectFiles(getUserId(req), id);
      res.json({ files });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "ファイル一覧を取得できませんでした。" });
    }
  },
);

router.post(
  "/projects/:id/files",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "不正なプロジェクトIDです。" });
      return;
    }
    const parsed = fileUploadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "アップロード形式が不正です。" });
      return;
    }
    const { filename, dataBase64 } = parsed.data;
    // Strict base64 check (no whitespace) so a malformed body never reaches
    // Buffer.from() and silently becomes garbage bytes.
    if (!BASE64_REGEX.test(dataBase64)) {
      res.status(400).json({ error: "添付データのbase64形式が不正です。" });
      return;
    }
    // Length bound BEFORE decoding so a hostile client can't trick us into
    // allocating >5 MiB then rejecting it.
    const limits = getProjectLimits();
    const maxEncoded = Math.ceil((limits.fileMaxBytes * 4) / 3) + 4;
    if (dataBase64.length > maxEncoded) {
      res.status(413).json({
        error: `ファイルが大きすぎます。1ファイル ${Math.round(limits.fileMaxBytes / 1024 / 1024)}MB 以下にしてください。`,
      });
      return;
    }
    const buffer = Buffer.from(dataBase64, "base64");
    if (buffer.length === 0) {
      res.status(400).json({
        error: "空のファイルはアップロードできません。",
      });
      return;
    }
    try {
      const meta = await addProjectFile(getUserId(req), id, {
        filename,
        buffer,
      });
      res.status(201).json({ file: meta });
    } catch (err) {
      if (err instanceof ProjectFileError) {
        const mapped = projectFileErrorResponse(err);
        res.status(mapped.status).json(mapped.body);
        return;
      }
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "ファイルのアップロードに失敗しました。" });
    }
  },
);

router.patch(
  "/projects/:id/files/:fileId",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    const fileId = parseProjectId(req.params.fileId);
    if (id == null || fileId == null) {
      res.status(400).json({ error: "IDが不正です。" });
      return;
    }
    const parsed = filePatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "リクエスト内容が不正です。" });
      return;
    }
    try {
      const meta = await setProjectFileIncluded(
        getUserId(req),
        id,
        fileId,
        parsed.data.includeInContext,
      );
      if (!meta) {
        res.status(404).json({ error: "ファイルが見つかりません。" });
        return;
      }
      res.json({ file: meta });
    } catch (err) {
      if (err instanceof ProjectFileError && err.code === "not_found") {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "ファイルを更新できませんでした。" });
    }
  },
);

router.delete(
  "/projects/:id/files/:fileId",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    const fileId = parseProjectId(req.params.fileId);
    if (id == null || fileId == null) {
      res.status(400).json({ error: "IDが不正です。" });
      return;
    }
    try {
      const ok = await deleteProjectFile(getUserId(req), id, fileId);
      if (!ok) {
        res.status(404).json({ error: "ファイルが見つかりません。" });
        return;
      }
      res.status(204).send();
    } catch (err) {
      if (err instanceof ProjectFileError && err.code === "not_found") {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "ファイルを削除できませんでした。" });
    }
  },
);

router.get(
  "/projects/:id/files/:fileId/download",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    const fileId = parseProjectId(req.params.fileId);
    if (id == null || fileId == null) {
      res.status(400).json({ error: "IDが不正です。" });
      return;
    }
    try {
      const download = await getProjectFileForDownload(
        getUserId(req),
        id,
        fileId,
      );
      if (!download) {
        res.status(404).json({ error: "ファイルが見つかりません。" });
        return;
      }
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        rfc5987ContentDisposition(download.filename),
      );
      res.setHeader("Content-Length", String(download.buffer.length));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.send(download.buffer);
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "ファイルの取得に失敗しました。" });
    }
  },
);

// --- Conversations inside a project ----------------------------------

router.get(
  "/projects/:id/conversations",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "不正なプロジェクトIDです。" });
      return;
    }
    try {
      const project = await getProject(getUserId(req), id);
      if (!project) {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      const rows = await db
        .select({
          id: conversations.id,
          title: conversations.title,
          createdAt: conversations.createdAt,
          projectId: conversations.projectId,
        })
        .from(conversations)
        .where(
          and(
            eq(conversations.projectId, id),
            eq(conversations.userId, getUserId(req)),
          ),
        )
        .orderBy(desc(conversations.createdAt))
        .limit(ASSIGN_CONVERSATIONS_LIMIT);
      res.json({
        conversations: rows.map((row) => ({
          id: row.id,
          title: row.title,
          createdAt: row.createdAt.toISOString(),
          projectId: row.projectId,
        })),
      });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "会話一覧を取得できませんでした。" });
    }
  },
);

router.put(
  "/projects/:id/conversations/:conversationId",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    const conversationId = parseProjectId(req.params.conversationId);
    if (id == null || conversationId == null) {
      res.status(400).json({ error: "IDが不正です。" });
      return;
    }
    try {
      const project = await getProject(getUserId(req), id);
      if (!project) {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      const [updated] = await db
        .update(conversations)
        .set({ projectId: id })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.userId, getUserId(req)),
          ),
        )
        .returning({
          id: conversations.id,
          title: conversations.title,
          projectId: conversations.projectId,
        });
      if (!updated) {
        res.status(404).json({ error: "会話が見つかりません。" });
        return;
      }
      res.json({ conversation: updated });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "会話を割り当てできませんでした。" });
    }
  },
);

router.delete(
  "/projects/:id/conversations/:conversationId",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseProjectId(req.params.id);
    const conversationId = parseProjectId(req.params.conversationId);
    if (id == null || conversationId == null) {
      res.status(400).json({ error: "IDが不正です。" });
      return;
    }
    try {
      const project = await getProject(getUserId(req), id);
      if (!project) {
        res.status(404).json({ error: "プロジェクトが見つかりません。" });
        return;
      }
      const [updated] = await db
        .update(conversations)
        .set({ projectId: null })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.projectId, id),
            eq(conversations.userId, getUserId(req)),
          ),
        )
        .returning({
          id: conversations.id,
          title: conversations.title,
          projectId: conversations.projectId,
        });
      if (!updated) {
        res.status(404).json({ error: "会話が見つかりません。" });
        return;
      }
      res.json({ conversation: updated });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      res.status(500).json({ error: "会話を外せませんでした。" });
    }
  },
);

export default router;
