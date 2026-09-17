import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Explicit coding mode: the model writes project files by emitting fenced
 * blocks whose info string is `file:<relative-path>`. The server applies the
 * writes inside the project's workspace folder, records a per-file diff and
 * streams the touch list to the chat UI.
 */

export const CODING_FENCE_PREFIX = "file:";
export const CODING_WRITE_MAX_BYTES = 1_000_000;
export const CODING_PATCH_MAX_CHARS = 20_000;
export const CODING_MAX_FILES_PER_TURN = 25;
const DIFF_MAX_LINES = 1200;

export interface CodingFileBlock {
  path: string;
  content: string;
  /** Offset of the opening fence. */
  start: number;
  /** Offset just past the closing fence, used as the scan cursor. */
  end: number;
}

export interface CodingTouch {
  path: string;
  kind: "edit" | "create" | "generate";
  added?: number;
  removed?: number;
  patch?: string | null;
}

export function codingModePrompt(projectFolder: string): string {
  return [
    "【コーディングモード】",
    `この会話は今プロジェクト「${projectFolder}/」のコーディング作業です。`,
    "ファイルを作成・変更するときは、必ず次の形式のフェンスブロックで最終内容全体を出力してください:",
    "```file:<プロジェクト内相対パス>",
    "(ファイル全文)",
    "```",
    "ルール:",
    "- 1ファイル1ブロック。パスは ../ を含まない相対パス。",
    "- フェンスの外には説明・要約・実行手順だけを書く。コード本文を重複させない。",
    "- 部分変更でも全文を出す。省略記号は使わない。",
    "- 変更しないファイルは出力しない。",
    "- ファイルを書かない通常の質問には通常通り答える。",
  ].join("\n");
}

const OPEN_FENCE = /```file:([^\n\r]+)[ \t]*\r?\n/;
const CLOSE_FENCE = /^[ \t]*```[ \t]*$/m;

/**
 * Scan accumulated assistant text for completed `file:` fences starting at
 * `cursor`. Incomplete (still open) fences are left for a later pass.
 */
export function scanCodingFileBlocks(
  text: string,
  cursor: number,
): { blocks: CodingFileBlock[]; cursor: number } {
  const blocks: CodingFileBlock[] = [];
  let next = Math.max(0, cursor);
  while (next < text.length) {
    const slice = text.slice(next);
    const match = OPEN_FENCE.exec(slice);
    if (!match || match.index == null) break;
    const openAt = next + match.index;
    const contentStart = openAt + match[0].length;
    const rest = text.slice(contentStart);
    const close = CLOSE_FENCE.exec(rest);
    if (!close || close.index == null) break;
    const end = contentStart + close.index + close[0].length;
    const rawPath = match[1].trim();
    const clean = normalizeCodingPath(rawPath);
    if (clean) {
      blocks.push({
        path: clean,
        content: rest.slice(0, close.index),
        start: openAt,
        end,
      });
    }
    next = end;
  }
  return { blocks, cursor: next };
}

/** Reject escapes and absolute paths; return a posix-relative path or null. */
export function normalizeCodingPath(raw: string): string | null {
  const cleaned = raw
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .trim();
  if (!cleaned || cleaned.includes("\0")) return null;
  const parts = cleaned.split("/");
  if (parts.some((part) => part === ".." || part === "")) return null;
  return parts.join("/");
}

export function resolveCodingPath(rootDir: string, relPath: string): string {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("プロジェクト外のパスへは書き込めません。");
  }
  return abs;
}

export interface CodingWriteResult {
  kind: "edit" | "create";
  previous: string | null;
}

export function applyCodingWrite(
  rootDir: string,
  relPath: string,
  content: string,
): CodingWriteResult {
  if (Buffer.byteLength(content, "utf8") > CODING_WRITE_MAX_BYTES) {
    throw new Error("書き込み内容が大きすぎます (上限 1MB)。");
  }
  if (content.includes("\0")) {
    throw new Error("バイナリ内容は書き込めません。");
  }
  const abs = resolveCodingPath(rootDir, relPath);
  let previous: string | null = null;
  if (existsSync(abs)) {
    previous = readFileSync(abs, "utf8");
  }
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return { kind: previous === null ? "create" : "edit", previous };
}

export interface LineDiff {
  added: number;
  removed: number;
  patch: string | null;
}

function capPatch(lines: string[], header: string): string {
  const body = lines.join("\n");
  if (body.length <= CODING_PATCH_MAX_CHARS) return `${header}\n${body}`;
  return `${header}\n${body.slice(0, CODING_PATCH_MAX_CHARS)}\n… (diff は途中で省略されています)`;
}

/**
 * Line-level LCS diff. Very large inputs skip patch generation instead of
 * spending quadratic time in the request path.
 */
export function diffLines(previous: string | null, next: string): LineDiff {
  const nextLines = next.split("\n");
  if (previous === null) {
    const added = nextLines.length;
    return {
      added,
      removed: 0,
      patch: capPatch(
        nextLines.map((line) => `+${line}`),
        "@@ new file @@",
      ),
    };
  }
  const prevLines = previous.split("\n");
  if (previous === next) return { added: 0, removed: 0, patch: null };
  if (prevLines.length > DIFF_MAX_LINES || nextLines.length > DIFF_MAX_LINES) {
    return { added: nextLines.length, removed: prevLines.length, patch: null };
  }
  const n = prevLines.length;
  const m = nextLines.length;
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        prevLines[i] === nextLines[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (prevLines[i] === nextLines[j]) {
      i++;
      j++;
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push(`-${prevLines[i]}`);
      removed++;
      i++;
    } else {
      out.push(`+${nextLines[j]}`);
      added++;
      j++;
    }
  }
  while (i < n) {
    out.push(`-${prevLines[i]}`);
    removed++;
    i++;
  }
  while (j < m) {
    out.push(`+${nextLines[j]}`);
    added++;
    j++;
  }
  return {
    added,
    removed,
    patch: out.length > 0 ? capPatch(out, `@@ -1,${n} +1,${m} @@`) : null,
  };
}

export function stripCodingFileBlocks(text: string): string {
  const { blocks } = scanCodingFileBlocks(text, 0);
  if (blocks.length === 0) return text;
  let out = "";
  let pos = 0;
  for (const block of blocks) {
    out += text.slice(pos, block.start);
    pos = block.end;
  }
  out += text.slice(pos);
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function persistableCodingTouch(
  touch: CodingTouch,
): Omit<CodingTouch, "patch"> {
  const next: Omit<CodingTouch, "patch"> = {
    path: touch.path,
    kind: touch.kind,
  };
  if (typeof touch.added === "number") next.added = touch.added;
  if (typeof touch.removed === "number") next.removed = touch.removed;
  return next;
}

/**
 * Apply every completed `file:` fence in `text`. Same path later in the turn
 * overwrites the earlier write. Individual write failures are skipped.
 */
export function applyCompletedCodingWrites(
  rootDir: string,
  text: string,
): { touches: CodingTouch[]; stripped: string } {
  const { blocks } = scanCodingFileBlocks(text, 0);
  const byPath = new Map<string, CodingFileBlock>();
  for (const block of blocks) {
    if (byPath.size >= CODING_MAX_FILES_PER_TURN && !byPath.has(block.path)) {
      continue;
    }
    byPath.set(block.path, block);
  }
  const touches: CodingTouch[] = [];
  for (const block of byPath.values()) {
    try {
      const written = applyCodingWrite(rootDir, block.path, block.content);
      const diff = diffLines(written.previous, block.content);
      touches.push({
        path: block.path,
        kind: written.kind,
        added: diff.added,
        removed: diff.removed,
        patch: diff.patch,
      });
    } catch {
      /* leave the remaining files; this turn still answers */
    }
  }
  return { touches, stripped: stripCodingFileBlocks(text) };
}
