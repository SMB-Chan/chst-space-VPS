/**
 * Google Drive references for projects. Every route is inert (404
 * not_configured) until GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are set; the
 * UI hides the feature based on GET /project-drive/status.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireAuth, getUserId } from "./middleware";
import { logSafeHttpError } from "../lib/http-error-observability";
import { getGoogleAuthRow } from "../lib/google-auth";
import {
  DriveError,
  isDriveIntegrationConfigured,
  searchDriveFiles,
} from "../lib/google-drive";
import { ProjectFileError } from "../lib/project-files-store";
import {
  addProjectDriveFile,
  deleteProjectDriveFile,
  listProjectDriveFiles,
  refreshProjectDriveFile,
  setProjectDriveFileIncluded,
} from "../lib/project-drive-store";

const router: Router = Router();

const DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive",
];

const addSchema = z.object({ fileId: z.string().trim().min(1).max(500) });
const patchSchema = z.object({ includeInContext: z.boolean() });

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function notConfigured(res: Response): boolean {
  if (isDriveIntegrationConfigured()) return false;
  res.status(404).json({
    error: "Googleドライブ連携はサーバーで設定されていません。",
    code: "not_configured",
  });
  return true;
}

function sendError(
  req: Request,
  res: Response,
  err: unknown,
  fallback: string,
) {
  if (err instanceof DriveError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "too_large"
          ? 413
          : err.code === "unsupported"
            ? 422
            : err.code === "not_connected"
              ? 409
              : err.code === "not_configured"
                ? 404
                : 502;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ProjectFileError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "too_many_files"
          ? 409
          : 422;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  logSafeHttpError(req, 500, err);
  res.status(500).json({ error: fallback });
}

router.get(
  "/project-drive/status",
  requireAuth,
  async (req: Request, res: Response) => {
    if (!isDriveIntegrationConfigured()) {
      res.json({ configured: false, connected: false, hasDriveScope: false });
      return;
    }
    try {
      const row = await getGoogleAuthRow(getUserId(req));
      const scopes = (row?.scope ?? "").split(/\s+/);
      res.json({
        configured: true,
        connected: Boolean(row?.refreshToken),
        hasDriveScope: DRIVE_SCOPES.some((s) => scopes.includes(s)),
        accountEmail: row?.accountEmail ?? null,
      });
    } catch (err) {
      sendError(req, res, err, "Google連携の状態を取得できませんでした。");
    }
  },
);

router.get(
  "/project-drive/search",
  requireAuth,
  async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    try {
      const files = await searchDriveFiles(getUserId(req), q);
      res.json({ files });
    } catch (err) {
      sendError(req, res, err, "Googleドライブを検索できませんでした。");
    }
  },
);

router.get(
  "/projects/:id/drive-files",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    if (id == null) {
      res.status(400).json({ error: "IDが不正です。" });
      return;
    }
    try {
      // Listing still works without credentials so existing references stay
      // visible (and removable) if the integration is switched off later.
      const files = await listProjectDriveFiles(getUserId(req), id);
      res.json({ files, configured: isDriveIntegrationConfigured() });
    } catch (err) {
      sendError(req, res, err, "Googleドライブの参照を取得できませんでした。");
    }
  },
);

router.post(
  "/projects/:id/drive-files",
  requireAuth,
  async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    const id = parseId(req.params.id);
    const parsed = addSchema.safeParse(req.body);
    if (id == null || !parsed.success) {
      res.status(400).json({ error: "リクエスト内容が不正です。" });
      return;
    }
    try {
      const file = await addProjectDriveFile(
        getUserId(req),
        id,
        parsed.data.fileId,
      );
      res.status(201).json({ file });
    } catch (err) {
      sendError(
        req,
        res,
        err,
        "Googleドライブのファイルを追加できませんでした。",
      );
    }
  },
);

router.post(
  "/projects/:id/drive-files/:refId/refresh",
  requireAuth,
  async (req: Request, res: Response) => {
    if (notConfigured(res)) return;
    const id = parseId(req.params.id);
    const refId = parseId(req.params.refId);
    if (id == null || refId == null) {
      res.status(400).json({ error: "IDが不正です。" });
      return;
    }
    try {
      const file = await refreshProjectDriveFile(getUserId(req), id, refId, {
        force: true,
      });
      res.json({ file });
    } catch (err) {
      sendError(req, res, err, "Googleドライブから再取得できませんでした。");
    }
  },
);

router.patch(
  "/projects/:id/drive-files/:refId",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const refId = parseId(req.params.refId);
    const parsed = patchSchema.safeParse(req.body);
    if (id == null || refId == null || !parsed.success) {
      res.status(400).json({ error: "リクエスト内容が不正です。" });
      return;
    }
    try {
      const file = await setProjectDriveFileIncluded(
        getUserId(req),
        id,
        refId,
        parsed.data.includeInContext,
      );
      res.json({ file });
    } catch (err) {
      sendError(req, res, err, "設定を更新できませんでした。");
    }
  },
);

router.delete(
  "/projects/:id/drive-files/:refId",
  requireAuth,
  async (req: Request, res: Response) => {
    const id = parseId(req.params.id);
    const refId = parseId(req.params.refId);
    if (id == null || refId == null) {
      res.status(400).json({ error: "IDが不正です。" });
      return;
    }
    try {
      await deleteProjectDriveFile(getUserId(req), id, refId);
      res.status(204).end();
    } catch (err) {
      sendError(req, res, err, "削除できませんでした。");
    }
  },
);

export default router;
