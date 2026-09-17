import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Explicit coding mode: the model inspects the project with tools, then
 * writes files via search-replace / full write. `file:` fences remain a
 * fallback when the model cannot call tools.
 */

export const CODING_FENCE_PREFIX = "file:";
export const CODING_WRITE_MAX_BYTES = 1_000_000;
export const CODING_PATCH_MAX_CHARS = 20_000;
export const CODING_MAX_FILES_PER_TURN = 25;
export const CODING_READ_MAX_BYTES = 200_000;
export const CODING_SEARCH_MAX_MATCHES = 40;
export const CODING_TREE_MAX_ENTRIES = 180;
export const CODING_LIST_MAX_ENTRIES = 200;
const DIFF_MAX_LINES = 1200;
const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "vendor",
]);
const BINARY_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "pdf",
  "zip",
  "gz",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "mp3",
  "mp4",
  "wasm",
  "sqlite",
  "bin",
]);

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
    `プロジェクト「${projectFolder}/」を自律的に編集します。`,
    "ツール:",
    "- code_list: ディレクトリ一覧",
    "- code_read: ファイル読み取り",
    "- code_search: 内容検索",
    "- code_edit: 既存ファイルの部分置換（推奨）",
    "- code_write: 新規作成または全文置換",
    "手順:",
    "- 書く前に list/search/read で現状を確認する。推測で上書きしない。",
    "- 既存ファイルは code_edit。unique な old_string を使う。",
    "- 新規ファイルだけ code_write。",
    "- 変更しないファイルは触らない。",
    "- 回答本文にコード全文を貼らない。何をなぜ変えたか短く書く。",
    "- ツールが使えないときだけ ```file:<相対パス> フェンスで全文を出す。",
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

function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith(".git");
}

function isProbablyBinary(relPath: string, sample?: string): boolean {
  const ext = path.extname(relPath).slice(1).toLowerCase();
  if (BINARY_EXT.has(ext)) return true;
  return Boolean(sample?.includes("\0"));
}

export interface CodingDirEntry {
  path: string;
  isDir: boolean;
  size: number;
}

export function listCodingDir(rootDir: string, relPath = ""): CodingDirEntry[] {
  const clean = relPath ? normalizeCodingPath(relPath) : "";
  if (relPath && !clean) throw new Error("パスが不正です。");
  const abs = clean ? resolveCodingPath(rootDir, clean) : path.resolve(rootDir);
  if (!existsSync(abs)) throw new Error("パスが見つかりません。");
  const st = statSync(abs);
  if (!st.isDirectory()) throw new Error("ディレクトリではありません。");
  const entries = readdirSync(abs, { withFileTypes: true })
    .filter((entry) => !isSkippedDir(entry.name))
    .slice(0, CODING_LIST_MAX_ENTRIES)
    .map((entry) => {
      const child = path.join(abs, entry.name);
      let size = 0;
      try {
        size = statSync(child).size;
      } catch {
        /* ignore */
      }
      const childRel = clean ? `${clean}/${entry.name}` : entry.name;
      return { path: childRel, isDir: entry.isDirectory(), size };
    });
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
  return entries;
}

export function formatCodingTree(
  rootDir: string,
  maxEntries = CODING_TREE_MAX_ENTRIES,
): string {
  const lines: string[] = [];
  const walk = (dir: string, rel: string, depth: number): void => {
    if (lines.length >= maxEntries) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    names.sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      if (lines.length >= maxEntries) return;
      if (isSkippedDir(name)) continue;
      const abs = path.join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      const indent = "  ".repeat(depth);
      lines.push(isDir ? `${indent}${name}/` : `${indent}${name}`);
      if (isDir && depth < 4) walk(abs, childRel, depth + 1);
    }
  };
  if (!existsSync(rootDir)) return "(プロジェクトフォルダがありません)";
  walk(rootDir, "", 0);
  if (lines.length === 0) return "(空のプロジェクト)";
  if (lines.length >= maxEntries) lines.push("…");
  return lines.join("\n");
}

export interface CodingFileRead {
  path: string;
  content: string;
  startLine: number;
  endLine: number;
  truncated: boolean;
}

export function readCodingFile(
  rootDir: string,
  relPath: string,
  offset = 1,
  limit = 400,
): CodingFileRead {
  const clean = normalizeCodingPath(relPath);
  if (!clean) throw new Error("パスが不正です。");
  const abs = resolveCodingPath(rootDir, clean);
  if (!existsSync(abs)) throw new Error("ファイルが見つかりません。");
  const st = statSync(abs);
  if (st.isDirectory())
    throw new Error("ディレクトリです。code_list を使ってください。");
  if (st.size > CODING_READ_MAX_BYTES) {
    throw new Error("ファイルが大きすぎます (上限 200KB)。");
  }
  const raw = readFileSync(abs, "utf8");
  if (isProbablyBinary(clean, raw)) {
    throw new Error("バイナリファイルは読めません。");
  }
  const lines = raw.split("\n");
  const start = Math.max(1, Math.floor(offset));
  const take = Math.max(1, Math.min(2_000, Math.floor(limit)));
  const slice = lines.slice(start - 1, start - 1 + take);
  const numbered = slice.map(
    (line, index) => `${String(start + index).padStart(5, " ")}|${line}`,
  );
  return {
    path: clean,
    content: numbered.join("\n"),
    startLine: start,
    endLine: start + slice.length - 1,
    truncated: start - 1 + take < lines.length,
  };
}

export interface CodingSearchHit {
  path: string;
  line: number;
  text: string;
}

export function searchCodingFiles(
  rootDir: string,
  query: string,
  opts?: { path?: string; glob?: string; maxResults?: number },
): CodingSearchHit[] {
  const needle = query.trim();
  if (!needle) throw new Error("検索クエリが空です。");
  let pattern: RegExp;
  try {
    pattern = new RegExp(needle, "m");
  } catch {
    pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "m");
  }
  const startRel = opts?.path ? normalizeCodingPath(opts.path) : "";
  if (opts?.path && startRel == null) throw new Error("パスが不正です。");
  const startAbs = startRel
    ? resolveCodingPath(rootDir, startRel)
    : path.resolve(rootDir);
  const glob = opts?.glob?.replace(/^\*\*\//, "").replace(/^\*\./, ".") ?? "";
  const maxResults = Math.min(
    CODING_SEARCH_MAX_MATCHES,
    Math.max(1, opts?.maxResults ?? CODING_SEARCH_MAX_MATCHES),
  );
  const hits: CodingSearchHit[] = [];
  const walk = (dir: string, rel: string): void => {
    if (hits.length >= maxResults) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (hits.length >= maxResults) return;
      if (isSkippedDir(name)) continue;
      const abs = path.join(dir, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(abs, childRel);
        continue;
      }
      if (glob && !childRel.endsWith(glob) && !name.endsWith(glob)) continue;
      if (st.size > CODING_READ_MAX_BYTES) continue;
      if (isProbablyBinary(childRel)) continue;
      let text: string;
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\0")) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= maxResults) return;
        if (pattern.test(lines[i] ?? "")) {
          hits.push({
            path: childRel,
            line: i + 1,
            text: (lines[i] ?? "").slice(0, 240),
          });
        }
        pattern.lastIndex = 0;
      }
    }
  };
  if (!existsSync(startAbs)) throw new Error("パスが見つかりません。");
  const startSt = statSync(startAbs);
  if (startSt.isDirectory()) walk(startAbs, startRel ?? "");
  else if (startRel) {
    walk(path.dirname(startAbs), path.posix.dirname(startRel));
    return hits.filter((hit) => hit.path === startRel);
  }
  return hits;
}

export function applyCodingEdit(
  rootDir: string,
  relPath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): CodingTouch {
  const clean = normalizeCodingPath(relPath);
  if (!clean) throw new Error("パスが不正です。");
  if (!oldString) throw new Error("old_string が空です。");
  if (oldString === newString) {
    throw new Error("old_string と new_string が同じです。");
  }
  const abs = resolveCodingPath(rootDir, clean);
  if (!existsSync(abs)) throw new Error("ファイルが見つかりません。");
  const previous = readFileSync(abs, "utf8");
  const occurrences = previous.split(oldString).length - 1;
  if (occurrences === 0) {
    throw new Error("old_string がファイル内に見つかりません。");
  }
  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string が ${occurrences} 箇所あります。もっと長い文脈を含めるか replace_all を使ってください。`,
    );
  }
  const next = replaceAll
    ? previous.split(oldString).join(newString)
    : previous.replace(oldString, newString);
  const written = applyCodingWrite(rootDir, clean, next);
  const diff = diffLines(written.previous, next);
  return {
    path: clean,
    kind: written.kind,
    added: diff.added,
    removed: diff.removed,
    patch: diff.patch,
  };
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
