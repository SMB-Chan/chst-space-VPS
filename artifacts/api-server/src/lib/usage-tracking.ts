import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  alibabaVideoJobs,
  artifacts,
  conversations,
  llmMemories,
  userBudgets,
  userUsageMonthly,
} from "@workspace/db/schema";
import { logger } from "./logger";

/**
 * Per-user token accounting and monthly budget enforcement.
 *
 * General (non-admin) users chat exclusively through OpenRouter budget
 * models, so their spend is estimated from recorded token counts using the
 * catalog prices below. The OpenRouter key's own spend limit remains the
 * hard cap; these budgets are the per-member fair-share layer on top.
 */

import {
  estimateCostUsd,
  estimateTokens,
  resolveDefaultUserBudgetUsd,
  usageMonthKey,
} from "./usage-pricing";
import type { UsageEntry } from "./usage-pricing";

export {
  estimateCostUsd,
  estimateTokens,
  resolveDefaultUserBudgetUsd,
  usageMonthKey,
};

export interface MonthlyUsage {
  month: string;
  promptTokens: number;
  completionTokens: number;
  requests: number;
  estimatedCostUsd: number;
  byModel: {
    modelId: string;
    promptTokens: number;
    completionTokens: number;
    requests: number;
  }[];
}

export async function getUserMonthlyUsage(
  userId: string,
  month = usageMonthKey(),
): Promise<MonthlyUsage> {
  const rows = await db
    .select()
    .from(userUsageMonthly)
    .where(
      and(
        eq(userUsageMonthly.userId, userId),
        eq(userUsageMonthly.month, month),
      ),
    );
  const byModel = rows
    .map((row) => ({
      modelId: row.modelId,
      promptTokens: row.promptTokens,
      completionTokens: row.completionTokens,
      requests: row.requests,
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
  const promptTokens = rows.reduce((sum, row) => sum + row.promptTokens, 0);
  const completionTokens = rows.reduce(
    (sum, row) => sum + row.completionTokens,
    0,
  );
  return {
    month,
    promptTokens,
    completionTokens,
    requests: rows.reduce((sum, row) => sum + row.requests, 0),
    estimatedCostUsd: rows.reduce(
      (sum, row) =>
        sum +
        estimateCostUsd(row.modelId, row.promptTokens, row.completionTokens),
      0,
    ),
    byModel,
  };
}

export async function recordUsageEntry(
  entry: UsageEntry,
  userId: string,
): Promise<void> {
  const total = entry.promptTokens + entry.completionTokens;
  if (!Number.isSafeInteger(total) || total <= 0) return;
  try {
    await db
      .insert(userUsageMonthly)
      .values({
        userId,
        month: usageMonthKey(),
        modelId: entry.modelId,
        promptTokens: Math.max(0, entry.promptTokens),
        completionTokens: Math.max(0, entry.completionTokens),
        requests: 1,
      })
      .onConflictDoUpdate({
        target: [
          userUsageMonthly.userId,
          userUsageMonthly.month,
          userUsageMonthly.modelId,
        ],
        set: {
          promptTokens: sql`${userUsageMonthly.promptTokens} + ${Math.max(0, entry.promptTokens)}`,
          completionTokens: sql`${userUsageMonthly.completionTokens} + ${Math.max(0, entry.completionTokens)}`,
          requests: sql`${userUsageMonthly.requests} + 1`,
          updatedAt: new Date(),
        },
      });
  } catch (error) {
    // Accounting must never break the chat turn.
    logger.warn(
      { component: "usage-tracking", errorCode: "USAGE_RECORD_FAILED" },
      "Failed to record usage entry",
    );
  }
}

export interface BudgetVerdict {
  allowed: boolean;
  reason?: "budget-exceeded" | "suspended";
  usedUsd: number;
  budgetUsd: number;
}

export async function getEffectiveBudgetUsd(userId: string): Promise<number> {
  const [row] = await db
    .select({ monthlyBudgetUsd: userBudgets.monthlyBudgetUsd })
    .from(userBudgets)
    .where(eq(userBudgets.userId, userId))
    .limit(1);
  return row?.monthlyBudgetUsd ?? resolveDefaultUserBudgetUsd();
}

export async function isUserSuspended(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ suspended: userBudgets.suspended })
    .from(userBudgets)
    .where(eq(userBudgets.userId, userId))
    .limit(1);
  return Boolean(row?.suspended);
}

/** Gate for a general user's new AI requests (admins are exempt by caller). */
export async function checkGeneralUserAiAccess(
  userId: string,
): Promise<BudgetVerdict> {
  const [verdict, usage, suspended] = await Promise.all([
    getEffectiveBudgetUsd(userId),
    getUserMonthlyUsage(userId),
    isUserSuspended(userId),
  ]);
  if (suspended) {
    return {
      allowed: false,
      reason: "suspended",
      usedUsd: usage.estimatedCostUsd,
      budgetUsd: verdict,
    };
  }
  if (usage.estimatedCostUsd >= verdict) {
    return {
      allowed: false,
      reason: "budget-exceeded",
      usedUsd: usage.estimatedCostUsd,
      budgetUsd: verdict,
    };
  }
  return { allowed: true, usedUsd: usage.estimatedCostUsd, budgetUsd: verdict };
}

export async function setUserBudget(
  userId: string,
  monthlyBudgetUsd: number | null,
): Promise<void> {
  await db
    .insert(userBudgets)
    .values({ userId, monthlyBudgetUsd, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userBudgets.userId,
      set: { monthlyBudgetUsd, updatedAt: new Date() },
    });
}

export async function setUserSuspended(
  userId: string,
  suspended: boolean,
): Promise<void> {
  await db
    .insert(userBudgets)
    .values({ userId, suspended, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userBudgets.userId,
      set: { suspended, updatedAt: new Date() },
    });
}

/**
 * Moderation wipe: remove every owned row of a general user. conversations
 * cascades to messages/assets; artifacts, memories, video jobs and the
 * accounting rows are deleted explicitly. The caller must verify the target
 * is not an admin.
 */
export async function deleteAllUserData(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(conversations).where(eq(conversations.userId, userId));
    await tx.delete(artifacts).where(eq(artifacts.userId, userId));
    await tx.delete(llmMemories).where(eq(llmMemories.userId, userId));
    await tx
      .delete(alibabaVideoJobs)
      .where(eq(alibabaVideoJobs.userId, userId));
    await tx
      .delete(userUsageMonthly)
      .where(eq(userUsageMonthly.userId, userId));
    await tx.delete(userBudgets).where(eq(userBudgets.userId, userId));
  });
}

/** Distinct user ids known to the service (for the admin overview). */
export async function listKnownUserIds(): Promise<string[]> {
  const conversationUsers = await db
    .selectDistinct({ userId: conversations.userId })
    .from(conversations);
  const memoryUsers = await db
    .selectDistinct({ userId: llmMemories.userId })
    .from(llmMemories);
  const usageUsers = await db
    .selectDistinct({ userId: userUsageMonthly.userId })
    .from(userUsageMonthly);
  return [
    ...new Set([
      ...conversationUsers.map((row) => row.userId),
      ...memoryUsers.map((row) => row.userId),
      ...usageUsers.map((row) => row.userId),
    ]),
  ].sort();
}

export interface PerUserUsageRow {
  userId: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
}

export async function getMonthlyUsageByUser(
  month = usageMonthKey(),
): Promise<Map<string, PerUserUsageRow>> {
  const rows = await db
    .select()
    .from(userUsageMonthly)
    .where(inArray(userUsageMonthly.month, [month]));
  const map = new Map<string, PerUserUsageRow>();
  for (const row of rows) {
    const current = map.get(row.userId) ?? {
      userId: row.userId,
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
    };
    current.promptTokens += row.promptTokens;
    current.completionTokens += row.completionTokens;
    current.estimatedCostUsd += estimateCostUsd(
      row.modelId,
      row.promptTokens,
      row.completionTokens,
    );
    map.set(row.userId, current);
  }
  return map;
}

export async function getUserBudgetRows(): Promise<
  Map<string, { monthlyBudgetUsd: number | null; suspended: boolean }>
> {
  const rows = await db.select().from(userBudgets);
  return new Map(
    rows.map((row) => [
      row.userId,
      { monthlyBudgetUsd: row.monthlyBudgetUsd, suspended: row.suspended },
    ]),
  );
}
