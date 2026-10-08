import { and, asc, eq, sql } from "drizzle-orm";
import { clipHeadUtf8Safe } from "./text-truncation";
import { db, projectFiles, projects } from "@workspace/db";
import { detectBinaryFamily } from "./binary-detection";
import { extractBinaryText } from "./file-extraction";
import type { BinaryAttachment } from "./message-content";
import { getProjectLimits, type ProjectLimits } from "./project-limits";

export type ProjectFileErrorCode =
  | "too_large"
  | "too_many_files"
  | "quota_exceeded"
  | "unsupported_type"
  | "empty"
  | "not_found"
  | "extraction_failed";

export class ProjectFileError extends Error {
  readonly code: ProjectFileErrorCode;

  constructor(code: ProjectFileErrorCode, message: string) {
    super(message);
    this.name = "ProjectFileError";
    this.code = code;
  }
}

export interface ProjectFileMetadata {
  id: number;
  projectId: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  textChars: number;
  includeInContext: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFileUsage {
  totalBytes: number;
  fileCount: number;
}

export interface ProjectFileDownload {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

/**
 * Strip path components and control characters, then trim. Filenames come
 * from untrusted clients and are echoed back in headers and prompts; bounds
 * are tight to keep prompt construction predictable.
 */
export function sanitizeProjectFilename(raw: string): string {
  // Drop control characters first so a NUL can't later survive path splitting.
  const noControl = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  // Only treat the very last path segment as the filename; everything before
  // is dropped (a malicious "../../etc/passwd" becomes "passwd", not "_.._.._etc_passwd").
  const basename = noControl.split(/[\\/]/).pop() ?? "";
  const trimmed = basename.trim().slice(0, 200);
  return trimmed || "file";
}

const TEXT_MIME = "text/plain; charset=utf-8";
const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ZIP_MIME = "application/zip";

function mimeForFamily(family: "pdf" | "docx" | "xlsx" | "pptx"): string {
  switch (family) {
    case "pdf":
      return PDF_MIME;
    case "docx":
      return DOCX_MIME;
    case "xlsx":
      return XLSX_MIME;
    case "pptx":
      return PPTX_MIME;
  }
}

/** PNG / JPEG / GIF / WebP magic numbers (for a clearer rejection message). */
function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const hex = buffer.subarray(0, 4).toString("hex");
  return (
    hex === "89504e47" ||
    hex.startsWith("ffd8ff") ||
    buffer.subarray(0, 4).toString("latin1") === "GIF8" ||
    (buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
      buffer.subarray(8, 12).toString("latin1") === "WEBP")
  );
}

function asTextFile(filename: string, buffer: Buffer, limits: ProjectLimits) {
  // Fatal UTF-8 decoding rejects mojibake early; NULs mark binary content
  // (CSV/text imports must not smuggle past detection via a fake extension).
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new ProjectFileError(
      "unsupported_type",
      "テキストとして解釈できないファイルです。UTF-8 として読み込めるファイルのみアップロードできます。",
    );
  }
  if (decoded.includes("\u0000")) {
    throw new ProjectFileError(
      "unsupported_type",
      "バイナリファイルは未対応です。PDF / Office文書 / UTF-8テキストをアップロードしてください。",
    );
  }
  const clipped = clipHeadUtf8Safe(decoded, limits.fileTextMaxChars, "");
  return {
    extractedText: clipped,
    textChars: clipped.length,
    mimeType: TEXT_MIME,
    filename,
  };
}

async function asBinaryFile(
  filename: string,
  buffer: Buffer,
  family: "pdf" | "docx" | "xlsx" | "pptx",
  limits: ProjectLimits,
): Promise<{
  extractedText: string;
  textChars: number;
  mimeType: string;
  filename: string;
}> {
  const attachment: BinaryAttachment = {
    kind: "binary",
    name: filename,
    buffer,
    bytes: buffer.length,
    family,
    mime: mimeForFamily(family),
  };
  const text = await extractBinaryText(attachment);
  const clipped = clipHeadUtf8Safe(text, limits.fileTextMaxChars, "");
  return {
    extractedText: clipped,
    textChars: clipped.length,
    mimeType: mimeForFamily(family),
    filename,
  };
}

/**
 * Metadata-only projection. Never select `data` (base64, up to ~6.7 MB per
 * file) or `extracted_text` (up to 100k chars) for listings.
 */
const metadataColumns = {
  id: projectFiles.id,
  projectId: projectFiles.projectId,
  filename: projectFiles.filename,
  mimeType: projectFiles.mimeType,
  sizeBytes: projectFiles.sizeBytes,
  textChars: projectFiles.textChars,
  includeInContext: projectFiles.includeInContext,
  createdAt: projectFiles.createdAt,
  updatedAt: projectFiles.updatedAt,
};

type MetadataRow = {
  id: number;
  projectId: number;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  textChars: number;
  includeInContext: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toMetadata(row: MetadataRow): ProjectFileMetadata {
  return {
    id: row.id,
    projectId: row.projectId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    textChars: row.textChars,
    includeInContext: row.includeInContext,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function assertProjectOwnership(
  userId: string,
  projectId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  return !!row;
}

/**
 * Verify that the caller owns the project before any file row is read or
 * written. Anything that fails this check behaves identically to "not found".
 */
async function assertOwnedProject(
  userId: string,
  projectId: number,
): Promise<void> {
  const owned = await assertProjectOwnership(userId, projectId);
  if (!owned) {
    throw new ProjectFileError("not_found", "プロジェクトが見つかりません。");
  }
}

export async function listProjectFiles(
  userId: string,
  projectId: number,
): Promise<ProjectFileMetadata[]> {
  if (!(await assertProjectOwnership(userId, projectId))) return [];
  const rows = await db
    .select(metadataColumns)
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.userId, userId),
      ),
    )
    .orderBy(asc(projectFiles.createdAt), asc(projectFiles.id));
  return rows.map(toMetadata);
}

export async function addProjectFile(
  userId: string,
  projectId: number,
  input: { filename: string; buffer: Buffer },
): Promise<ProjectFileMetadata> {
  const limits = getProjectLimits();
  const filename = sanitizeProjectFilename(input.filename);
  const buffer = input.buffer;
  if (buffer.length === 0) {
    throw new ProjectFileError(
      "empty",
      "空のファイルはアップロードできません。",
    );
  }
  if (buffer.length > limits.fileMaxBytes) {
    throw new ProjectFileError(
      "too_large",
      `ファイルが大きすぎます。1ファイル ${Math.round(limits.fileMaxBytes / 1024 / 1024)}MB 以下にしてください。`,
    );
  }

  const family = detectBinaryFamily(buffer);
  let extracted: {
    extractedText: string;
    textChars: number;
    mimeType: string;
    filename: string;
  };
  if (family === "audio") {
    throw new ProjectFileError(
      "unsupported_type",
      "音声ファイルはまだ未対応です。文書ファイル (PDF / Office) またはテキストをアップロードしてください。",
    );
  }
  if (family === "zip") {
    throw new ProjectFileError(
      "unsupported_type",
      "ZIP アーカイブは未対応です。PDF / Office / テキストをアップロードしてください。",
    );
  }
  if (looksLikeImage(buffer)) {
    throw new ProjectFileError(
      "unsupported_type",
      "画像ファイルはまだ未対応です。PDF / Office文書 / UTF-8テキストをアップロードしてください。",
    );
  }
  try {
    if (
      family === "pdf" ||
      family === "docx" ||
      family === "xlsx" ||
      family === "pptx"
    ) {
      extracted = await asBinaryFile(filename, buffer, family, limits);
    } else if (family === null) {
      extracted = asTextFile(filename, buffer, limits);
    } else {
      throw new ProjectFileError(
        "unsupported_type",
        "このファイル形式には対応していません。PDF / Office / テキストをアップロードしてください。",
      );
    }
  } catch (err) {
    if (err instanceof ProjectFileError) throw err;
    throw new ProjectFileError(
      "extraction_failed",
      "ファイルの内容を抽出できませんでした。",
    );
  }

  // Lock the project row so the count/quota check and insert are atomic.
  return db.transaction(async (tx) => {
    // The byte quota spans all of the user's projects, so serialise uploads
    // per user (the project row lock below only covers one project).
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`project_files:${userId}`}))`,
    );
    const [owned] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .for("update")
      .limit(1);
    if (!owned) {
      throw new ProjectFileError("not_found", "プロジェクトが見つかりません。");
    }

    const [countRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(projectFiles)
      .where(
        and(
          eq(projectFiles.projectId, projectId),
          eq(projectFiles.userId, userId),
        ),
      );
    const existing = countRow?.count ?? 0;
    if (existing >= limits.maxFilesPerProject) {
      throw new ProjectFileError(
        "too_many_files",
        `1プロジェクトあたり最大 ${limits.maxFilesPerProject} ファイルまでです。`,
      );
    }

    const [usageRow] = await tx
      .select({ total: sql<number>`coalesce(sum(size_bytes), 0)::bigint` })
      .from(projectFiles)
      .where(eq(projectFiles.userId, userId));
    const currentTotal = Number(usageRow?.total ?? 0);
    if (currentTotal + buffer.length > limits.userTotalMaxBytes) {
      throw new ProjectFileError(
        "quota_exceeded",
        `プロジェクトファイルの合計サイズが上限を超えています。${Math.round(limits.userTotalMaxBytes / 1024 / 1024)}MB までアップロードできます。`,
      );
    }

    const [row] = await tx
      .insert(projectFiles)
      .values({
        projectId,
        userId,
        filename: extracted.filename,
        mimeType: extracted.mimeType,
        sizeBytes: buffer.length,
        data: buffer.toString("base64"),
        extractedText: extracted.extractedText,
        textChars: extracted.textChars,
        includeInContext: true,
        updatedAt: new Date(),
      })
      .returning(metadataColumns);
    if (!row) {
      throw new Error("project file insert returned no row");
    }
    return toMetadata(row);
  });
}

export async function setProjectFileIncluded(
  userId: string,
  projectId: number,
  fileId: number,
  include: boolean,
): Promise<ProjectFileMetadata | null> {
  await assertOwnedProject(userId, projectId);
  const [row] = await db
    .update(projectFiles)
    .set({ includeInContext: include, updatedAt: new Date() })
    .where(
      and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.userId, userId),
      ),
    )
    .returning(metadataColumns);
  return row ? toMetadata(row) : null;
}

export async function deleteProjectFile(
  userId: string,
  projectId: number,
  fileId: number,
): Promise<boolean> {
  await assertOwnedProject(userId, projectId);
  const deleted = await db
    .delete(projectFiles)
    .where(
      and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.userId, userId),
      ),
    )
    .returning({ id: projectFiles.id });
  return deleted.length > 0;
}

export async function getProjectFileForDownload(
  userId: string,
  projectId: number,
  fileId: number,
): Promise<ProjectFileDownload | null> {
  if (!(await assertProjectOwnership(userId, projectId))) return null;
  const [row] = await db
    .select({
      filename: projectFiles.filename,
      mimeType: projectFiles.mimeType,
      data: projectFiles.data,
    })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.userId, userId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    filename: row.filename,
    mimeType: row.mimeType,
    buffer: Buffer.from(row.data, "base64"),
  };
}

export async function getUserProjectFilesUsage(
  userId: string,
): Promise<ProjectFileUsage> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(size_bytes), 0)::bigint`,
      count: sql<number>`count(*)::int`,
    })
    .from(projectFiles)
    .where(eq(projectFiles.userId, userId));
  return {
    totalBytes: Number(row?.total ?? 0),
    fileCount: Number(row?.count ?? 0),
  };
}
