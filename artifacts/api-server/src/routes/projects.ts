import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireAuth, getUserId } from "./middleware";
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

const router: Router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(64).optional(),
  description: z.string().max(2000).nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullish(),
});

const memorySchema = z.object({
  content: z.string().max(20000),
});

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

router.get("/projects", requireAuth, async (req: Request, res: Response) => {
  try {
    res.json({ projects: await listProjects(getUserId(req)) });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "プロジェクト一覧を取得できませんでした。",
    });
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
    res.status(201).json({ project });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "プロジェクトを作成できませんでした。",
    });
  }
});

router.get("/projects/:id", requireAuth, async (req: Request, res: Response) => {
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
    res.status(500).json({
      error: err instanceof Error ? err.message : "プロジェクトを取得できませんでした。",
    });
  }
});

router.patch("/projects/:id", requireAuth, async (req: Request, res: Response) => {
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
    res.status(500).json({
      error: err instanceof Error ? err.message : "更新できませんでした。",
    });
  }
});

router.delete("/projects/:id", requireAuth, async (req: Request, res: Response) => {
  const id = parseProjectId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "不正なプロジェクトIDです。" });
    return;
  }
  try {
    const ok = await deleteProject(getUserId(req), id);
    if (!ok) {
      res.status(404).json({ error: "プロジェクトが見つかりません。" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "削除できませんでした。",
    });
  }
});

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
      res.status(500).json({
        error: err instanceof Error ? err.message : "メモリを取得できませんでした。",
      });
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
      res.status(500).json({
        error: err instanceof Error ? err.message : "保存できませんでした。",
      });
    }
  },
);

export default router;
