import { and, asc, eq, sql } from "drizzle-orm";
import { clipHeadUtf8Safe } from "./text-truncation";
import { db, projectFiles, projects } from "@workspace/db";
import { detectBinaryFamily } from "./binary-detection";
import { extractBinaryText } from "./file-extraction";
import type { BinaryAttachment } from "./message-content";
import { getProjectLimits, type ProjectLimits } from "./project-limits";
import { logger } from "./logger";
import {
  describeProjectImage,
  detectProjectImageFormat,
  formatImageDescriptionText,
  processProjectImage,
  ProjectImageDecodeError,
  resolveImageDescribeModel,
  storedImageFilename,
  toVisionDataUrl,
  type ProjectImageUserRole,
} from "./project-images";
import { getModelLabel } from "./ai-clients";

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
  kind: ProjectFileKind;
  imageWidth: number | null;
  imageHeight: number | null;
  hasThumbnail: boolean;
  sendImage: boolean;
  descriptionStatus: ProjectImageDescriptionStatus;
  descriptionModel: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ProjectFileKind = "document" | "image";
export type ProjectImageDescriptionStatus =
  "none" | "pending" | "ready" | "unavailable" | "failed";

/** A description still "pending" after this long was lost (e.g. restart). */
const DESCRIPTION_STALE_MS = 10 * 60 * 1000;

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

/**
 * Decode a text upload. UTF-8 (with or without BOM) first, then UTF-16 when a
 * BOM says so, then Shift_JIS/CP932 — the default encoding of CSVs saved by
 * Japanese Excel. Fatal decoding throughout so binary data is never accepted
 * as mojibake.
 */
export function decodeProjectText(buffer: Buffer): string | null {
  const tryDecode = (label: string, bytes: Uint8Array): string | null => {
    try {
      return new TextDecoder(label, { fatal: true, ignoreBOM: false }).decode(
        bytes,
      );
    } catch {
      return null;
    }
  };
  if (buffer.length >= 2) {
    const b0 = buffer[0];
    const b1 = buffer[1];
    if (b0 === 0xff && b1 === 0xfe) return tryDecode("utf-16le", buffer);
    if (b0 === 0xfe && b1 === 0xff) return tryDecode("utf-16be", buffer);
  }
  const utf8 = tryDecode("utf-8", buffer);
  if (utf8 !== null) return utf8;
  return tryDecode("shift_jis", buffer);
}

function asTextFile(filename: string, buffer: Buffer, limits: ProjectLimits) {
  // Fatal decoding rejects mojibake early; NULs mark binary content
  // (CSV/text imports must not smuggle past detection via a fake extension).
  const decoded = decodeProjectText(buffer);
  if (decoded === null) {
    throw new ProjectFileError(
      "unsupported_type",
      "テキストとして解釈できないファイルです。UTF-8 / Shift_JIS / UTF-16 のテキスト、または PDF / Office 文書をアップロードしてください。",
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
  kind: projectFiles.kind,
  imageWidth: projectFiles.imageWidth,
  imageHeight: projectFiles.imageHeight,
  hasThumbnail: sql<boolean>`(${projectFiles.thumbnail} is not null)`,
  sendImage: projectFiles.sendImage,
  descriptionStatus: projectFiles.descriptionStatus,
  descriptionModel: projectFiles.descriptionModel,
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
  kind: string;
  imageWidth: number | null;
  imageHeight: number | null;
  hasThumbnail: boolean;
  sendImage: boolean;
  descriptionStatus: string;
  descriptionModel: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const DESCRIPTION_STATUSES: readonly ProjectImageDescriptionStatus[] = [
  "none",
  "pending",
  "ready",
  "unavailable",
  "failed",
];

function effectiveDescriptionStatus(
  row: Pick<MetadataRow, "descriptionStatus" | "updatedAt">,
  now = Date.now(),
): ProjectImageDescriptionStatus {
  const status = DESCRIPTION_STATUSES.includes(
    row.descriptionStatus as ProjectImageDescriptionStatus,
  )
    ? (row.descriptionStatus as ProjectImageDescriptionStatus)
    : "none";
  if (
    status === "pending" &&
    now - row.updatedAt.getTime() > DESCRIPTION_STALE_MS
  ) {
    return "failed";
  }
  return status;
}

function toMetadata(row: MetadataRow): ProjectFileMetadata {
  return {
    id: row.id,
    projectId: row.projectId,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    textChars: row.textChars,
    includeInContext: row.includeInContext,
    kind: row.kind === "image" ? "image" : "document",
    imageWidth: row.imageWidth ?? null,
    imageHeight: row.imageHeight ?? null,
    hasThumbnail: Boolean(row.hasThumbnail),
    sendImage: row.sendImage,
    descriptionStatus: effectiveDescriptionStatus(row),
    descriptionModel: row.descriptionModel ?? null,
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
export async function assertOwnedProject(
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

/**
 * Detect the file family and extract its text (shared by local uploads and
 * Google Drive references). Throws ProjectFileError with a Japanese message
 * for unsupported or unreadable content.
 */
export async function extractProjectFileContent(
  filename: string,
  buffer: Buffer,
  limits: ProjectLimits,
): Promise<{
  extractedText: string;
  textChars: number;
  mimeType: string;
  filename: string;
}> {
  // A UTF-16 BOM (FF FE) also matches the MPEG frame-sync heuristic, so a
  // BOM-prefixed buffer that decodes cleanly as UTF-16 is treated as text.
  const hasUtf16Bom =
    buffer.length >= 2 &&
    ((buffer[0] === 0xff && buffer[1] === 0xfe) ||
      (buffer[0] === 0xfe && buffer[1] === 0xff));
  const family =
    hasUtf16Bom && decodeProjectText(buffer) !== null
      ? null
      : detectBinaryFamily(buffer);
  // Before the audio check: HEIC shares the ISO-BMFF "ftyp" box with M4A.
  if (detectProjectImageFormat(buffer)) {
    throw new ProjectFileError(
      "unsupported_type",
      "画像ファイルはここでは読み込めません。プロジェクトの参考ファイルへ直接アップロードしてください。",
    );
  }
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
  try {
    if (
      family === "pdf" ||
      family === "docx" ||
      family === "xlsx" ||
      family === "pptx"
    ) {
      return await asBinaryFile(filename, buffer, family, limits);
    } else if (family === null) {
      return asTextFile(filename, buffer, limits);
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
}

interface PreparedProjectFile {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  extractedText: string;
  textChars: number;
  kind: ProjectFileKind;
  thumbnail: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  descriptionStatus: ProjectImageDescriptionStatus;
  describeModelId: string | null;
}

async function prepareProjectFile(
  filename: string,
  buffer: Buffer,
  limits: ProjectLimits,
  role: ProjectImageUserRole,
): Promise<PreparedProjectFile> {
  const imageFormat = detectProjectImageFormat(buffer);
  if (imageFormat) {
    let processed;
    try {
      processed = await processProjectImage(buffer, imageFormat);
    } catch (err) {
      if (err instanceof ProjectImageDecodeError) {
        throw new ProjectFileError("extraction_failed", err.message);
      }
      throw err;
    }
    if (processed.stored.length > limits.fileMaxBytes) {
      throw new ProjectFileError(
        "too_large",
        `変換後の画像が大きすぎます。1ファイル ${Math.round(limits.fileMaxBytes / 1024 / 1024)}MB 以下にしてください。`,
      );
    }
    const describeModelId = imageDescriberHooks.resolveModel(role);
    return {
      filename: storedImageFilename(filename, processed.extension),
      mimeType: processed.mimeType,
      buffer: processed.stored,
      extractedText: "",
      textChars: 0,
      kind: "image",
      thumbnail: processed.thumbnail.toString("base64"),
      imageWidth: processed.width,
      imageHeight: processed.height,
      descriptionStatus: describeModelId ? "pending" : "unavailable",
      describeModelId,
    };
  }
  const extracted = await extractProjectFileContent(filename, buffer, limits);
  return {
    filename: extracted.filename,
    mimeType: extracted.mimeType,
    buffer,
    extractedText: extracted.extractedText,
    textChars: extracted.textChars,
    kind: "document",
    thumbnail: null,
    imageWidth: null,
    imageHeight: null,
    descriptionStatus: "none",
    describeModelId: null,
  };
}

export async function addProjectFile(
  userId: string,
  projectId: number,
  input: { filename: string; buffer: Buffer; role?: ProjectImageUserRole },
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

  const prepared = await prepareProjectFile(
    filename,
    buffer,
    limits,
    input.role ?? "user",
  );

  // Lock the project row so the count/quota check and insert are atomic.
  const meta = await db.transaction(async (tx) => {
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
    if (currentTotal + prepared.buffer.length > limits.userTotalMaxBytes) {
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
        filename: prepared.filename,
        mimeType: prepared.mimeType,
        sizeBytes: prepared.buffer.length,
        data: prepared.buffer.toString("base64"),
        extractedText: prepared.extractedText,
        textChars: prepared.textChars,
        includeInContext: true,
        kind: prepared.kind,
        thumbnail: prepared.thumbnail,
        imageWidth: prepared.imageWidth,
        imageHeight: prepared.imageHeight,
        sendImage: false,
        descriptionStatus: prepared.descriptionStatus,
        updatedAt: new Date(),
      })
      .returning(metadataColumns);
    if (!row) {
      throw new Error("project file insert returned no row");
    }
    return toMetadata(row);
  });
  if (prepared.describeModelId) {
    scheduleImageDescription(userId, meta.id, prepared.describeModelId);
  }
  return meta;
}

// --- Image descriptions (generated once, in the background) --------------

/** Overridable in tests so no real model is ever called. */
export const imageDescriberHooks = {
  resolveModel: resolveImageDescribeModel,
  describe: describeProjectImage,
};

const inFlightDescriptions = new Map<number, Promise<void>>();
const MAX_CONCURRENT_DESCRIPTIONS = 2;
let activeDescriptions = 0;
const descriptionWaiters: (() => void)[] = [];

async function acquireDescriptionSlot(): Promise<void> {
  if (activeDescriptions < MAX_CONCURRENT_DESCRIPTIONS) {
    activeDescriptions += 1;
    return;
  }
  await new Promise<void>((resolve) => descriptionWaiters.push(resolve));
  activeDescriptions += 1;
}

function releaseDescriptionSlot(): void {
  activeDescriptions -= 1;
  descriptionWaiters.shift()?.();
}

async function runImageDescription(
  userId: string,
  fileId: number,
  modelId: string,
): Promise<void> {
  const fileScope = and(
    eq(projectFiles.id, fileId),
    eq(projectFiles.userId, userId),
    eq(projectFiles.kind, "image"),
  );
  await acquireDescriptionSlot();
  try {
    const [row] = await db
      .select({ filename: projectFiles.filename, data: projectFiles.data })
      .from(projectFiles)
      .where(fileScope)
      .limit(1);
    if (!row) return;
    const imageDataUrl = await toVisionDataUrl(Buffer.from(row.data, "base64"));
    const description = await imageDescriberHooks.describe({
      modelId,
      imageDataUrl,
      filename: row.filename,
    });
    const text = clipHeadUtf8Safe(
      formatImageDescriptionText(modelId, description),
      getProjectLimits().fileTextMaxChars,
      "",
    );
    await db
      .update(projectFiles)
      .set({
        extractedText: text,
        textChars: text.length,
        descriptionStatus: "ready",
        descriptionModel: getModelLabel(modelId),
        updatedAt: new Date(),
      })
      .where(and(fileScope, eq(projectFiles.descriptionStatus, "pending")));
  } catch (err) {
    logger.warn(
      {
        fileId,
        describeModelId: modelId,
        errorName: err instanceof Error ? err.name : typeof err,
      },
      "Project image description failed",
    );
    await db
      .update(projectFiles)
      .set({ descriptionStatus: "failed", updatedAt: new Date() })
      .where(and(fileScope, eq(projectFiles.descriptionStatus, "pending")))
      .catch(() => undefined);
  } finally {
    releaseDescriptionSlot();
  }
}

function scheduleImageDescription(
  userId: string,
  fileId: number,
  modelId: string,
): void {
  if (inFlightDescriptions.has(fileId)) return;
  const job = runImageDescription(userId, fileId, modelId).finally(() => {
    inFlightDescriptions.delete(fileId);
  });
  inFlightDescriptions.set(fileId, job);
}

/** Test helper: resolves once every scheduled description has settled. */
export async function waitForImageDescriptions(): Promise<void> {
  while (inFlightDescriptions.size > 0) {
    await Promise.allSettled([...inFlightDescriptions.values()]);
  }
}

/**
 * (Re)generate an image's description. Returns null when the file does not
 * exist for this user; throws unsupported_type for non-image files.
 */
export async function requestProjectImageDescription(
  userId: string,
  projectId: number,
  fileId: number,
  role: ProjectImageUserRole,
): Promise<ProjectFileMetadata | null> {
  await assertOwnedProject(userId, projectId);
  const scope = and(
    eq(projectFiles.id, fileId),
    eq(projectFiles.projectId, projectId),
    eq(projectFiles.userId, userId),
  );
  const [current] = await db
    .select(metadataColumns)
    .from(projectFiles)
    .where(scope)
    .limit(1);
  if (!current) return null;
  if (current.kind !== "image") {
    throw new ProjectFileError(
      "unsupported_type",
      "説明を作成できるのは画像ファイルだけです。",
    );
  }
  if (inFlightDescriptions.has(fileId)) return toMetadata(current);
  const modelId = imageDescriberHooks.resolveModel(role);
  const [row] = await db
    .update(projectFiles)
    .set({
      descriptionStatus: modelId ? "pending" : "unavailable",
      updatedAt: new Date(),
    })
    .where(scope)
    .returning(metadataColumns);
  if (!row) return null;
  if (modelId) scheduleImageDescription(userId, fileId, modelId);
  return toMetadata(row);
}

export async function setProjectFileSendImage(
  userId: string,
  projectId: number,
  fileId: number,
  sendImage: boolean,
): Promise<ProjectFileMetadata | null> {
  await assertOwnedProject(userId, projectId);
  const [row] = await db
    .update(projectFiles)
    .set({ sendImage, updatedAt: new Date() })
    .where(
      and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.userId, userId),
        eq(projectFiles.kind, "image"),
      ),
    )
    .returning(metadataColumns);
  return row ? toMetadata(row) : null;
}

export async function getProjectFileThumbnail(
  userId: string,
  projectId: number,
  fileId: number,
): Promise<Buffer | null> {
  if (!(await assertProjectOwnership(userId, projectId))) return null;
  const [row] = await db
    .select({ thumbnail: projectFiles.thumbnail })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.id, fileId),
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.userId, userId),
      ),
    )
    .limit(1);
  return row?.thumbnail ? Buffer.from(row.thumbnail, "base64") : null;
}

/** Most images attached to one chat turn via 「画像そのものを送る」. */
export const PROJECT_VISION_MAX_IMAGES = 4;

/**
 * Data URLs (≤1568px JPEG) of the project's images flagged 「画像そのものを
 * 送る」 and included in context, oldest first, for vision-capable models.
 */
export async function loadProjectVisionImages(
  userId: string,
  projectId: number,
): Promise<{ filename: string; dataUrl: string }[]> {
  if (!(await assertProjectOwnership(userId, projectId))) return [];
  const rows = await db
    .select({ filename: projectFiles.filename, data: projectFiles.data })
    .from(projectFiles)
    .where(
      and(
        eq(projectFiles.projectId, projectId),
        eq(projectFiles.userId, userId),
        eq(projectFiles.kind, "image"),
        eq(projectFiles.sendImage, true),
        eq(projectFiles.includeInContext, true),
      ),
    )
    .orderBy(asc(projectFiles.createdAt), asc(projectFiles.id))
    .limit(PROJECT_VISION_MAX_IMAGES);
  const images: { filename: string; dataUrl: string }[] = [];
  for (const row of rows) {
    try {
      images.push({
        filename: row.filename,
        dataUrl: await toVisionDataUrl(Buffer.from(row.data, "base64")),
      });
    } catch {
      // A stored image that no longer decodes is skipped, not fatal.
    }
  }
  return images;
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
