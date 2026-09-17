import { Router, type Request, type Response } from "express";
import { readFileSync, writeFileSync } from "node:fs";
import { requireAuth } from "./middleware";

export type CodeAccessMode = "ask" | "auto" | "full";

const MODES: CodeAccessMode[] = ["ask", "auto", "full"];

function modeFilePath(): string {
  return (
    process.env.OPENCODE_ACCESS_MODE_FILE?.trim() ||
    "/data/opencode-access-mode"
  );
}

function readModeFile(): CodeAccessMode | null {
  try {
    const raw = readFileSync(modeFilePath(), "utf8").trim();
    return (MODES as string[]).includes(raw) ? (raw as CodeAccessMode) : null;
  } catch {
    return null;
  }
}

function envMode(): CodeAccessMode {
  const raw = process.env.OPENCODE_ACCESS_MODE?.trim();
  return (MODES as string[]).includes(raw ?? "")
    ? (raw as CodeAccessMode)
    : "auto";
}

export function resolveCodeAccessMode(): CodeAccessMode {
  return readModeFile() ?? envMode();
}

const router: Router = Router();

/** OpenCode access mode for the VPS coding environment. */
router.get("/dev/access-mode", requireAuth, (_req: Request, res: Response) => {
  res.json({
    mode: resolveCodeAccessMode(),
    modes: MODES,
    notes: {
      ask: "ツール実行のたびに承認が必要です。",
      auto: "自動承認。破壊的なシェルのみ拒否。自律コーディング向け。",
      full: "フルアクセス。すべて許可します（信頼できる単一運用向け）。",
    },
    applyHint:
      "保存後、反映するにはコーディング環境を再起動してください（docker compose restart code）。",
  });
});

router.put("/dev/access-mode", requireAuth, (req: Request, res: Response) => {
  const mode = typeof req.body?.mode === "string" ? req.body.mode : "";
  if (!(MODES as string[]).includes(mode)) {
    res.status(400).json({ error: "mode は ask / auto / full のいずれかです。" });
    return;
  }
  try {
    writeFileSync(modeFilePath(), `${mode}\n`, "utf8");
    res.json({ mode, applied: false, message: "保存しました。反映には code の再起動が必要です。" });
  } catch (err) {
    res.status(500).json({
      error:
        err instanceof Error
          ? `アクセスモードを保存できませんでした: ${err.message}`
          : "アクセスモードを保存できませんでした。",
    });
  }
});

export default router;
