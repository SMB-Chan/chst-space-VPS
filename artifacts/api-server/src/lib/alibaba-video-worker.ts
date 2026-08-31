import { randomUUID } from "node:crypto";
import {
  downloadAlibabaVideoResult,
  getAlibabaVideoTask,
  type AlibabaGeneratedVideo,
  type AlibabaVideoTask,
  type AlibabaVideoTaskStatus,
} from "./alibaba-video";
import {
  assertAlibabaVideoStatusTransition,
  nextAlibabaVideoPollAt,
} from "./alibaba-video-job-state";
import { isAlibabaSpecialistConfigured } from "./alibaba-specialist-config";
import { logger, safeFailureFields } from "./logger";

const WORKER_TICK_MS = 5_000;
const WORKER_LEASE_MS = 5 * 60_000;
const MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_USER_GENERATED_FILE_BYTES = 50 * 1024 * 1024;

export interface ClaimedAlibabaVideoJob {
  id: number;
  userId: string;
  conversationId: number;
  requestMessageId: number;
  providerTaskId: string;
  providerRequestId?: string;
  modelId: string;
  mode: string;
  status: AlibabaVideoTaskStatus;
  attemptCount: number;
  providerExpiresAt: Date;
  leaseOwner: string;
}

export interface AlibabaVideoWorkerDependencies {
  now: () => Date;
  fetchTask: (taskId: string) => Promise<AlibabaVideoTask>;
  downloadResult: (
    task: AlibabaVideoTask,
    modelId: string,
  ) => Promise<AlibabaGeneratedVideo>;
  recordProgress: (
    job: ClaimedAlibabaVideoJob,
    task: AlibabaVideoTask,
    nextPollAt: Date,
  ) => Promise<void>;
  recordTerminalFailure: (
    job: ClaimedAlibabaVideoJob,
    status: Extract<AlibabaVideoTaskStatus, "FAILED" | "CANCELED" | "UNKNOWN">,
    code?: string,
    message?: string,
  ) => Promise<void>;
  recordRetry: (
    job: ClaimedAlibabaVideoJob,
    nextPollAt: Date,
    message: string,
  ) => Promise<void>;
  persistSuccess: (
    job: ClaimedAlibabaVideoJob,
    task: AlibabaVideoTask,
    video: AlibabaGeneratedVideo,
  ) => Promise<void>;
}

interface RawVideoJobRow {
  id: number;
  user_id: string;
  conversation_id: number;
  request_message_id: number;
  provider_task_id: string;
  provider_request_id: string | null;
  model_id: string;
  mode: string;
  status: string;
  attempt_count: number;
  provider_expires_at: Date;
  lease_owner: string;
}

async function getPool() {
  const database = await import("@workspace/db");
  return database.pool;
}

function generatedFileQuotaBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAX_USER_GENERATED_FILE_BYTES;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_USER_GENERATED_FILE_BYTES;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_MAX_USER_GENERATED_FILE_BYTES;
  return value;
}

function retryDelayMs(attemptCount: number): number {
  const multiplier = 2 ** Math.min(Math.max(attemptCount, 0), 2);
  return Math.min(15_000 * multiplier, MAX_RETRY_DELAY_MS);
}

function asClaimedJob(row: RawVideoJobRow): ClaimedAlibabaVideoJob {
  if (row.status !== "PENDING" && row.status !== "RUNNING") {
    throw new Error(`Worker claimed unexpected Alibaba video status: ${row.status}`);
  }
  return {
    id: row.id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    requestMessageId: row.request_message_id,
    providerTaskId: row.provider_task_id,
    providerRequestId: row.provider_request_id ?? undefined,
    modelId: row.model_id,
    mode: row.mode,
    status: row.status,
    attemptCount: row.attempt_count,
    providerExpiresAt: row.provider_expires_at,
    leaseOwner: row.lease_owner,
  };
}

async function claimDueJob(now: Date): Promise<ClaimedAlibabaVideoJob | null> {
  const pool = await getPool();
  const leaseOwner = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + WORKER_LEASE_MS);
  const result = await pool.query(
    `WITH candidate AS (
       SELECT id
       FROM alibaba_video_jobs
       WHERE status IN ('PENDING', 'RUNNING')
         AND (next_poll_at IS NULL OR next_poll_at <= $1 OR provider_expires_at <= $1)
         AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
       ORDER BY COALESCE(next_poll_at, created_at), id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE alibaba_video_jobs AS job
     SET lease_owner = $2,
         lease_expires_at = $3,
         updated_at = $1
     FROM candidate
     WHERE job.id = candidate.id
     RETURNING job.id,
               job.user_id,
               job.conversation_id,
               job.request_message_id,
               job.provider_task_id,
               job.provider_request_id,
               job.model_id,
               job.mode,
               job.status,
               job.attempt_count,
               job.provider_expires_at,
               job.lease_owner`,
    [now, leaseOwner, leaseExpiresAt],
  );
  const row = result.rows[0] as RawVideoJobRow | undefined;
  return row ? asClaimedJob(row) : null;
}

async function updateProgress(
  job: ClaimedAlibabaVideoJob,
  task: AlibabaVideoTask,
  nextPollAt: Date,
): Promise<void> {
  assertAlibabaVideoStatusTransition(job.status, task.status);
  const pool = await getPool();
  await pool.query(
    `UPDATE alibaba_video_jobs
     SET status = $1,
         provider_request_id = COALESCE($2, provider_request_id),
         failure_code = NULL,
         failure_message = NULL,
         attempt_count = attempt_count + 1,
         last_polled_at = $3,
         next_poll_at = $4,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = $3
     WHERE id = $5 AND lease_owner = $6`,
    [task.status, task.requestId ?? null, new Date(), nextPollAt, job.id, job.leaseOwner],
  );
}

async function updateTerminalFailure(
  job: ClaimedAlibabaVideoJob,
  status: Extract<AlibabaVideoTaskStatus, "FAILED" | "CANCELED" | "UNKNOWN">,
  code?: string,
  message?: string,
): Promise<void> {
  assertAlibabaVideoStatusTransition(job.status, status);
  const pool = await getPool();
  const now = new Date();
  await pool.query(
    `UPDATE alibaba_video_jobs
     SET status = $1,
         failure_code = $2,
         failure_message = $3,
         attempt_count = attempt_count + 1,
         last_polled_at = $4,
         next_poll_at = NULL,
         completed_at = $4,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = $4
     WHERE id = $5 AND lease_owner = $6`,
    [status, code ?? null, message?.slice(0, 2_000) ?? null, now, job.id, job.leaseOwner],
  );
}

async function updateRetry(
  job: ClaimedAlibabaVideoJob,
  nextPollAt: Date,
  message: string,
): Promise<void> {
  const pool = await getPool();
  const now = new Date();
  await pool.query(
    `UPDATE alibaba_video_jobs
     SET failure_code = 'POLL_RETRY',
         failure_message = $1,
         attempt_count = attempt_count + 1,
         last_polled_at = $2,
         next_poll_at = $3,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = $2
     WHERE id = $4 AND lease_owner = $5`,
    [message.slice(0, 2_000), now, nextPollAt, job.id, job.leaseOwner],
  );
}

async function persistSuccessfulVideo(
  job: ClaimedAlibabaVideoJob,
  task: AlibabaVideoTask,
  video: AlibabaGeneratedVideo,
): Promise<void> {
  assertAlibabaVideoStatusTransition(job.status, "SUCCEEDED");
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT id, status, lease_owner
       FROM alibaba_video_jobs
       WHERE id = $1
       FOR UPDATE`,
      [job.id],
    );
    const current = locked.rows[0] as { id: number; status: string; lease_owner: string | null } | undefined;
    if (!current || current.lease_owner !== job.leaseOwner) {
      await client.query("ROLLBACK");
      return;
    }
    if (current.status !== "PENDING" && current.status !== "RUNNING") {
      await client.query("ROLLBACK");
      return;
    }

    const quotaBytes = generatedFileQuotaBytes();
    if (quotaBytes > 0) {
      const quotaResult = await client.query(
        `SELECT
           COALESCE((
             SELECT SUM(a.size)
             FROM assets AS a
             INNER JOIN conversations AS c ON c.id = a.conversation_id
             WHERE c.user_id = $1
           ), 0) +
           COALESCE((
             SELECT SUM(ar.size)
             FROM artifacts AS ar
             WHERE ar.user_id = $1
           ), 0) AS used_bytes`,
        [job.userId],
      );
      const usedBytes = Number((quotaResult.rows[0] as { used_bytes?: string | number } | undefined)?.used_bytes ?? 0);
      if (!Number.isFinite(usedBytes) || usedBytes + video.size > quotaBytes) {
        const messageResult = await client.query(
          `INSERT INTO messages (conversation_id, role, content, model_id)
           VALUES ($1, 'assistant', $2, $3)
           RETURNING id`,
          [
            job.conversationId,
            "動画生成は完了しましたが、保存容量の上限を超えたためMP4を保存できませんでした。",
            job.modelId,
          ],
        );
        const resultMessageId = (messageResult.rows[0] as { id: number }).id;
        await client.query(
          `UPDATE alibaba_video_jobs
           SET status = 'FAILED',
               failure_code = 'LOCAL_STORAGE_QUOTA_EXCEEDED',
               failure_message = 'Generated video exceeded the durable per-user storage quota',
               result_message_id = $1,
               attempt_count = attempt_count + 1,
               last_polled_at = NOW(),
               next_poll_at = NULL,
               completed_at = NOW(),
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = NOW()
           WHERE id = $2 AND lease_owner = $3`,
          [resultMessageId, job.id, job.leaseOwner],
        );
        await client.query("COMMIT");
        return;
      }
    }

    const messageResult = await client.query(
      `INSERT INTO messages (conversation_id, role, content, model_id)
       VALUES ($1, 'assistant', $2, $3)
       RETURNING id`,
      [job.conversationId, "動画生成が完了しました。", job.modelId],
    );
    const resultMessageId = (messageResult.rows[0] as { id: number }).id;
    const assetResult = await client.query(
      `INSERT INTO assets (conversation_id, message_id, filename, mime_type, size, data)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        job.conversationId,
        resultMessageId,
        video.filename,
        video.mimeType,
        video.size,
        video.buffer.toString("base64"),
      ],
    );
    const assetId = (assetResult.rows[0] as { id: number }).id;
    await client.query(
      `UPDATE messages SET asset_ids = $1 WHERE id = $2`,
      [JSON.stringify([assetId]), resultMessageId],
    );
    await client.query(
      `UPDATE alibaba_video_jobs
       SET status = 'SUCCEEDED',
           provider_request_id = COALESCE($1, provider_request_id),
           failure_code = NULL,
           failure_message = NULL,
           result_message_id = $2,
           asset_id = $3,
           attempt_count = attempt_count + 1,
           last_polled_at = NOW(),
           next_poll_at = NULL,
           completed_at = NOW(),
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = NOW()
       WHERE id = $4 AND lease_owner = $5`,
      [task.requestId ?? video.requestId ?? null, resultMessageId, assetId, job.id, job.leaseOwner],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function defaultDependencies(): AlibabaVideoWorkerDependencies {
  return {
    now: () => new Date(),
    fetchTask: (taskId) => getAlibabaVideoTask(taskId),
    downloadResult: (task, modelId) => downloadAlibabaVideoResult(task, modelId),
    recordProgress: updateProgress,
    recordTerminalFailure: updateTerminalFailure,
    recordRetry: updateRetry,
    persistSuccess: persistSuccessfulVideo,
  };
}

export async function processAlibabaVideoJob(
  job: ClaimedAlibabaVideoJob,
  dependencies: AlibabaVideoWorkerDependencies = defaultDependencies(),
): Promise<void> {
  const now = dependencies.now();
  if (job.providerExpiresAt.getTime() <= now.getTime()) {
    await dependencies.recordTerminalFailure(
      job,
      "UNKNOWN",
      "PROVIDER_TASK_EXPIRED",
      "Alibaba video task/result lifetime expired before completion",
    );
    return;
  }

  let task: AlibabaVideoTask;
  try {
    task = await dependencies.fetchTask(job.providerTaskId);
  } catch (error) {
    const nextPollAt = new Date(now.getTime() + retryDelayMs(job.attemptCount));
    await dependencies.recordRetry(
      job,
      nextPollAt,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  assertAlibabaVideoStatusTransition(job.status, task.status);
  if (task.status === "PENDING" || task.status === "RUNNING") {
    const nextPollAt = nextAlibabaVideoPollAt(task.status, now);
    if (!nextPollAt) throw new Error("Non-terminal Alibaba video task did not receive a next poll time");
    await dependencies.recordProgress(job, task, nextPollAt);
    return;
  }

  if (task.status === "FAILED" || task.status === "CANCELED" || task.status === "UNKNOWN") {
    await dependencies.recordTerminalFailure(job, task.status, task.code, task.message);
    return;
  }

  let video: AlibabaGeneratedVideo;
  try {
    video = await dependencies.downloadResult(task, job.modelId);
  } catch (error) {
    const nextPollAt = new Date(now.getTime() + retryDelayMs(job.attemptCount));
    await dependencies.recordRetry(
      job,
      nextPollAt,
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  await dependencies.persistSuccess(job, task, video);
}

export interface AlibabaVideoWorkerHandle {
  close: () => Promise<void>;
}

export function startAlibabaVideoWorker(): AlibabaVideoWorkerHandle {
  if (process.env.ALIBABA_VIDEO_WORKER_ENABLED === "0" || !isAlibabaSpecialistConfigured()) {
    logger.info("Alibaba video worker disabled because specialist credentials are unavailable or worker is disabled");
    return { close: async () => undefined };
  }

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;

  const tick = async (): Promise<void> => {
    if (stopped || active) return;
    active = (async () => {
      const job = await claimDueJob(new Date());
      if (job) await processAlibabaVideoJob(job);
    })()
      .catch((error) =>
        logger.error(
          safeFailureFields(error, "alibaba-video-worker", "VIDEO_WORKER_TICK_FAILED"),
          "Alibaba video worker tick failed",
        ),
      )
      .finally(() => {
        active = undefined;
      });
    await active;
  };

  timer = setInterval(() => void tick(), WORKER_TICK_MS);
  timer.unref?.();
  void tick();
  logger.info({ tickMs: WORKER_TICK_MS, leaseMs: WORKER_LEASE_MS }, "Alibaba video worker started");

  return {
    close: async () => {
      stopped = true;
      if (timer) clearInterval(timer);
      await active;
      logger.info("Alibaba video worker stopped");
    },
  };
}