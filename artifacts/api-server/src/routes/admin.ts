import { Router, type Request, type Response } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db, appUsers } from "@workspace/db";
import { conversations, messages } from "@workspace/db/schema";
import {
  deleteAllUserData,
  getEffectiveBudgetUsd,
  getMonthlyUsageByUser,
  getUserBudgetRows,
  listKnownUserIds,
  resolveDefaultUserBudgetUsd,
  setUserBudget,
  setUserSuspended,
  usageMonthKey,
} from "../lib/usage-tracking";
import { getAdminUserIds, getUserRole } from "../middlewares/allowedUsers";
import { isAdminUserId } from "../lib/password-auth";
import {
  requireAdmin,
  requireAuth,
  resolveAuthMode,
} from "../middlewares/requireAuth";
import { logSafeHttpError } from "../lib/http-error-observability";
import adminCatalogRouter from "./admin-api";

/**
 * Whether a target user is an admin in the active auth mode: app_users in
 * password mode, the ADMIN_CLERK_USER_IDS allowlist otherwise.
 */
async function isAdminUser(target: string): Promise<boolean> {
  if (resolveAuthMode() === "password") return isAdminUserId(target);
  return getUserRole(target) === "admin";
}

/**
 * Admin-only moderation API. Mounted at /api/admin behind requireAuth +
 * requireAdmin. Deliberately outside the OpenAPI contract: this is an
 * internal operations surface for the service operator.
 */

const router = Router();

// Every /admin route is authenticated and admin-only on the server; the
// UI hiding the console is only a convenience.
router.use("/admin", requireAuth, requireAdmin);
// Providers, models and accounts management.
router.use(adminCatalogRouter);

const budgetBody = z.object({
  monthlyBudgetUsd: z.union([z.number().finite().min(0), z.literal(null)]),
});
const suspensionBody = z.object({ suspended: z.boolean() });

async function countPerUser(): Promise<
  Map<string, { conversations: number; messages: number }>
> {
  const conversationCounts = await db
    .select({ userId: conversations.userId, count: sql<number>`count(*)::int` })
    .from(conversations)
    .groupBy(conversations.userId);
  const messageCounts = await db
    .select({
      userId: conversations.userId,
      count: sql<number>`count(${messages.id})::int`,
    })
    .from(messages)
    .innerJoin(conversations, eq(messages.conversationId, conversations.id))
    .groupBy(conversations.userId);

  const counts = new Map<string, { conversations: number; messages: number }>();
  for (const row of conversationCounts) {
    counts.set(row.userId, { conversations: row.count, messages: 0 });
  }
  for (const row of messageCounts) {
    const current = counts.get(row.userId) ?? {
      conversations: 0,
      messages: 0,
    };
    current.messages = row.count;
    counts.set(row.userId, current);
  }
  return counts;
}

router.get("/admin/overview", async (req: Request, res: Response) => {
  try {
    const month = usageMonthKey();
    const authMode = resolveAuthMode();
    const [knownIds, usageByUser, budgetRows, counts, passwordRows] =
      await Promise.all([
        listKnownUserIds(),
        getMonthlyUsageByUser(month),
        getUserBudgetRows(),
        countPerUser(),
        authMode === "password"
          ? db
              .select({
                id: appUsers.id,
                role: appUsers.role,
              })
              .from(appUsers)
          : Promise.resolve([] as { id: string; role: string }[]),
      ]);
    const knownSet = new Set(knownIds);
    if (authMode === "password") {
      for (const row of passwordRows) knownSet.add(row.id);
    } else {
      for (const id of getAdminUserIds()) knownSet.add(id);
    }
    const userIds = [...knownSet].sort();

    const users = await Promise.all(
      userIds.map(async (userId) => {
        const usage = usageByUser.get(userId);
        const budgetRow = budgetRows.get(userId);
        let isAdmin: boolean;
        if (authMode === "password") {
          const pwRow = passwordRows.find((r) => r.id === userId);
          isAdmin = pwRow ? pwRow.role === "admin" : false;
        } else {
          isAdmin = getUserRole(userId) === "admin";
        }
        const budgetUsd = isAdmin
          ? null
          : (budgetRow?.monthlyBudgetUsd ??
            (await getEffectiveBudgetUsd(userId)));
        return {
          userId,
          role: isAdmin ? ("admin" as const) : ("user" as const),
          month,
          promptTokens: usage?.promptTokens ?? 0,
          completionTokens: usage?.completionTokens ?? 0,
          estimatedCostUsd: usage?.estimatedCostUsd ?? 0,
          budgetUsd,
          suspended: budgetRow?.suspended ?? false,
          conversations: counts.get(userId)?.conversations ?? 0,
          messages: counts.get(userId)?.messages ?? 0,
        };
      }),
    );

    res.json({
      month,
      authMode,
      defaultBudgetUsd: resolveDefaultUserBudgetUsd(),
      users,
    });
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "利用状況を取得できませんでした。" });
  }
});

router.put(
  "/admin/users/:userId/budget",
  async (req: Request, res: Response) => {
    const parsed = budgetBody.safeParse(req.body);
    if (!parsed.success || typeof req.params.userId !== "string") {
      res.status(400).json({ error: "リクエストが不正です。" });
      return;
    }
    const target = req.params.userId;
    if (await isAdminUser(target)) {
      res.status(400).json({ error: "管理者には予算を設定できません。" });
      return;
    }
    try {
      await setUserBudget(target, parsed.data.monthlyBudgetUsd);
      res.status(204).send();
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "予算を保存できませんでした。" });
    }
  },
);

router.put(
  "/admin/users/:userId/suspension",
  async (req: Request, res: Response) => {
    const parsed = suspensionBody.safeParse(req.body);
    if (!parsed.success || typeof req.params.userId !== "string") {
      res.status(400).json({ error: "リクエストが不正です。" });
      return;
    }
    const target = req.params.userId;
    if (await isAdminUser(target)) {
      res.status(400).json({ error: "管理者は停止できません。" });
      return;
    }
    try {
      await setUserSuspended(target, parsed.data.suspended);
      res.status(204).send();
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "状態を保存できませんでした。" });
    }
  },
);

router.delete(
  "/admin/users/:userId/data",
  async (req: Request, res: Response) => {
    const target =
      typeof req.params.userId === "string" ? req.params.userId : "";
    if (!target) {
      res.status(400).json({ error: "リクエストが不正です。" });
      return;
    }
    if (await isAdminUser(target)) {
      res.status(400).json({ error: "管理者のデータは削除できません。" });
      return;
    }
    try {
      await deleteAllUserData(target);
      res.status(204).send();
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "ユーザーデータを削除できませんでした。" });
    }
  },
);

export default router;
