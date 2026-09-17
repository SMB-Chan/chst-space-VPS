import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireAuth, getUserId } from "./middleware";
import {
  TOOL_BANK_POLICY,
  TOOL_BANK_POLICY_DOC_JA,
  ToolBankPolicyError,
  copyToolToProject,
  createToolBankItem,
  getToolBankItem,
  listArchiveCandidates,
  listProjectToolCopies,
  listToolBank,
  purgeToolBankItem,
  softDeleteToolBankItem,
  updateToolBankItem,
  type ToolBankStatus,
} from "../lib/tool-bank-store";
import { TOOL_BANK_STATUSES } from "@workspace/db";

const router: Router = Router();

const createSchema = z.object({
  name: z.string().min(1).max(160),
  code: z.string().min(1).max(TOOL_BANK_POLICY.MAX_CODE_CHARS),
  summary: z.string().max(TOOL_BANK_POLICY.MAX_SUMMARY_CHARS).optional(),
  language: z.string().max(40).optional(),
  usage: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  slug: z.string().max(80).optional(),
  sourceProjectId: z.number().int().positive().nullish(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  summary: z.string().max(TOOL_BANK_POLICY.MAX_SUMMARY_CHARS).optional(),
  language: z.string().max(40).optional(),
  usage: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  code: z.string().min(1).max(TOOL_BANK_POLICY.MAX_CODE_CHARS).optional(),
  status: z.enum(["active", "deprecated", "archived"]).optional(),
  changeSummary: z.string().min(1).max(2000),
});

function parseId(raw: string | string[]): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number.parseInt(String(value ?? ""), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function statusFilter(raw: unknown): ToolBankStatus | "all" | undefined {
  if (typeof raw !== "string") return undefined;
  if (raw === "all") return "all";
  return (TOOL_BANK_STATUSES as readonly string[]).includes(raw)
    ? (raw as ToolBankStatus)
    : undefined;
}

router.get("/tool-bank/policy", requireAuth, (_req, res) => {
  res.json({
    policy: TOOL_BANK_POLICY,
    doc: TOOL_BANK_POLICY_DOC_JA,
    statuses: TOOL_BANK_STATUSES,
  });
});

router.get("/tool-bank", requireAuth, async (req: Request, res: Response) => {
  try {
    const items = await listToolBank(getUserId(req), {
      status: statusFilter(req.query.status),
      includeDeleted: req.query.includeDeleted === "1",
      query: typeof req.query.q === "string" ? req.query.q : undefined,
    });
    res.json({ tools: items, policy: TOOL_BANK_POLICY });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "一覧を取得できませんでした。",
    });
  }
});

router.get(
  "/tool-bank/archive-candidates",
  requireAuth,
  async (req: Request, res: Response) => {
    try {
      const tools = await listArchiveCandidates(getUserId(req));
      res.json({
        tools,
        rule: `${TOOL_BANK_POLICY.ARCHIVE_IDLE_DAYS}日未使用かつ useCount=0`,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "候補を取得できませんでした。",
      });
    }
  },
);

router.post("/tool-bank", requireAuth, async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "登録内容が不正です。" });
    return;
  }
  try {
    const tool = await createToolBankItem(getUserId(req), parsed.data);
    res.status(201).json({ tool });
  } catch (err) {
    const status = err instanceof ToolBankPolicyError ? 400 : 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "登録できませんでした。",
    });
  }
});

router.get("/tool-bank/:id", requireAuth, async (req: Request, res: Response) => {
  const id = parseId(req.params.id);
  if (id == null) {
    res.status(400).json({ error: "不正なIDです。" });
    return;
  }
  try {
    const tool = await getToolBankItem(getUserId(req), id);
    if (!tool) {
      res.status(404).json({ error: "ツールが見つかりません。" });
      return;
    }
    res.json({ tool });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "取得できませんでした。",
    });
  }
});

router.patch(
  "/tool-bank/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "不正なIDです。" });
      return;
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "更新内容が不正です。changeSummary は必須です。",
      });
      return;
    }
    try {
      const tool = await updateToolBankItem(getUserId(req), id, parsed.data);
      if (!tool) {
        res.status(404).json({ error: "ツールが見つかりません。" });
        return;
      }
      res.json({ tool });
    } catch (err) {
      const status = err instanceof ToolBankPolicyError ? 400 : 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : "更新できませんでした。",
      });
    }
  },
);

router.delete(
  "/tool-bank/:id",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "不正なIDです。" });
      return;
    }
    const hard = req.query.hard === "1";
    try {
      if (hard) {
        const ok = await purgeToolBankItem(getUserId(req), id);
        if (!ok) {
          res.status(404).json({ error: "ツールが見つかりません。" });
          return;
        }
        res.status(204).send();
        return;
      }
      const tool = await softDeleteToolBankItem(getUserId(req), id);
      if (!tool) {
        res.status(404).json({ error: "ツールが見つかりません。" });
        return;
      }
      res.json({ tool });
    } catch (err) {
      const status = err instanceof ToolBankPolicyError ? 400 : 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : "削除できませんでした。",
      });
    }
  },
);

router.post(
  "/tool-bank/:id/copy",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const rawProjectId = (req.body as { projectId?: unknown } | undefined)
      ?.projectId;
    const projectId =
      typeof rawProjectId === "number" &&
      Number.isSafeInteger(rawProjectId) &&
      rawProjectId > 0
        ? rawProjectId
        : null;
    if (id == null || projectId == null) {
      res.status(400).json({ error: "toolId / projectId が不正です。" });
      return;
    }
    try {
      const result = await copyToolToProject(getUserId(req), id, projectId);
      res.json(result);
    } catch (err) {
      const status = err instanceof ToolBankPolicyError ? 400 : 500;
      res.status(status).json({
        error: err instanceof Error ? err.message : "コピーできませんでした。",
      });
    }
  },
);

router.get(
  "/projects/:id/tool-copies",
  requireAuth,
  async (req: Request, res: Response) => {
    const projectId = parseId(req.params.id);
    if (projectId == null) {
      res.status(400).json({ error: "不正なプロジェクトIDです。" });
      return;
    }
    try {
      const copies = await listProjectToolCopies(getUserId(req), projectId);
      res.json({ copies });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "取得できませんでした。",
      });
    }
  },
);

export default router;
