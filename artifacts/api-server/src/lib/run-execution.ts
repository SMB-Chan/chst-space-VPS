import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type {
  InsertRun,
  InsertRunStep,
  RunStatus,
  RunStepStatus,
  RunStepType,
} from "@workspace/db";

export interface RunPersistence {
  createRun(input: InsertRun): Promise<void>;
  updateRun(
    runId: string,
    patch: Partial<InsertRun> & { completedAt?: Date; updatedAt?: Date },
  ): Promise<void>;
  createStep(input: InsertRunStep): Promise<void>;
  updateStep(
    stepId: string,
    patch: Partial<InsertRunStep> & { completedAt?: Date; updatedAt?: Date },
  ): Promise<void>;
}

async function loadRunDb() {
  const [{ eq }, dbModule] = await Promise.all([
    import("drizzle-orm"),
    import("@workspace/db"),
  ]);
  return { eq, ...dbModule };
}

export const defaultRunPersistence: RunPersistence = {
  async createRun(input) {
    const { db, runs } = await loadRunDb();
    await db.insert(runs).values(input);
  },
  async updateRun(runId, patch) {
    const { db, eq, runs } = await loadRunDb();
    await db.update(runs).set(patch).where(eq(runs.id, runId));
  },
  async createStep(input) {
    const { db, runSteps } = await loadRunDb();
    await db.insert(runSteps).values(input);
  },
  async updateStep(stepId, patch) {
    const { db, eq, runSteps } = await loadRunDb();
    await db.update(runSteps).set(patch).where(eq(runSteps.id, stepId));
  },
};

export interface CreateRunExecutionContextInput {
  conversationId?: number | null;
  triggerMessageId?: number | null;
  userId: string;
  provider?: string | null;
  modelId?: string | null;
  traceId?: string | null;
}

export interface RunStepOptions {
  inputRef?: string | null;
  outputRef?: string | null;
  provider?: string | null;
  modelId?: string | null;
  metadata?: Record<string, unknown> | null;
  attempt?: number;
}

export interface RunStepHandle {
  id: string;
  sequence: number;
  type: RunStepType;
  startedAt: Date;
}

function errorFields(error: unknown): {
  errorCode: string;
  errorMessage: string;
} {
  if (!(error instanceof Error)) {
    return { errorCode: "ERROR", errorMessage: "Unknown run step failure" };
  }

  const maybeCode = (error as Error & { code?: unknown }).code;
  let errorCode = error.name || "ERROR";
  if (
    typeof maybeCode === "string" &&
    /^[A-Za-z0-9_.:-]{1,64}$/.test(maybeCode)
  ) {
    errorCode = maybeCode;
  }
  return {
    errorCode,
    errorMessage: error.message.slice(0, 1_000),
  };
}

export class RunExecutionContext {
  readonly runId: string;
  private nextStepSequence = 1;
  private finishPromise: Promise<void> | undefined;

  constructor(runId: string, private readonly persistence: RunPersistence) {
    this.runId = runId;
  }

  async startStep(
    type: RunStepType,
    options: RunStepOptions = {},
  ): Promise<RunStepHandle> {
    const startedAt = new Date();
    const handle: RunStepHandle = {
      id: randomUUID(),
      sequence: this.nextStepSequence++,
      type,
      startedAt,
    };
    await this.persistence.createStep({
      id: handle.id,
      runId: this.runId,
      sequence: handle.sequence,
      type,
      status: "running",
      attempt: options.attempt ?? 1,
      inputRef: options.inputRef ?? null,
      outputRef: options.outputRef ?? null,
      provider: options.provider ?? null,
      modelId: options.modelId ?? null,
      metadata: options.metadata ?? null,
      startedAt,
    });
    return handle;
  }

  async settleStep(
    handle: RunStepHandle,
    status: RunStepStatus,
    patch: {
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      outputRef?: string | null;
      metadata?: Record<string, unknown> | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    } = {},
  ): Promise<void> {
    const completedAt = new Date();
    const durationMs = Math.max(
      0,
      completedAt.getTime() - handle.startedAt.getTime(),
    );
    await this.persistence.updateStep(handle.id, {
      status,
      completedAt,
      updatedAt: completedAt,
      durationMs,
      ...patch,
    });
  }

  finish(
    status: Extract<RunStatus, "completed" | "failed" | "cancelled">,
    patch: {
      inputTokens?: number;
      outputTokens?: number;
      costUsd?: number;
      errorCode?: string | null;
      errorMessage?: string | null;
    } = {},
  ): Promise<void> {
    if (this.finishPromise) return this.finishPromise;
    const completedAt = new Date();
    const operation = this.persistence.updateRun(this.runId, {
      status,
      completedAt,
      updatedAt: completedAt,
      ...patch,
    });
    this.finishPromise = operation.catch((error) => {
      // A transient observability write failure may be retried by a later
      // response lifecycle event. Successful settlement remains idempotent.
      this.finishPromise = undefined;
      throw error;
    });
    return this.finishPromise;
  }
}

const runStorage = new AsyncLocalStorage<RunExecutionContext>();

export async function createRunExecutionContext(
  input: CreateRunExecutionContextInput,
  persistence: RunPersistence = defaultRunPersistence,
): Promise<RunExecutionContext> {
  const runId = randomUUID();
  const startedAt = new Date();
  await persistence.createRun({
    id: runId,
    conversationId: input.conversationId ?? null,
    triggerMessageId: input.triggerMessageId ?? null,
    userId: input.userId,
    status: "running",
    provider: input.provider ?? null,
    modelId: input.modelId ?? null,
    traceId: input.traceId ?? null,
    startedAt,
  });
  return new RunExecutionContext(runId, persistence);
}

export function withRunExecutionContext<T>(
  context: RunExecutionContext,
  callback: () => T,
): T {
  return runStorage.run(context, callback);
}

export function getRunExecutionContext(): RunExecutionContext | undefined {
  return runStorage.getStore();
}

/** Mark the current Run failed from an existing synchronous error path. */
export function failCurrentRun(code: string, message?: string): void {
  const context = getRunExecutionContext();
  if (!context) return;
  void context
    .finish("failed", {
      errorCode: code.slice(0, 100),
      errorMessage: message?.slice(0, 1_000),
    })
    .catch(() => {
      // Error-reporting paths must never throw a second failure into chat.
    });
}

/**
 * Instrument one logical AI execution step. Callers that run outside a chat
 * Run keep their current behaviour and incur no persistence work.
 */
export async function executeRunStep<T>(
  type: RunStepType,
  operation: () => Promise<T>,
  options: RunStepOptions = {},
): Promise<T> {
  const context = getRunExecutionContext();
  if (!context) return operation();

  const handle = await context.startStep(type, options);
  try {
    const result = await operation();
    await context.settleStep(handle, "completed");
    return result;
  } catch (error) {
    await context.settleStep(handle, "failed", errorFields(error));
    throw error;
  }
}
