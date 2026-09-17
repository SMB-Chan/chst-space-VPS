import { Router, type Request, type Response } from "express";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { requireAuth } from "./middleware";

const router: Router = Router();

function workspaceRoot(): string {
  return (
    process.env.CODE_WORKSPACE_ROOT?.trim() || "/data/code-workspace"
  );
}

/** Resolve a user-supplied relative path inside the workspace (no escape). */
function resolveSafe(relPath: string): string {
  const root = path.resolve(workspaceRoot());
  const cleaned = (relPath || "").replace(/^\/+/, "");
  const abs = path.resolve(root, cleaned);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("ワークスペース外のパスは指定できません。");
  }
  return abs;
}

function ensureRoot(): string {
  const root = workspaceRoot();
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true });
  }
  return root;
}

router.get("/files", requireAuth, (req: Request, res: Response) => {
  try {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const abs = resolveSafe(rel);
    ensureRoot();
    if (!existsSync(abs)) {
      res.status(404).json({ error: "パスが見つかりません。" });
      return;
    }
    const st = statSync(abs);
    if (!st.isDirectory()) {
      res.status(400).json({ error: "ディレクトリではありません。" });
      return;
    }
    const items = readdirSync(abs, { withFileTypes: true })
      .map((entry) => {
        const childAbs = path.join(abs, entry.name);
        let size = 0;
        let mtime: string | null = null;
        try {
          const cst = statSync(childAbs);
          size = cst.size;
          mtime = cst.mtime.toISOString();
        } catch {
          /* ignore */
        }
        return {
          name: entry.name,
          path: path.posix.join(rel.replace(/\/+$/, ""), entry.name).replace(/^\//, ""),
          isDir: entry.isDirectory(),
          size,
          mtime,
        };
      })
      .sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    res.json({
      root: workspaceRoot(),
      path: rel,
      parent: rel ? path.posix.dirname(rel).replace(/^\.$/, "") : null,
      items,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "一覧を取得できませんでした。",
    });
  }
});

router.get("/files/content", requireAuth, (req: Request, res: Response) => {
  try {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const abs = resolveSafe(rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      res.status(404).json({ error: "ファイルが見つかりません。" });
      return;
    }
    const st = statSync(abs);
    if (st.size > 2 * 1024 * 1024) {
      res.status(413).json({ error: "ファイルが大きすぎます（2MB超）。" });
      return;
    }
    const content = readFileSync(abs, "utf8");
    res.json({ path: rel, content, size: st.size });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "読み込みに失敗しました。",
    });
  }
});

router.get("/files/download", requireAuth, (req: Request, res: Response) => {
  try {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    const abs = resolveSafe(rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      res.status(404).json({ error: "ファイルが見つかりません。" });
      return;
    }
    res.download(abs, path.basename(abs));
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "ダウンロードに失敗しました。",
    });
  }
});

router.post("/files/mkdir", requireAuth, (req: Request, res: Response) => {
  try {
    const rel = typeof req.body?.path === "string" ? req.body.path : "";
    if (!rel) {
      res.status(400).json({ error: "パスを指定してください。" });
      return;
    }
    const abs = resolveSafe(rel);
    ensureRoot();
    mkdirSync(abs, { recursive: true });
    res.json({ path: rel, created: true });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "作成に失敗しました。",
    });
  }
});

router.put("/files/content", requireAuth, (req: Request, res: Response) => {
  try {
    const rel = typeof req.body?.path === "string" ? req.body.path : "";
    const content = typeof req.body?.content === "string" ? req.body.content : null;
    if (!rel || content == null) {
      res.status(400).json({ error: "path / content が必要です。" });
      return;
    }
    const abs = resolveSafe(rel);
    ensureRoot();
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    res.json({ path: rel, saved: true, size: Buffer.byteLength(content) });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "保存に失敗しました。",
    });
  }
});

router.post("/files/rename", requireAuth, (req: Request, res: Response) => {
  try {
    const from = typeof req.body?.from === "string" ? req.body.from : "";
    const to = typeof req.body?.to === "string" ? req.body.to : "";
    if (!from || !to) {
      res.status(400).json({ error: "from / to が必要です。" });
      return;
    }
    const absFrom = resolveSafe(from);
    const absTo = resolveSafe(to);
    if (!existsSync(absFrom)) {
      res.status(404).json({ error: "元パスが見つかりません。" });
      return;
    }
    mkdirSync(path.dirname(absTo), { recursive: true });
    renameSync(absFrom, absTo);
    res.json({ from, to, renamed: true });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "名前変更に失敗しました。",
    });
  }
});

router.delete("/files", requireAuth, (req: Request, res: Response) => {
  try {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
    if (!rel) {
      res.status(400).json({ error: "パスを指定してください。" });
      return;
    }
    const abs = resolveSafe(rel);
    const root = path.resolve(workspaceRoot());
    if (abs === root) {
      res.status(400).json({ error: "ルートは削除できません。" });
      return;
    }
    if (!existsSync(abs)) {
      res.status(404).json({ error: "パスが見つかりません。" });
      return;
    }
    rmSync(abs, { recursive: true, force: true });
    res.json({ path: rel, deleted: true });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "削除に失敗しました。",
    });
  }
});

/** Create a project folder under the workspace (used by project create). */
export function createProjectFolder(name: string): string {
  const safe = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .slice(0, 80);
  const folder = safe || `project-${Date.now()}`;
  const abs = resolveSafe(folder);
  ensureRoot();
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true });
  }
  const readme = path.join(abs, "README.md");
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      `# ${name}\n\nチャットから作成されたプロジェクトフォルダです。\n`,
      "utf8",
    );
  }
  return folder;
}

export default router;
