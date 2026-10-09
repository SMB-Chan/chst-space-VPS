/**
 * Google Drive access for project references (per-user OAuth, Drive REST v3
 * via plain fetch; no googleapis dependency). Files are fetched on demand and
 * only their extracted text is cached in PostgreSQL.
 */
import { getValidAccessToken, isGoogleOAuthConfigured } from "./google-auth";
import { getProjectLimits, type ProjectLimits } from "./project-limits";
import {
  extractProjectFileContent,
  ProjectFileError,
} from "./project-files-store";
import {
  escapeDriveQueryLiteral,
  isValidDriveFileId,
} from "./google-drive-utils";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Google-native formats exported as text (Drive cannot download them raw). */
const GOOGLE_EXPORT_MIME: Record<string, { mime: string; ext: string }> = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: ".csv" },
  "application/vnd.google-apps.presentation": {
    mime: "text/plain",
    ext: ".txt",
  },
};

const DRIVE_FILE_MAX_BYTES_DEFAULT = 50 * 1024 * 1024;

/** Max bytes downloaded from Drive for one reference (env-overridable). */
export function getDriveFileMaxBytes(): number {
  const raw = Number(process.env.GOOGLE_DRIVE_FILE_MAX_BYTES);
  if (Number.isFinite(raw) && raw >= 1024 && raw <= 200 * 1024 * 1024) {
    return Math.floor(raw);
  }
  return DRIVE_FILE_MAX_BYTES_DEFAULT;
}

export function isDriveIntegrationConfigured(): boolean {
  return isGoogleOAuthConfigured();
}

export class DriveError extends Error {
  constructor(
    public readonly code:
      | "not_configured"
      | "not_connected"
      | "not_found"
      | "too_large"
      | "unsupported"
      | "upstream",
    message: string,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

export interface DriveFileInfo {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  modifiedTime: string | null;
  webViewLink: string | null;
}

async function driveFetch(
  userId: string,
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  let token: string;
  try {
    token = await getValidAccessToken(userId);
  } catch (err) {
    throw new DriveError(
      "not_connected",
      err instanceof Error ? err.message : "Googleアカウントが未連携です。",
    );
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (res.ok) return res;
  const detail = await res.text().catch(() => "");
  if (res.status === 404) {
    throw new DriveError(
      "not_found",
      "Googleドライブのファイルが見つかりません（削除されたか、アクセス権がありません）。",
    );
  }
  if (res.status === 401 || res.status === 403) {
    if (/exportSizeLimitExceeded/.test(detail)) {
      throw new DriveError(
        "too_large",
        "Googleドキュメントが大きすぎてテキストに書き出せません（Drive の書き出し上限 10MB）。",
      );
    }
    throw new DriveError(
      "not_connected",
      "Googleドライブへのアクセスが拒否されました。設定ページからGoogle連携をやり直してください。",
    );
  }
  throw new DriveError(
    "upstream",
    `Googleドライブの呼び出しに失敗しました (${res.status})。`,
  );
}

function toInfo(raw: {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  webViewLink?: string;
}): DriveFileInfo {
  const size = raw.size != null ? Number(raw.size) : NaN;
  return {
    id: raw.id,
    name: raw.name ?? "(名前なし)",
    mimeType: raw.mimeType ?? "application/octet-stream",
    sizeBytes: Number.isFinite(size) ? size : null,
    modifiedTime: raw.modifiedTime ?? null,
    webViewLink: raw.webViewLink ?? null,
  };
}

const FILE_FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink";

/**
 * Search the user's Drive by name (and full text). Empty query → most
 * recently modified files. Folders and trashed files are excluded.
 */
export async function searchDriveFiles(
  userId: string,
  query: string,
  options: { pageSize?: number; signal?: AbortSignal } = {},
): Promise<DriveFileInfo[]> {
  const clauses = ["trashed = false", `mimeType != '${FOLDER_MIME}'`];
  const q = query.trim().slice(0, 200);
  if (q) {
    const lit = escapeDriveQueryLiteral(q);
    clauses.push(`(name contains '${lit}' or fullText contains '${lit}')`);
  }
  const params = new URLSearchParams({
    q: clauses.join(" and "),
    pageSize: String(Math.min(Math.max(options.pageSize ?? 25, 1), 50)),
    fields: `files(${FILE_FIELDS})`,
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
    spaces: "drive",
  });
  // Drive rejects orderBy together with fullText search.
  if (!q) params.set("orderBy", "modifiedTime desc");
  const res = await driveFetch(
    userId,
    `${DRIVE_API}/files?${params}`,
    options.signal,
  );
  const data = (await res.json()) as {
    files?: Parameters<typeof toInfo>[0][];
  };
  return (data.files ?? []).map(toInfo);
}

export async function getDriveFileInfo(
  userId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<DriveFileInfo> {
  if (!isValidDriveFileId(fileId)) {
    throw new DriveError("not_found", "DriveファイルIDが不正です。");
  }
  const params = new URLSearchParams({
    fields: FILE_FIELDS,
    supportsAllDrives: "true",
  });
  const res = await driveFetch(
    userId,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params}`,
    signal,
  );
  return toInfo((await res.json()) as Parameters<typeof toInfo>[0]);
}

/** Read a response body, aborting once it exceeds maxBytes. */
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new DriveError(
      "too_large",
      `Googleドライブのファイルが大きすぎます（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）。`,
    );
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new DriveError(
        "too_large",
        `Googleドライブのファイルが大きすぎます（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）。`,
      );
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export interface DriveExtraction {
  info: DriveFileInfo;
  extractedText: string;
  textChars: number;
}

/**
 * Download (or export, for Google Docs/Sheets/Slides) a Drive file and
 * extract its text with the same pipeline as local uploads. Only the text is
 * returned; the bytes are discarded.
 */
export async function fetchDriveFileText(
  userId: string,
  fileId: string,
  options: {
    signal?: AbortSignal;
    limits?: ProjectLimits;
    info?: DriveFileInfo;
  } = {},
): Promise<DriveExtraction> {
  const limits = options.limits ?? getProjectLimits();
  const info =
    options.info ?? (await getDriveFileInfo(userId, fileId, options.signal));
  if (info.mimeType === FOLDER_MIME) {
    throw new DriveError("unsupported", "フォルダは追加できません。");
  }
  const maxBytes = getDriveFileMaxBytes();
  const exportAs = GOOGLE_EXPORT_MIME[info.mimeType];
  let buffer: Buffer;
  let filename = info.name;
  if (exportAs) {
    const params = new URLSearchParams({ mimeType: exportAs.mime });
    const res = await driveFetch(
      userId,
      `${DRIVE_API}/files/${encodeURIComponent(info.id)}/export?${params}`,
      options.signal,
    );
    buffer = await readCapped(res, maxBytes);
    if (!filename.toLowerCase().endsWith(exportAs.ext))
      filename += exportAs.ext;
  } else if (info.mimeType.startsWith("application/vnd.google-apps.")) {
    throw new DriveError(
      "unsupported",
      "この種類のGoogleファイル（フォーム・図形など）はテキスト化できません。",
    );
  } else {
    if (info.sizeBytes != null && info.sizeBytes > maxBytes) {
      throw new DriveError(
        "too_large",
        `Googleドライブのファイルが大きすぎます（上限 ${Math.round(maxBytes / 1024 / 1024)}MB）。`,
      );
    }
    const params = new URLSearchParams({
      alt: "media",
      supportsAllDrives: "true",
    });
    const res = await driveFetch(
      userId,
      `${DRIVE_API}/files/${encodeURIComponent(info.id)}?${params}`,
      options.signal,
    );
    buffer = await readCapped(res, maxBytes);
  }
  if (buffer.length === 0) {
    return { info, extractedText: "", textChars: 0 };
  }
  try {
    const extracted = await extractProjectFileContent(filename, buffer, limits);
    return {
      info,
      extractedText: extracted.extractedText,
      textChars: extracted.textChars,
    };
  } catch (err) {
    if (err instanceof ProjectFileError) {
      throw new DriveError("unsupported", err.message);
    }
    throw err;
  }
}

export {
  clipDriveTextForTool,
  escapeDriveQueryLiteral,
  isValidDriveFileId,
  parseDriveFileId,
} from "./google-drive-utils";
