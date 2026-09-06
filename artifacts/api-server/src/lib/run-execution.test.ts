import { describe, expect, it } from "vitest";
import type { InsertRun, InsertRunStep } from "@workspace/db";

import {
  createRunExecutionContext,
  executeRunStep,
  getRunExecutionContext,
  withRunExecutionContext,
  type RunPersistence,
} from "./run-execution";

class MemoryRunPersistence implements RunPersistence {
  readonly runs = new Map<string, InsertRun & Record<string, unknown>>();
  readonly steps = new Map<string, InsertRunStep & Record<string, unknown>>();
  runUpdateCount = 0;

  async createRun(input: InsertRun): Promise<void> {
    this.runs.set(input.id, { ...input });
  }

  async updateRun(
    runId: string,
    patch: Partial<InsertRun> & { completedAt?: Date; updatedAt?: Date },
  ): Promise<void> {
    this.runUpdateCount += 1;
    const current = this.runs.get(runId);
    if (!current) throw new Error(`missing run ${runId}`);
    this.runs.set(runId, { ...current, ...patch });
  }

  async createStep(input: InsertRunStep): Promise<void> {
    this.steps.set(input.id, { ...input });
  }

  async updateStep(
    stepId: string,
    patch: Partial<InsertRunStep> & { completedAt?: Date; updatedAt?: Date },
  ): Promise<void> {
    const current = this.steps.get(stepId);
    if (!current) throw new Error(`missing step ${stepId}`);
    this.steps.set(stepId, { ...current, ...patch });
  }
}

describe("RunExecutionContext", () => {
  it("creates a running durable Run and exposes it through async context", async () => {
    const persistence = new MemoryRunPersistence();
    const context = await createRunExecutionContext(
      {
        conversationId: 42,
        userId: "user-1",
        modelId: "model-a",
        traceId: "trace-1",
      },
      persistence,
    );

    const run = persistence.runs.get(context.runId);
    expect(run).toMatchObject({
      conversationId: 42,
      userId: "user-1",
      modelId: "model-a",
      traceId: "trace-1",
      status: "running",
    });
    expect(run?.startedAt).toBeInstanceOf(Date);

    await withRunExecutionContext(context, async () => {
      expect(getRunExecutionContext()).toBe(context);
      await Promise.resolve();
      expect(getRunExecutionContext()).toBe(context);
    });
    expect(getRunExecutionContext()).toBeUndefined();
  });

  it("records successful steps with monotonic sequence and duration", async () => {
    const persistence = new MemoryRunPersistence();
    const context = await createRunExecutionContext(
      { userId: "user-1" },
      persistence,
    );

    const result = await withRunExecutionContext(context, async () => {
      const first = await executeRunStep(
        "search",
        async () => "search-result",
        { metadata: { source: "web" } },
      );
      const second = await executeRunStep("model", async () => "answer");
      return { first, second };
    });

    expect(result).toEqual({ first: "search-result", second: "answer" });
    const steps = [...persistence.steps.values()].sort(
      (a, b) => a.sequence - b.sequence,
    );
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({
      runId: context.runId,
      sequence: 1,
      type: "search",
      status: "completed",
      metadata: { source: "web" },
    });
    expect(steps[1]).toMatchObject({
      sequence: 2,
      type: "model",
      status: "completed",
    });
    expect(Number(steps[0].durationMs)).toBeGreaterThanOrEqual(0);
    expect(steps[0].completedAt).toBeInstanceOf(Date);
  });

  it("marks a failed step and rethrows the original error", async () => {
    const persistence = new MemoryRunPersistence();
    const context = await createRunExecutionContext(
      { userId: "user-1" },
      persistence,
    );
    const failure = Object.assign(new Error("provider failed"), {
      code: "PROVIDER_DOWN",
    });

    await expect(
      withRunExecutionContext(context, () =>
        executeRunStep("model", async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);

    const [step] = [...persistence.steps.values()];
    expect(step).toMatchObject({
      status: "failed",
      errorCode: "PROVIDER_DOWN",
      errorMessage: "provider failed",
    });
  });

  it("settles a Run once so duplicate response events cannot overwrite status", async () => {
    const persistence = new MemoryRunPersistence();
    const context = await createRunExecutionContext(
      { userId: "user-1" },
      persistence,
    );

    await context.finish("completed");
    await context.finish("cancelled", { errorCode: "CLIENT_DISCONNECTED" });

    expect(persistence.runUpdateCount).toBe(1);
    const settled = persistence.runs.get(context.runId);
    expect(settled).toMatchObject({ status: "completed" });
    expect(settled?.errorCode).toBeUndefined();
  });

  it("keeps executeRunStep transparent outside a Run", async () => {
    await expect(
      executeRunStep("model", async () => "plain-result"),
    ).resolves.toBe("plain-result");
  });
});