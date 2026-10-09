/**
 * Project file upload helpers.
 *
 * The functions here are split into:
 *   - {@link planProjectUploads}: pure, deterministic slot/byte accounting.
 *     Lives in its own function so the UI can reason about per-file errors
 *     without aborting the whole batch.
 *   - {@link uploadFilesToProject}: the side-effectful runner that talks to
 *     the server, base64-encodes each file, and aggregates outcomes.
 *   - {@link summarizeUploadOutcomes}: a tiny Japanese helper that turns the
 *     outcome array into the toast / inline text the user sees.
 *
 */

import { formatBytes } from "@/lib/compress-image";

export { formatBytes };
import {
  fileToBase64,
  projectsApi,
  type ProjectsLimits,
} from "@/lib/projects-api";

/** Minimal file shape — `File` extends this, but tests use plain objects. */
export interface UploadPlanItem {
  file: { name: string; size: number };
}

export interface PlanUploadsOptions {
  fileMaxBytes: number;
  maxFiles: number;
  existingCount: number;
  userMaxTotalBytes: number;
  usedBytes: number;
}

export interface PlannedUpload<T extends { name: string; size: number }> {
  accepted: T[];
  rejected: { name: string; error: string }[];
  /** Index (into the input array) of each accepted / rejected entry. */
  acceptedIndexes: number[];
  rejectedIndexes: number[];
}

export interface UploadOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

export interface UploadProgress {
  done: number;
  total: number;
  current: string | null;
}

/**
 * Decide which files the batch can accept, given current usage and per-file
 * caps. Per-file decisions only — one oversize file does not reject the rest.
 *
 * Order of checks mirrors how the old code surfaced errors, with two
 * refinements:
 *   - Empty files (size 0) are rejected up front so a stray "Cancelled"
 *     item does not waste a slot.
 *   - The byte cap is checked against the running total, so later files in a
 *     batch see the bytes accepted earlier in the same call. The old code
 *     rejected the whole batch as soon as the total exceeded the cap.
 */
export function planProjectUploads<T extends { name: string; size: number }>(
  files: T[],
  opts: PlanUploadsOptions,
): PlannedUpload<T> {
  const accepted: T[] = [];
  const rejected: { name: string; error: string }[] = [];
  const acceptedIndexes: number[] = [];
  const rejectedIndexes: number[] = [];
  const reject = (index: number, name: string, error: string) => {
    rejected.push({ name, error });
    rejectedIndexes.push(index);
  };

  const remainingSlots = Math.max(0, opts.maxFiles - opts.existingCount);
  const startingTotal = Math.max(0, opts.usedBytes);

  let runningTotal = startingTotal;
  let slotsLeft = remainingSlots;

  files.forEach((file, index) => {
    if (file.size <= 0) {
      reject(index, file.name, "空のファイルです");
      return;
    }
    if (file.size > opts.fileMaxBytes) {
      reject(
        index,
        file.name,
        `1ファイル最大 ${formatBytes(opts.fileMaxBytes)} を超えています`,
      );
      return;
    }
    if (slotsLeft <= 0) {
      reject(
        index,
        file.name,
        `ファイル数の上限 (${opts.maxFiles}件) に達しました`,
      );
      return;
    }
    if (runningTotal + file.size > opts.userMaxTotalBytes) {
      reject(
        index,
        file.name,
        `保存容量の上限 (${formatBytes(opts.userMaxTotalBytes)}) を超えます`,
      );
      return;
    }

    accepted.push(file);
    acceptedIndexes.push(index);
    runningTotal += file.size;
    slotsLeft -= 1;
  });

  return { accepted, rejected, acceptedIndexes, rejectedIndexes };
}

/**
 * Run the batch through the API:
 *   1. Plan using the current limits (`usedBytes` defaults to the server's
 *      reported total so the planner can match the server's view of the
 *      world).
 *   2. Upload each accepted file sequentially (base64 → POST). Sequential
 *      keeps error messages tied to the file that failed and avoids
 *      simultaneous 50 MB JSON blobs on slow networks.
 *   3. Re-combine rejected outcomes and successful uploads in their original
 *      order so the UI can present the same list the user selected.
 */
export async function uploadFilesToProject(
  projectId: number,
  files: File[],
  limits: ProjectsLimits,
  existingCount: number,
  onProgress?: (p: UploadProgress) => void,
): Promise<UploadOutcome[]> {
  const plan = planProjectUploads(files, {
    fileMaxBytes: limits.fileMaxBytes,
    maxFiles: limits.maxFiles,
    existingCount,
    userMaxTotalBytes: limits.userMaxTotalBytes,
    usedBytes: limits.usage?.totalBytes ?? 0,
  });

  // Outcomes are tracked by input index so two files with the same name
  // (picked from different folders) keep separate results.
  const outcomes: UploadOutcome[] = files.map((file) => ({
    name: file.name,
    ok: false,
    error: "アップロードに失敗しました。",
  }));
  plan.rejected.forEach((rej, i) => {
    outcomes[plan.rejectedIndexes[i]!] = {
      name: rej.name,
      ok: false,
      error: rej.error,
    };
  });

  const total = plan.accepted.length;
  let done = 0;
  onProgress?.({ done, total, current: null });

  for (let i = 0; i < plan.accepted.length; i += 1) {
    const file = plan.accepted[i]!;
    const index = plan.acceptedIndexes[i]!;
    onProgress?.({ done, total, current: file.name });
    try {
      const dataBase64 = await fileToBase64(file);
      await projectsApi.uploadFile(projectId, {
        filename: file.name,
        dataBase64,
      });
      outcomes[index] = { name: file.name, ok: true };
    } catch (err) {
      outcomes[index] = {
        name: file.name,
        ok: false,
        error:
          err instanceof Error ? err.message : "アップロードに失敗しました。",
      };
    }
    done += 1;
    onProgress?.({ done, total, current: file.name });
  }

  onProgress?.({ done, total, current: null });
  return outcomes;
}

/**
 * Render an upload batch as a single Japanese summary line:
 *   - everything succeeded: "3件のファイルを追加しました。"
 *   - mixed:                "2件追加、1件失敗しました。"
 *   - nothing succeeded:   "追加できませんでした。"
 */
export function summarizeUploadOutcomes(outcomes: UploadOutcome[]): string {
  const succeeded = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.length - succeeded;

  if (outcomes.length === 0 || succeeded === 0) {
    return "追加できませんでした。";
  }
  if (failed === 0) {
    return `${succeeded}件のファイルを追加しました。`;
  }
  return `${succeeded}件追加、${failed}件失敗しました。`;
}

/**
 * Turn the failures in an outcome array into a bullet list of "name: error"
 * lines suitable for a toast description. Caps at `max` (default 5) so a
 * huge failure burst still fits in the toast viewport.
 */
export function formatUploadFailures(
  outcomes: UploadOutcome[],
  max = 5,
): string[] {
  return outcomes
    .filter((o) => !o.ok)
    .slice(0, max)
    .map((o) => `${o.name}: ${o.error ?? "失敗"}`);
}
