import type { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";

import { logger, safeFailureFields } from "../lib/logger";
import {
  createRunExecutionContext,
  withRunExecutionContext,
  type RunStepHandle,
} from "../lib/run-execution";

function authenticatedUserId(req: Request): string | undefined {
  const auth = getAuth(req);
  return (
    (auth?.sessionClaims?.userId as string | undefined) ||
    auth?.userId ||
    undefined
  );
}

function requestTraceId(req: Request): string | undefined {
  const value = (req as Request & { id?: unknown }).id;
  if (typeof value === "string") return value.slice(0, 200);
  if (typeof value === "number") return String(value);
  return undefined;
}

function requestedModelId(req: Request): string | undefined {
  const value = (req.body as { modelId?: unknown } | undefined)?.modelId;
  return typeof value === "string" && value.length <= 300 ? value : undefined;
}

async function ownsConversation(
  conversationId: number,
  userId: string,
): Promise<boolean> {
  const [{ and, eq }, { conversations, db }] = await Promise.all([
    import("drizzle-orm"),
    import("@workspace/db"),
  ]);
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
      ),
    )
    .limit(1);
  return Boolean(conversation);
}

function trackingFailure(error: unknown, code: string): void {
  logger.warn(
    safeFailureFields(error, "chat-run-tracking", code),
    "Run tracking failed open; chat execution continues",
  );
}

/**
 * Establishes a durable Run around a chat HTTP request without changing the
 * existing chat/SSE contract. The AsyncLocalStorage context is inherited by
 * downstream code, so individual stages can opt into executeRunStep() without
 * threading run ids through every function signature.
 */
export async function chatRunTrackingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = authenticatedUserId(req);
  if (!userId) {
    next();
    return;
  }

  const rawConversationId = req.params.conversationId;
  const persistent = typeof rawConversationId === "string";
  const conversationId = persistent
    ? Number.parseInt(rawConversationId, 10)
    : undefined;

  if (
    persistent &&
    (!Number.isSafeInteger(conversationId) || (conversationId ?? 0) <= 0)
  ) {
    next();
    return;
  }

  try {
    if (
      conversationId !== undefined &&
      !(await ownsConversation(conversationId, userId))
    ) {
      // Let the route return its existing not-found/authorization response.
      next();
      return;
    }

    const context = await createRunExecutionContext({
      conversationId: conversationId ?? null,
      userId,
      modelId: requestedModelId(req),
      traceId: requestTraceId(req),
    });

    let rootStep: RunStepHandle;
    try {
      rootStep = await context.startStep("request", {
        modelId: requestedModelId(req),
        metadata: {
          kind: persistent ? "conversation_message" : "ephemeral_message",
          method: req.method,
        },
      });
    } catch (error) {
      trackingFailure(error, "RUN_ROOT_STEP_CREATE_FAILED");
      void context
        .finish("failed", { errorCode: "RUN_TRACKING_INIT_FAILED" })
        .catch((finishError) =>
          trackingFailure(finishError, "RUN_INIT_FAILURE_PERSIST_FAILED"),
        );
      next();
      return;
    }

    let settled = false;
    const settle = (
      runStatus: "completed" | "failed" | "cancelled",
      stepStatus: "completed" | "failed" | "cancelled",
      errorCode?: string,
    ) => {
      if (settled) return;
      settled = true;
      void (async () => {
        try {
          await context.settleStep(rootStep, stepStatus, {
            errorCode: errorCode ?? null,
          });
        } catch (error) {
          trackingFailure(error, "RUN_ROOT_STEP_SETTLE_FAILED");
        }
        try {
          await context.finish(runStatus, {
            errorCode: errorCode ?? null,
          });
        } catch (error) {
          trackingFailure(error, "RUN_SETTLE_FAILED");
        }
      })();
    };

    res.once("finish", () => {
      if (res.statusCode >= 400) {
        settle("failed", "failed", `HTTP_${res.statusCode}`);
      } else {
        settle("completed", "completed");
      }
    });
    res.once("close", () => {
      if (!res.writableEnded) {
        settle("cancelled", "cancelled", "CLIENT_DISCONNECTED");
      }
    });

    withRunExecutionContext(context, () => next());
  } catch (error) {
    trackingFailure(error, "RUN_CONTEXT_CREATE_FAILED");
    next();
  }
}
