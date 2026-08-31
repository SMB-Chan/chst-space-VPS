import { describe, expect, it, vi } from "vitest";
import type { AlibabaGeneratedVideo, AlibabaVideoTask } from "./alibaba-video";
import {
  processAlibabaVideoJob,
  type AlibabaVideoWorkerDependencies,
  type ClaimedAlibabaVideoJob,
} from "./alibaba-video-worker";

const NOW = new Date("2026-08-28T00:00:00.000Z");

function makeJob(
  overrides: Partial<ClaimedAlibabaVideoJob> = {},
): ClaimedAlibabaVideoJob {
  return {
    id: 7,
    userId: "user-1",
    conversationId: 11,
    requestMessageId: 13,
    providerTaskId: "task-1",
    modelId: "happyhorse-1.1-t2v",
    mode: "t2v",
    status: "PENDING",
    attemptCount: 0,
    providerExpiresAt: new Date("2026-08-28T12:00:00.000Z"),
    leaseOwner: "worker-1",
    ...overrides,
  };
}

function makeDependencies(task: AlibabaVideoTask): {
  dependencies: AlibabaVideoWorkerDependencies;
  fetchTask: ReturnType<typeof vi.fn>;
  downloadResult: ReturnType<typeof vi.fn>;
  recordProgress: ReturnType<typeof vi.fn>;
  recordTerminalFailure: ReturnType<typeof vi.fn>;
  recordRetry: ReturnType<typeof vi.fn>;
  persistSuccess: ReturnType<typeof vi.fn>;
} {
  const fetchTask = vi.fn().mockResolvedValue(task);
  const downloadResult = vi.fn().mockResolvedValue({
    buffer: Buffer.from("0000ftypmp42"),
    filename: "video.mp4",
    mimeType: "video/mp4",
    size: 12,
    taskId: "task-1",
    modelId: "happyhorse-1.1-t2v",
  } satisfies AlibabaGeneratedVideo);
  const recordProgress = vi.fn().mockResolvedValue(undefined);
  const recordTerminalFailure = vi.fn().mockResolvedValue(undefined);
  const recordRetry = vi.fn().mockResolvedValue(undefined);
  const persistSuccess = vi.fn().mockResolvedValue(undefined);
  return {
    dependencies: {
      now: () => NOW,
      fetchTask,
      downloadResult,
      recordProgress,
      recordTerminalFailure,
      recordRetry,
      persistSuccess,
    },
    fetchTask,
    downloadResult,
    recordProgress,
    recordTerminalFailure,
    recordRetry,
    persistSuccess,
  };
}

describe("Alibaba video worker", () => {
  it("reschedules pending provider tasks using the documented poll interval", async () => {
    const task: AlibabaVideoTask = { taskId: "task-1", status: "PENDING" };
    const { dependencies, recordProgress, downloadResult } =
      makeDependencies(task);

    await processAlibabaVideoJob(makeJob(), dependencies);

    expect(recordProgress).toHaveBeenCalledTimes(1);
    expect(recordProgress.mock.calls[0]?.[2]).toEqual(
      new Date("2026-08-28T00:00:15.000Z"),
    );
    expect(downloadResult).not.toHaveBeenCalled();
  });

  it("downloads and persists a successful result exactly once", async () => {
    const task: AlibabaVideoTask = {
      taskId: "task-1",
      status: "SUCCEEDED",
      requestId: "req-1",
      videoUrl: "https://example.aliyuncs.com/result.mp4",
    };
    const { dependencies, downloadResult, persistSuccess } =
      makeDependencies(task);
    const job = makeJob({ status: "RUNNING" });

    await processAlibabaVideoJob(job, dependencies);

    expect(downloadResult).toHaveBeenCalledWith(task, "happyhorse-1.1-t2v");
    expect(persistSuccess).toHaveBeenCalledTimes(1);
    expect(persistSuccess.mock.calls[0]?.[0]).toBe(job);
  });

  it("marks provider-expired jobs unknown without making a network call", async () => {
    const task: AlibabaVideoTask = { taskId: "task-1", status: "RUNNING" };
    const { dependencies, fetchTask, recordTerminalFailure } =
      makeDependencies(task);
    const job = makeJob({
      providerExpiresAt: new Date("2026-08-27T23:59:59.000Z"),
    });

    await processAlibabaVideoJob(job, dependencies);

    expect(fetchTask).not.toHaveBeenCalled();
    expect(recordTerminalFailure).toHaveBeenCalledWith(
      job,
      "UNKNOWN",
      "PROVIDER_TASK_EXPIRED",
      expect.stringContaining("expired"),
    );
  });

  it("retries transient polling errors without converting the job to a terminal failure", async () => {
    const task: AlibabaVideoTask = { taskId: "task-1", status: "RUNNING" };
    const { dependencies, fetchTask, recordRetry, recordTerminalFailure } =
      makeDependencies(task);
    fetchTask.mockRejectedValueOnce(new Error("temporary provider outage"));

    await processAlibabaVideoJob(makeJob(), dependencies);

    expect(recordRetry).toHaveBeenCalledWith(
      expect.anything(),
      new Date("2026-08-28T00:00:15.000Z"),
      "temporary provider outage",
    );
    expect(recordTerminalFailure).not.toHaveBeenCalled();
  });

  it("persists provider terminal failures without attempting a download", async () => {
    const task: AlibabaVideoTask = {
      taskId: "task-1",
      status: "FAILED",
      code: "InvalidPrompt",
      message: "provider rejected prompt",
    };
    const { dependencies, recordTerminalFailure, downloadResult } =
      makeDependencies(task);

    await processAlibabaVideoJob(makeJob(), dependencies);

    expect(recordTerminalFailure).toHaveBeenCalledWith(
      expect.anything(),
      "FAILED",
      "InvalidPrompt",
      "provider rejected prompt",
    );
    expect(downloadResult).not.toHaveBeenCalled();
  });
});
