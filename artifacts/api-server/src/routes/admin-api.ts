import { Router, type Request, type Response } from "express";
import { asc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  appUsers,
  llmModels,
  llmProviders,
  providerCredentials,
  userSettings,
} from "@workspace/db";
import {
  getCatalogModels,
  getCatalogProviders,
  isBuiltinProviderId,
  refreshModelCatalog,
} from "../lib/model-catalog";
import {
  encryptSecret,
  envKeyPresent,
  keyHint,
} from "../lib/provider-credentials";
import { resolveAuthMode } from "../middlewares/requireAuth";
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  countAdmins,
  deleteSessionsForUser,
  findUserById,
  hashPassword,
  isValidUsername,
  newAccountId,
  normalizeUsername,
  toAppUserRole,
} from "../lib/password-auth";
import { deleteAllUserData } from "../lib/usage-tracking";
import { logSafeHttpError } from "../lib/http-error-observability";

/**
 * Admin catalog + account management. Mounted by routes/admin.ts behind
 * requireAuth + requireAdmin (never mount this router on its own).
 * Outside the OpenAPI contract, like the rest of /admin.
 *
 * API keys are write-only: responses carry `hasKey` and a short `keyHint`,
 * never the key or its ciphertext.
 */

const router = Router();

const BAD_REQUEST = "リクエストが不正です。";

const providerIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,31}$/,
    "IDは英小文字・数字・ハイフンの2〜32文字で指定してください。",
  );

const baseUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "ベースURLは http(s):// で始まるURLを指定してください（認証情報は含めないでください）。");

const apiKeySchema = z.string().trim().min(1).max(1000);

const modelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/\s/.test(value), "モデルIDに空白は使えません。");

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue?.code === "custom" && issue.message
    ? issue.message
    : BAD_REQUEST;
}

function routeParam(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === "string" ? value : "";
}

function sendServerError(
  req: Request,
  res: Response,
  err: unknown,
  message: string,
) {
  logSafeHttpError(req, 500, err, "HTTP_DATABASE");
  res.status(500).json({ error: message });
}

// ---------- Providers ----------

router.get("/admin/providers", (_req, res) => {
  const counts = new Map<string, number>();
  for (const model of getCatalogModels()) {
    counts.set(model.providerId, (counts.get(model.providerId) ?? 0) + 1);
  }
  res.json(
    getCatalogProviders().map((provider) => ({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      hasKey: provider.hasKey,
      keyHint: provider.keyHint,
      configured: isBuiltinProviderId(provider.id)
        ? envKeyPresent(provider.id)
        : provider.hasKey,
      modelCount: counts.get(provider.id) ?? 0,
    })),
  );
});

const createProviderBody = z.object({
  id: providerIdSchema,
  label: z.string().trim().min(1).max(100),
  baseUrl: baseUrlSchema,
  apiKey: apiKeySchema,
});

router.post("/admin/providers", async (req, res) => {
  const parsed = createProviderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const { id, label, baseUrl, apiKey } = parsed.data;
  if (isBuiltinProviderId(id)) {
    res
      .status(409)
      .json({ error: "このIDは組み込みプロバイダーが使用しています。" });
    return;
  }
  try {
    const now = new Date();
    const inserted = await db
      .insert(llmProviders)
      .values({
        id,
        label,
        kind: "custom",
        baseUrl,
        apiKeyEncrypted: encryptSecret(apiKey),
        keyHint: keyHint(apiKey),
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: llmProviders.id });
    if (inserted.length === 0) {
      res.status(409).json({ error: "同じIDのプロバイダーが既に存在します。" });
      return;
    }
    await refreshModelCatalog();
    res.status(201).json({ id });
  } catch (err) {
    sendServerError(req, res, err, "プロバイダーを追加できませんでした。");
  }
});

const patchProviderBody = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    baseUrl: baseUrlSchema.optional(),
    apiKey: apiKeySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

router.patch("/admin/providers/:id", async (req, res) => {
  const id = routeParam(req, "id");
  const parsed = patchProviderBody.safeParse(req.body);
  if (!id || !parsed.success) {
    res
      .status(400)
      .json({ error: parsed.success ? BAD_REQUEST : firstIssue(parsed.error) });
    return;
  }
  const { label, baseUrl, apiKey, enabled } = parsed.data;
  if (
    isBuiltinProviderId(id) &&
    (label !== undefined || baseUrl !== undefined || apiKey !== undefined)
  ) {
    res.status(400).json({
      error:
        "組み込みプロバイダーは有効/無効のみ変更できます（APIキーは環境変数で設定します）。",
    });
    return;
  }
  try {
    const updated = await db
      .update(llmProviders)
      .set({
        ...(label !== undefined ? { label } : {}),
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(apiKey !== undefined
          ? { apiKeyEncrypted: encryptSecret(apiKey), keyHint: keyHint(apiKey) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(llmProviders.id, id))
      .returning({ id: llmProviders.id });
    if (updated.length === 0) {
      res.status(404).json({ error: "プロバイダーが見つかりません。" });
      return;
    }
    await refreshModelCatalog();
    res.status(204).send();
  } catch (err) {
    sendServerError(req, res, err, "プロバイダーを更新できませんでした。");
  }
});

router.delete("/admin/providers/:id", async (req, res) => {
  const id = routeParam(req, "id");
  if (isBuiltinProviderId(id)) {
    res.status(400).json({
      error: "組み込みプロバイダーは削除できません。無効化してください。",
    });
    return;
  }
  try {
    // llm_models rows cascade with the provider.
    const deleted = await db
      .delete(llmProviders)
      .where(eq(llmProviders.id, id))
      .returning({ id: llmProviders.id });
    if (deleted.length === 0) {
      res.status(404).json({ error: "プロバイダーが見つかりません。" });
      return;
    }
    await refreshModelCatalog();
    res.status(204).send();
  } catch (err) {
    sendServerError(req, res, err, "プロバイダーを削除できませんでした。");
  }
});

// ---------- Models ----------

router.get("/admin/models", (_req, res) => {
  const labels = new Map(getCatalogProviders().map((p) => [p.id, p.label]));
  res.json(
    getCatalogModels().map((model) => ({
      id: model.id,
      providerId: model.providerId,
      providerLabel: labels.get(model.providerId) ?? model.providerId,
      label: model.label,
      description: model.description,
      supportsVision: model.supportsVision,
      supportsReasoning: model.supportsReasoning,
      enabled: model.enabled,
      userVisible: model.userVisible,
      builtin: model.builtin,
      sortOrder: model.sortOrder,
    })),
  );
});

const createModelBody = z.object({
  id: modelIdSchema,
  providerId: z.string().trim().min(1).max(32),
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  supportsVision: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  userVisible: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

router.post("/admin/models", async (req, res) => {
  const parsed = createModelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: firstIssue(parsed.error) });
    return;
  }
  const body = parsed.data;
  try {
    const [provider] = await db
      .select({ id: llmProviders.id })
      .from(llmProviders)
      .where(eq(llmProviders.id, body.providerId))
      .limit(1);
    if (!provider) {
      res.status(404).json({ error: "プロバイダーが見つかりません。" });
      return;
    }
    const values = {
      providerId: body.providerId,
      label: body.label,
      description: body.description ?? "",
      supportsVision: body.supportsVision ?? false,
      supportsReasoning: body.supportsReasoning ?? false,
      userVisible: body.userVisible ?? false,
      enabled: body.enabled ?? true,
      deleted: false,
      updatedAt: new Date(),
    };
    const [existing] = await db
      .select({
        builtin: llmModels.builtin,
        deleted: llmModels.deleted,
        providerId: llmModels.providerId,
      })
      .from(llmModels)
      .where(eq(llmModels.id, body.id))
      .limit(1);
    if (existing) {
      // A deleted built-in keeps its id reserved; adding it again restores it.
      if (existing.deleted && existing.providerId === body.providerId) {
        await db.update(llmModels).set(values).where(eq(llmModels.id, body.id));
        await refreshModelCatalog();
        res.status(201).json({ id: body.id, restored: true });
        return;
      }
      res.status(409).json({
        error: existing.deleted
          ? "このIDは削除済みの組み込みモデルです。元のプロバイダーを選んで追加すると復元できます。"
          : "同じIDのモデルが既に存在します。",
      });
      return;
    }
    await db.insert(llmModels).values({
      id: body.id,
      builtin: false,
      sortOrder: 1000,
      createdAt: new Date(),
      ...values,
    });
    await refreshModelCatalog();
    res.status(201).json({ id: body.id, restored: false });
  } catch (err) {
    sendServerError(req, res, err, "モデルを追加できませんでした。");
  }
});

const patchModelBody = z
  .object({
    label: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(500).optional(),
    enabled: z.boolean().optional(),
    userVisible: z.boolean().optional(),
    supportsVision: z.boolean().optional(),
    supportsReasoning: z.boolean().optional(),
  })
  .strict();

// Model ids may contain "/" (e.g. "qwen/qwen3.7-flash"); clients send them
// percent-encoded as a single segment and Express decodes the param.
router.patch("/admin/models/:id", async (req, res) => {
  const id = routeParam(req, "id");
  const parsed = patchModelBody.safeParse(req.body);
  if (!id || !parsed.success) {
    res.status(400).json({ error: BAD_REQUEST });
    return;
  }
  try {
    const updated = await db
      .update(llmModels)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(llmModels.id, id))
      .returning({ deleted: llmModels.deleted });
    if (updated.length === 0 || updated[0].deleted) {
      res.status(404).json({ error: "モデルが見つかりません。" });
      return;
    }
    await refreshModelCatalog();
    res.status(204).send();
  } catch (err) {
    sendServerError(req, res, err, "モデルを更新できませんでした。");
  }
});

router.delete("/admin/models/:id", async (req, res) => {
  const id = routeParam(req, "id");
  try {
    const [existing] = await db
      .select({ builtin: llmModels.builtin, deleted: llmModels.deleted })
      .from(llmModels)
      .where(eq(llmModels.id, id))
      .limit(1);
    if (!existing || existing.deleted) {
      res.status(404).json({ error: "モデルが見つかりません。" });
      return;
    }
    if (existing.builtin) {
      // Tombstone so the boot-time seed does not bring it back.
      await db
        .update(llmModels)
        .set({ deleted: true, updatedAt: new Date() })
        .where(eq(llmModels.id, id));
    } else {
      await db.delete(llmModels).where(eq(llmModels.id, id));
    }
    await refreshModelCatalog();
    res.status(204).send();
  } catch (err) {
    sendServerError(req, res, err, "モデルを削除できませんでした。");
  }
});

// ---------- Accounts (AUTH_MODE=password) ----------

function requirePasswordMode(res: Response): boolean {
  if (resolveAuthMode() === "password") return true;
  res.status(409).json({
    error:
      "ユーザーの追加・削除はパスワード認証モード（AUTH_MODE=password）で利用できます。",
    code: "ACCOUNTS_DISABLED",
  });
  return false;
}

router.get("/admin/accounts", async (req, res) => {
  const authMode = resolveAuthMode();
  if (authMode !== "password") {
    res.json({ authMode, accounts: [] });
    return;
  }
  try {
    const rows = await db
      .select({
        id: appUsers.id,
        username: appUsers.username,
        displayName: appUsers.displayName,
        role: appUsers.role,
        createdAt: appUsers.createdAt,
        lastLoginAt: appUsers.lastLoginAt,
      })
      .from(appUsers)
      .orderBy(asc(appUsers.username));
    res.json({
      authMode,
      accounts: rows.map((row) => ({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        role: toAppUserRole(row.role),
        createdAt: row.createdAt.toISOString(),
        lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    sendServerError(req, res, err, "ユーザー一覧を取得できませんでした。");
  }
});

const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

const createAccountBody = z.object({
  username: z
    .string()
    .trim()
    .max(64)
    .refine(
      isValidUsername,
      "ユーザー名は英小文字・数字で始まる3〜32文字（a-z 0-9 . _ -）で指定してください。",
    ),
  displayName: z.string().trim().max(120).optional(),
  password: passwordSchema,
  role: z.enum(["admin", "user"]).default("user"),
});

function accountBodyError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue?.path[0] === "password") {
    return `パスワードは${PASSWORD_MIN}〜${PASSWORD_MAX}文字で指定してください。`;
  }
  return firstIssue(error);
}

router.post("/admin/accounts", async (req, res) => {
  if (!requirePasswordMode(res)) return;
  const parsed = createAccountBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: accountBodyError(parsed.error) });
    return;
  }
  const { username, displayName, password, role } = parsed.data;
  try {
    const id = newAccountId();
    const now = new Date();
    const inserted = await db
      .insert(appUsers)
      .values({
        id,
        username: normalizeUsername(username),
        displayName: displayName || null,
        passwordHash: await hashPassword(password),
        role,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: appUsers.id });
    if (inserted.length === 0) {
      res.status(409).json({ error: "同じユーザー名が既に存在します。" });
      return;
    }
    res.status(201).json({ id });
  } catch (err) {
    sendServerError(req, res, err, "ユーザーを追加できませんでした。");
  }
});

const patchAccountBody = z
  .object({
    displayName: z.string().trim().max(120).optional(),
    role: z.enum(["admin", "user"]).optional(),
    password: passwordSchema.optional(),
  })
  .strict();

router.patch("/admin/accounts/:id", async (req, res) => {
  if (!requirePasswordMode(res)) return;
  const id = routeParam(req, "id");
  const parsed = patchAccountBody.safeParse(req.body);
  if (!id || !parsed.success) {
    res.status(400).json({
      error: parsed.success ? BAD_REQUEST : accountBodyError(parsed.error),
    });
    return;
  }
  const { displayName, role, password } = parsed.data;
  try {
    const user = await findUserById(id);
    if (!user) {
      res.status(404).json({ error: "ユーザーが見つかりません。" });
      return;
    }
    if (user.role === "admin" && role === "user") {
      if (user.id === req.userId) {
        res
          .status(400)
          .json({
            error: "自分自身を一般ユーザーに変更することはできません。",
          });
        return;
      }
      if ((await countAdmins()) <= 1) {
        res
          .status(400)
          .json({ error: "最後の管理者は一般ユーザーに変更できません。" });
        return;
      }
    }
    await db
      .update(appUsers)
      .set({
        ...(displayName !== undefined
          ? { displayName: displayName || null }
          : {}),
        ...(role !== undefined ? { role } : {}),
        ...(password !== undefined
          ? { passwordHash: await hashPassword(password) }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(appUsers.id, id));
    // A password reset or role change signs the account out everywhere.
    if (password !== undefined || (role !== undefined && role !== user.role)) {
      await deleteSessionsForUser(id);
    }
    res.status(204).send();
  } catch (err) {
    sendServerError(req, res, err, "ユーザーを更新できませんでした。");
  }
});

router.delete("/admin/accounts/:id", async (req, res) => {
  if (!requirePasswordMode(res)) return;
  const id = routeParam(req, "id");
  if (id === req.userId) {
    res.status(400).json({ error: "自分自身は削除できません。" });
    return;
  }
  const purgeData = req.query.purgeData === "true";
  try {
    const user = await findUserById(id);
    if (!user) {
      res.status(404).json({ error: "ユーザーが見つかりません。" });
      return;
    }
    if (user.role === "admin" && (await countAdmins()) <= 1) {
      res.status(400).json({ error: "最後の管理者は削除できません。" });
      return;
    }
    if (purgeData) {
      await deleteAllUserData(id);
      await db.delete(userSettings).where(eq(userSettings.userId, id));
    }
    // Stored BYOK keys belong to the account; never keep them around.
    await db
      .delete(providerCredentials)
      .where(eq(providerCredentials.userId, id));
    // Sessions cascade with the account row.
    await db.delete(appUsers).where(eq(appUsers.id, id));
    res.status(204).send();
  } catch (err) {
    sendServerError(req, res, err, "ユーザーを削除できませんでした。");
  }
});

export default router;
