import { logger } from "./logger";

export interface ExtractedArtifact {
  filename: string;
  mime: string;
  content: string;
  size: number;
}

const MAX_ARTIFACTS = 3;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

const EXT_TO_MIME: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json; charset=utf-8",
  html: "text/html; charset=utf-8",
};

const MIME_TO_EXT: Record<string, string> = {
  "text/markdown": "md",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/json": "json",
  "text/html": "html",
};

function sanitizeFilename(raw: string): string | null {
  const name = raw
    .trim()
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  if (!name) return null;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!EXT_TO_MIME[ext]) return null;
  return name;
}

function resolveMime(filename: string, rawMime?: string): string | null {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (rawMime) {
    const base = rawMime.split(";")[0].trim().toLowerCase();
    const expectedExt = MIME_TO_EXT[base];
    if (expectedExt && expectedExt === ext) {
      return EXT_TO_MIME[ext];
    }
  }
  return EXT_TO_MIME[ext] ?? null;
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_-]+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs[m[1].toLowerCase()] = m[2];
  }
  return attrs;
}

/**
 * Extracts fenced artifact blocks from the final assistant answer.
 * Supported phase-1 outputs are text-like files only (md/txt/csv/json/html).
 */
export function extractArtifacts(answer: string): {
  content: string;
  artifacts: ExtractedArtifact[];
} {
  const artifacts: ExtractedArtifact[] = [];
  const re = /```artifact\s*([^\n]*)\n([\s\S]*?)```/gi;
  let cleaned = answer.replace(re, (whole, rawAttrs: string, body: string) => {
    if (artifacts.length >= MAX_ARTIFACTS) return "";
    const attrs = parseAttrs(rawAttrs ?? "");
    const filename = sanitizeFilename(attrs.filename ?? "");
    if (!filename) return "";
    const mime = resolveMime(filename, attrs.mime);
    if (!mime) return "";
    const content = body.replace(/^\n+/, "").replace(/\n+$/, "\n");
    const size = Buffer.byteLength(content, "utf8");
    if (size === 0 || size > MAX_ARTIFACT_BYTES) {
      logger.warn(
        {
          component: "artifact-parser",
          errorCode: "ARTIFACT_EMPTY_OR_TOO_LARGE",
        },
        "Skipping oversized or empty artifact",
      );
      return "";
    }
    artifacts.push({ filename, mime, content, size });
    return "";
  });

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trimEnd();
  if (!cleaned.trim()) {
    cleaned = "ファイルを作成しました。下のカードからダウンロードできます。";
  }
  return { content: cleaned, artifacts };
}
