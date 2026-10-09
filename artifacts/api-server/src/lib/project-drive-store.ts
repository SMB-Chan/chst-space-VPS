/**
 * Google Drive references attached to a project. Only the Drive file id,
 * metadata and the extracted text (cache) are stored; the text is refreshed
 * on demand (explicit refresh, or stale-while-revalidate when a chat turn
 * reads the project context).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db, projectDriveFiles } from "@workspace/db";
import { logger } from "./logger";
import {
  DriveError,
  fetchDriveFileText,
  getDriveFileInfo,
  isDriveIntegrationConfigured,
  parseDriveFileId,
} from "./google-drive";
import { assertOwnedProject, ProjectFileError } from "./project-files-store";
import { getProjectLimits } from "./project-limits";

/** Cached text older than this is re-validated in the background. */
export const DRIVE_REFRESH_TTL_MS = 15 * 60 * 1000;

export interface ProjectDriveFileMetadata {
  id: number;
  projectId: number;
  driveFileId: string;
  name: string;
  mimeType: string;
  sizeBytes: number | null;
  driveModifiedTime: string | null;
  webViewLink: string | null;
  textChars: number;
  includeInContext: boolean;
  fetchError: string | null;
  fetchedAt: string | null;
  createdAt: string;
}

const metadataColumns = {
  id: projectDriveFiles.id,
  projectId: projectDriveFiles.projectId,
  driveFileId: projectDriveFiles.driveFileId,
  name: projectDriveFiles.name,
  mimeType: projectDriveFiles.mimeType,
  sizeBytes: projectDriveFiles.sizeBytes,
  driveModifiedTime: projectDriveFiles.driveModifiedTime,
  webViewLink: projectDriveFiles.webViewLink,
  textChars: projectDriveFiles.textChars,
  includeInContext: projectDriveFiles.includeInContext,
  fetchError: projectDriveFiles.fetchError,
  fetchedAt: projectDriveFiles.fetchedAt,
  createdAt: projectDriveFiles.createdAt,
};

type MetadataRow = {
  [
    K in keyof typeof metadataColumns
  ]: (typeof projectDriveFiles.$inferSelect)[K extends keyof typeof projectDriveFiles.$inferSelect
    ? K
    : never];
};

function toMetadata(row: MetadataRow): ProjectDriveFileMetadata {
  return {
    ...row,
    sizeBytes: row.sizeBytes ?? null,
    fetchedAt: row.fetchedAt ? row.fetchedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

function notFound(): ProjectFileError {
  return new ProjectFileError(
    "not_found",
    "Googleドライブの参照が見つかりません。",
  );
}

export async function listProjectDriveFiles(
  userId: string,
  projectId: number,
): Promise<ProjectDriveFileMetadata[]> {
  await assertOwnedProject(userId, projectId);
  const rows = await db
    .select(metadataColumns)
    .from(projectDriveFiles)
    .where(
      and(
        eq(projectDriveFiles.projectId, projectId),
        eq(projectDriveFiles.userId, userId),
      ),
    )
    .orderBy(asc(projectDriveFiles.createdAt), asc(projectDriveFiles.id));
  return rows.map(toMetadata);
}

/**
 * Add a Drive file (id or share URL) to the project: fetch + extract now so
 * the user sees errors immediately, then store the text cache.
 */
export async function addProjectDriveFile(
  userId: string,
  projectId: number,
  fileIdOrUrl: string,
): Promise<ProjectDriveFileMetadata> {
  await assertOwnedProject(userId, projectId);
  const fileId = parseDriveFileId(fileIdOrUrl);
  if (!fileId) {
    throw new DriveError(
      "not_found",
      "GoogleドライブのファイルIDまたは共有URLを指定してください。",
    );
  }
  const limits = getProjectLimits();
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(projectDriveFiles)
    .where(
      and(
        eq(projectDriveFiles.projectId, projectId),
        eq(projectDriveFiles.userId, userId),
      ),
    );
  if (count >= limits.maxFilesPerProject) {
    throw new ProjectFileError(
      "too_many_files",
      `Googleドライブの参照は1プロジェクト ${limits.maxFilesPerProject} 件までです。`,
    );
  }
  const [existing] = await db
    .select({ id: projectDriveFiles.id })
    .from(projectDriveFiles)
    .where(
      and(
        eq(projectDriveFiles.projectId, projectId),
        eq(projectDriveFiles.driveFileId, fileId),
      ),
    )
    .limit(1);
  if (existing) {
    throw new DriveError(
      "unsupported",
      "このファイルは既にプロジェクトに追加されています。",
    );
  }
  const extraction = await fetchDriveFileText(userId, fileId, { limits });
  const now = new Date();
  const [row] = await db
    .insert(projectDriveFiles)
    .values({
      projectId,
      userId,
      driveFileId: extraction.info.id,
      name: extraction.info.name,
      mimeType: extraction.info.mimeType,
      sizeBytes: extraction.info.sizeBytes,
      driveModifiedTime: extraction.info.modifiedTime,
      webViewLink: extraction.info.webViewLink,
      extractedText: extraction.extractedText,
      textChars: extraction.textChars,
      fetchedAt: now,
      fetchError: null,
    })
    .onConflictDoNothing()
    .returning(metadataColumns);
  if (!row) {
    throw new DriveError(
      "unsupported",
      "このファイルは既にプロジェクトに追加されています。",
    );
  }
  return toMetadata(row);
}

async function getOwnedRef(userId: string, projectId: number, refId: number) {
  const [row] = await db
    .select()
    .from(projectDriveFiles)
    .where(
      and(
        eq(projectDriveFiles.id, refId),
        eq(projectDriveFiles.projectId, projectId),
        eq(projectDriveFiles.userId, userId),
      ),
    )
    .limit(1);
  if (!row) throw notFound();
  return row;
}

/**
 * Re-fetch a reference. `force` re-downloads even when Drive's modifiedTime
 * is unchanged. Errors are stored on the row (old text is kept) and rethrown.
 */
export async function refreshProjectDriveFile(
  userId: string,
  projectId: number,
  refId: number,
  options: { force?: boolean } = {},
): Promise<ProjectDriveFileMetadata> {
  const row = await getOwnedRef(userId, projectId, refId);
  try {
    const info = await getDriveFileInfo(userId, row.driveFileId);
    const unchanged =
      !options.force &&
      info.modifiedTime != null &&
      info.modifiedTime === row.driveModifiedTime &&
      !row.fetchError;
    const values = unchanged
      ? { name: info.name, webViewLink: info.webViewLink }
      : await fetchDriveFileText(userId, row.driveFileId, { info }).then(
          (extraction) => ({
            name: info.name,
            mimeType: info.mimeType,
            sizeBytes: info.sizeBytes,
            driveModifiedTime: info.modifiedTime,
            webViewLink: info.webViewLink,
            extractedText: extraction.extractedText,
            textChars: extraction.textChars,
          }),
        );
    const [updated] = await db
      .update(projectDriveFiles)
      .set({
        ...values,
        fetchError: null,
        fetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectDriveFiles.id, row.id))
      .returning(metadataColumns);
    if (!updated) throw notFound();
    return toMetadata(updated);
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Googleドライブの再取得に失敗しました。";
    await db
      .update(projectDriveFiles)
      .set({
        fetchError: message,
        fetchedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(projectDriveFiles.id, row.id));
    throw err;
  }
}

export async function setProjectDriveFileIncluded(
  userId: string,
  projectId: number,
  refId: number,
  includeInContext: boolean,
): Promise<ProjectDriveFileMetadata> {
  await getOwnedRef(userId, projectId, refId);
  const [updated] = await db
    .update(projectDriveFiles)
    .set({ includeInContext, updatedAt: new Date() })
    .where(eq(projectDriveFiles.id, refId))
    .returning(metadataColumns);
  if (!updated) throw notFound();
  return toMetadata(updated);
}

export async function deleteProjectDriveFile(
  userId: string,
  projectId: number,
  refId: number,
): Promise<void> {
  await getOwnedRef(userId, projectId, refId);
  await db.delete(projectDriveFiles).where(eq(projectDriveFiles.id, refId));
}

const refreshing = new Set<number>();

/**
 * Context entries for included Drive references (cached text). Stale caches
 * are re-validated in the background so a chat turn never waits on Drive.
 */
export async function loadProjectDriveContextEntries(
  userId: string,
  projectId: number,
): Promise<{ id: number; filename: string; text: string }[]> {
  const rows = await db
    .select({
      id: projectDriveFiles.id,
      name: projectDriveFiles.name,
      text: projectDriveFiles.extractedText,
      includeInContext: projectDriveFiles.includeInContext,
      fetchedAt: projectDriveFiles.fetchedAt,
    })
    .from(projectDriveFiles)
    .where(
      and(
        eq(projectDriveFiles.projectId, projectId),
        eq(projectDriveFiles.userId, userId),
      ),
    )
    .orderBy(asc(projectDriveFiles.createdAt), asc(projectDriveFiles.id));
  const included = rows.filter((row) => row.includeInContext);
  if (isDriveIntegrationConfigured()) {
    const now = Date.now();
    for (const row of included) {
      const age = row.fetchedAt ? now - row.fetchedAt.getTime() : Infinity;
      if (age < DRIVE_REFRESH_TTL_MS || refreshing.has(row.id)) continue;
      refreshing.add(row.id);
      void refreshProjectDriveFile(userId, projectId, row.id)
        .catch((err) => {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            "project drive reference background refresh failed",
          );
        })
        .finally(() => refreshing.delete(row.id));
    }
  }
  return included
    .filter((row) => row.text)
    .map((row) => ({
      id: row.id,
      filename: `Googleドライブ: ${row.name}`,
      text: row.text,
    }));
}
