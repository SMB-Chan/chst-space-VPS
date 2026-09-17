import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  conversations,
  messages,
  artifacts,
  assets,
  alibabaVideoJobs,
  userSettings,
} from "@workspace/db/schema";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import {
  CreateOpenaiConversationBody,
  CreateOpenaiVideoJobBody,
  DeleteOpenaiMessagesBody,
  SendOpenaiMessageBody,
  UpdateOpenaiConversationBody,
} from "@workspace/api-zod";
import { requireAuth, getUserId } from "../middleware";
import {
  DEFAULT_MODEL,
  parseReasoningLevel,
  getClientForModel,
  type ChatModel,
  type ReasoningLevel,
} from "../../lib/ai-clients";
import {
  DEFAULT_PROVIDER_BASE_URLS,
  deleteProviderCredential,
  isProviderId,
  listProviderCredentials,
  upsertProviderCredential,
} from "../../lib/provider-credentials";
import {
  getAvailableChatModels,
  getCapabilityRegistryWithAvailability,
} from "../../lib/specialist-capabilities";
import {
  createResponseCancellation,
  streamChatReply,
  withTimeout,
  type ResponseCancellation,
} from "../../lib/chat-stream";
import { isVisionBridgeAvailable } from "../../lib/vision-bridge";
import {
  parseTranslationMode,
  type TranslationMode,
} from "../../lib/translation";
import { logger, safeFailureFields } from "../../lib/logger";
import type { FileFormat } from "../../lib/file-generation";
import {
  FILE_EXTRACTION_TIMEOUT_MS,
  FileExtractionError,
  resolveBinaryAttachments,
} from "../../lib/file-extraction";
import { TranscriptionError } from "../../lib/audio-transcription";
import { normalizeConversationTitle } from "../../lib/conversation-title";
import {
  deleteOwnedMessagesAndAssets,
  persistChatCompletion,
  persistInterruptedChatTurn,
} from "../../lib/completion-persistence";
import {
  createHistoricalImageBudget,
  modelContentForHistorical,
} from "../../lib/historical-image-budget";
import { budgetConversationHistory } from "../../lib/history-budget";
import {
  UserMessageContentError,
  fallbackHistoricalUserContent,
  modelContentFor,
  parseUserMessageContent,
  type IncomingAttachment,
  type ParsedUserMessageContent,
} from "../../lib/message-content";
import {
  AlibabaRealtimeError,
  createAlibabaRealtimeSession,
} from "../../lib/alibaba-realtime";
import {
  ALIBABA_CAPABILITY_DEFAULTS,
  modelHasAlibabaCapability,
} from "../../lib/alibaba-capabilities";
import {
  AlibabaVideoError,
  cancelAlibabaVideoTask,
  submitAlibabaVideoTask,
  type AlibabaVideoMode,
} from "../../lib/alibaba-video";
import {
  alibabaVideoProviderExpiresAt,
  canCancelAlibabaVideoStatus,
} from "../../lib/alibaba-video-job-state";
import { logSafeHttpError } from "../../lib/http-error-observability";
import { publicAiError } from "../../lib/public-error";
import { parseStoredFactuality } from "../../lib/factuality";
import { deleteAllMemories } from "../../lib/llm-memory-store";
import { checkGeneralUserAiAccess } from "../../lib/usage-tracking";
import type { UserRole } from "../../middlewares/allowedUsers";

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * Monthly fair-share gate for general users: blocks new AI turns once the
 * member's estimated spend reaches their budget, or when they are suspended.
 * Admins are exempt. Reading conversations stays possible either way.
 */
async function enforceGeneralUserAiAccess(
  req: Request,
  res: Response,
): Promise<boolean> {
  if (req.userRole === "admin" || !req.userId) return true;
  let verdict: Awaited<ReturnType<typeof checkGeneralUserAiAccess>>;
  try {
    verdict = await checkGeneralUserAiAccess(req.userId);
  } catch (err) {
    // Accounting infrastructure must never block chatting: fail open and let
    // the provider-side key spend limit bound the total. (Boot drift once left
    // the usage tables uncreated and every send failed with a 500.)
    logger.warn(
      safeFailureFields(err, "openai-route", "BUDGET_CHECK_FAILED"),
      "Budget check failed; allowing the request",
    );
    return true;
  }
  if (verdict.allowed) return true;
  const message =
    verdict.reason === "suspended"
      ? "このアカウントは管理者によって一時停止されています。"
      : `今月の利用上限（${formatUsd(verdict.budgetUsd)}）に達しました。使用量は${formatUsd(verdict.usedUsd)}です。来月までお待ちいただくか、管理者に上限の引き上げを相談してください。`;
  res.status(429).json({
    error: message,
    code:
      verdict.reason === "suspended"
        ? "USER_SUSPENDED"
        : "USER_BUDGET_EXCEEDED",
  });
  return false;
}

const router = Router();

function parsePositiveInt(
  raw: string | number | string[] | undefined,
): number | undefined {
  const first = Array.isArray(raw) ? raw[0] : raw;
  const value = typeof first === "number" ? first : Number(String(first ?? ""));
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseStoredAssetIds(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (id): id is number =>
        typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    );
  } catch {
    logger.warn(
      { component: "openai-route", errorCode: "MALFORMED_ASSET_IDS" },
      "Ignoring malformed message assetIds JSON",
    );
    return null;
  }
}

function parseStoredSources(
  raw: string | null,
): { title: string; url: string }[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(
      (item): item is { title: string; url: string } =>
        !!item &&
        typeof item === "object" &&
        typeof (item as { title?: unknown }).title === "string" &&
        typeof (item as { url?: unknown }).url === "string",
    );
  } catch {
    logger.warn(
      { component: "openai-route", errorCode: "MALFORMED_SOURCES" },
      "Ignoring malformed message sources JSON",
    );
    return null;
  }
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^a-zA-Z0-9._-]+/g, "_") || "artifact.txt";
  const encoded = encodeURIComponent(filename).replace(/'/g, "%27");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

interface ResolvedChatParams {
  modelId: string;
  modelDef: ChatModel;
  reasoningLevel: ReasoningLevel;
  auditModel?: ChatModel;
  auditReasoningLevel: ReasoningLevel;
  translationMode?: TranslationMode;
  supportsVision: boolean;
  useVisionBridge: boolean;
  audioAttachmentsForTools: { name: string; buffer: Buffer; mime: string }[];
  resolvedMessage: ParsedUserMessageContent;
}

async function resolveSharedChatParams(
  req: Request,
  res: Response,
  parsedData: {
    content: string;
    attachments?: unknown;
    modelId?: string;
    fileFormat?: string;
  },
  cancellation: ResponseCancellation,
): Promise<ResolvedChatParams | null> {
  let newMessage: ParsedUserMessageContent;
  try {
    newMessage = parseUserMessageContent(
      parsedData.content,
      parsedData.attachments as IncomingAttachment[] | undefined,
    );
  } catch (error) {
    if (sendMessageContentError(res, error)) return null;
    throw error;
  }

  const modelQuery = typeof req.query.model === "string" ? req.query.model : "";
  const availableModels = await getAvailableChatModels();
  const defaultModel =
    availableModels.find(
      (model) =>
        (req.userRole === "admin" || model.provider === "openrouter") &&
        model.id === DEFAULT_MODEL,
    ) ??
    availableModels.find(
      (model) => req.userRole === "admin" || model.provider === "openrouter",
    );
  const requestedModelId = parsedData.modelId || modelQuery || defaultModel?.id;
  if (!requestedModelId) {
    res.status(503).json({ error: "利用可能なモデルがありません。" });
    return null;
  }
  const modelDef = availableModels.find(
    (model) => model.id === requestedModelId,
  );
  if (!modelDef) {
    res.status(400).json({ error: `未対応のモデルです: ${requestedModelId}` });
    return null;
  }
  const modelId = modelDef.id;
  const reasoningLevel = parseReasoningLevel(req.query.reasoning);
  const auditModelQuery =
    typeof req.query.auditModel === "string" ? req.query.auditModel : "";
  const auditModel =
    auditModelQuery && auditModelQuery !== modelId
      ? availableModels.find((m) => m.id === auditModelQuery)
      : undefined;
  const auditReasoningLevel = parseReasoningLevel(req.query.auditReasoning);
  const translationMode = parseTranslationMode(req.query.translate);

  // General users are provisioned exclusively on OpenRouter budget models.
  // The model picker hides the rest; this is the server-side backstop.
  if (req.userRole !== "admin" && modelDef.provider !== "openrouter") {
    res.status(403).json({
      error:
        "一般ユーザーはOpenRouterモデルのみ利用できます。モデルを選び直してください。",
      code: "MODEL_NOT_ALLOWED",
    });
    return null;
  }
  if (
    auditModel &&
    req.userRole !== "admin" &&
    auditModel.provider !== "openrouter"
  ) {
    res.status(403).json({
      error: "一般ユーザーはOpenRouterモデル以外を監査モデルに指定できません。",
      code: "MODEL_NOT_ALLOWED",
    });
    return null;
  }

  const supportsVision = modelDef.supportsVision;
  const useVisionBridge =
    newMessage.hasImages && !supportsVision && isVisionBridgeAvailable();
  if (newMessage.hasImages && !supportsVision && !useVisionBridge) {
    res.status(400).json({
      error: `選択中のモデル（${modelDef.label}）は画像入力に対応していません。画像を送る場合は対応モデルに切り替えてください。`,
    });
    return null;
  }

  const audioAttachmentsForTools = newMessage.binaries
    .filter((attachment) => attachment.family === "audio")
    .map((attachment) => ({
      name: attachment.name,
      buffer: attachment.buffer,
      mime: attachment.mime,
    }));

  try {
    newMessage = await resolveMessageBinaries(
      newMessage,
      res,
      cancellation.signal,
    );
  } catch (err) {
    if (cancellation.signal.aborted) return null;
    logger.warn(
      safeFailureFields(
        err,
        "openai-route",
        "ATTACHMENT_EXTRACTION_FAILED",
        400,
      ),
      "Attachment extraction failed",
    );
    const message = extractionPublicError(err);
    if (!res.headersSent) {
      res.status(400).json({ error: message });
    } else if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
      res.end();
    }
    return null;
  }

  return {
    modelId,
    modelDef,
    reasoningLevel,
    auditModel,
    auditReasoningLevel,
    translationMode,
    supportsVision,
    useVisionBridge,
    audioAttachmentsForTools,
    resolvedMessage: newMessage,
  };
}

async function getHydratedMessages(conversationId: number, userId: string) {
  const messageRows = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const artifactRows = await db
    .select({
      id: artifacts.id,
      messageId: artifacts.messageId,
      filename: artifacts.filename,
      mime: artifacts.mime,
      size: artifacts.size,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.conversationId, conversationId),
        eq(artifacts.userId, userId),
      ),
    )
    .orderBy(asc(artifacts.id));
  const generatedAssetRows = await db
    .select({
      id: assets.id,
      messageId: assets.messageId,
      filename: assets.filename,
      mimeType: assets.mimeType,
      size: assets.size,
    })
    .from(assets)
    .where(eq(assets.conversationId, conversationId))
    .orderBy(asc(assets.id));

  return messageRows.map((message) => {
    const sources = parseStoredSources(message.sources);
    return {
      ...message,
      sources,
      factuality: parseStoredFactuality(
        message.factuality,
        sources?.length ?? 0,
      ),
      assetIds: parseStoredAssetIds(message.assetIds),
      generatedAssets: generatedAssetRows
        .filter((asset) => asset.messageId === message.id)
        .map((asset) => ({
          id: asset.id,
          filename: asset.filename,
          mimeType: asset.mimeType,
          size: asset.size,
          downloadUrl: `/api/openai/assets/${asset.id}`,
        })),
      artifacts: artifactRows
        .filter((artifact) => artifact.messageId === message.id)
        .map(({ messageId: _messageId, ...artifact }) => ({
          ...artifact,
          downloadUrl: `/api/openai/artifacts/${artifact.id}`,
        })),
    };
  });
}

function sendMessageContentError(res: Response, error: unknown): boolean {
  if (!(error instanceof UserMessageContentError)) return false;
  res.status(error.status).json({ error: error.publicMessage });
  return true;
}

function extractionPublicError(err: unknown): string {
  if (err instanceof FileExtractionError || err instanceof TranscriptionError) {
    return err.publicMessage;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/timed out/i.test(message)) {
    return "添付ファイルの解析がタイムアウトしました。ファイルを小さくするか、件数を減らして再試行してください。";
  }
  return "添付ファイルの解析に失敗しました。もう一度添付してください。";
}

/**
 * Binary attachments (PDF/ZIP/Office/audio) are reduced to capped text on the
 * server before anything reaches a model. Extraction can take tens of
 * seconds (audio transcription), so progress is reported over SSE; the route
 * therefore opens the stream here when needed.
 */
async function resolveMessageBinaries(
  message: ParsedUserMessageContent,
  res: Response,
  parentSignal?: AbortSignal,
): Promise<ParsedUserMessageContent> {
  if (!message.hasBinaries) return message;
  if (parentSignal?.aborted)
    throw parentSignal.reason ?? new Error("Attachment extraction cancelled");
  if (!res.headersSent) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
  }
  if (!parentSignal?.aborted && !res.writableEnded) {
    res.write(`data: ${JSON.stringify({ status: "reading-files" })}\n\n`);
  }
  return withTimeout(
    (signal) =>
      resolveBinaryAttachments(
        message,
        (name) => {
          if (!parentSignal?.aborted && !res.writableEnded) {
            res.write(
              `data: ${JSON.stringify({ status: "reading-files", name })}\n\n`,
            );
          }
        },
        signal,
      ),
    FILE_EXTRACTION_TIMEOUT_MS,
    "File extraction",
    parentSignal,
  );
}

type VideoJobStatus =
  | "SUBMITTING"
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "UNKNOWN";

function videoModelForMode(mode: AlibabaVideoMode, modelId?: string): string {
  const capability = `video.${mode}` as "video.t2v" | "video.i2v" | "video.r2v";
  const selected = modelId?.trim() || ALIBABA_CAPABILITY_DEFAULTS[capability];
  if (!selected || !modelHasAlibabaCapability(selected, capability)) {
    throw new AlibabaVideoError(
      `Model ${selected || "(empty)"} does not support ${capability}`,
      "指定された動画モデルはこの処理に対応していません。",
    );
  }
  return selected;
}

function videoJobPublicMessage(status: string): string {
  switch (status) {
    case "SUBMITTING":
      return "動画生成を開始しています。";
    case "PENDING":
      return "動画生成の順番を待っています。";
    case "RUNNING":
      return "動画を生成しています。";
    case "SUCCEEDED":
      return "動画生成が完了しました。";
    case "CANCELED":
      return "動画生成をキャンセルしました。";
    case "FAILED":
      return "動画生成に失敗しました。";
    default:
      return "動画生成の状態を確認しています。";
  }
}

async function toPublicVideoJob(job: typeof alibabaVideoJobs.$inferSelect) {
  let resultAsset: {
    id: number;
    filename: string;
    mimeType: string;
    size: number;
    downloadUrl: string;
  } | null = null;
  if (job.assetId) {
    const [asset] = await db
      .select({
        id: assets.id,
        filename: assets.filename,
        mimeType: assets.mimeType,
        size: assets.size,
      })
      .from(assets)
      .where(
        and(
          eq(assets.id, job.assetId),
          eq(assets.conversationId, job.conversationId),
        ),
      )
      .limit(1);
    if (asset)
      resultAsset = { ...asset, downloadUrl: `/api/openai/assets/${asset.id}` };
  }
  return {
    id: job.id,
    conversationId: job.conversationId,
    requestMessageId: job.requestMessageId,
    modelId: job.modelId,
    mode: job.mode,
    status: job.status as VideoJobStatus,
    failureCode: job.failureCode,
    failureMessage: job.failureMessage,
    resultAsset,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
  };
}

async function getOwnedVideoJob(id: number, userId: string) {
  const [job] = await db
    .select()
    .from(alibabaVideoJobs)
    .where(
      and(eq(alibabaVideoJobs.id, id), eq(alibabaVideoJobs.userId, userId)),
    )
    .limit(1);
  return job;
}

async function markVideoSubmissionFailed(
  jobId: number,
  userId: string,
  error: unknown,
): Promise<void> {
  await db
    .update(alibabaVideoJobs)
    .set({
      status: "FAILED",
      failureCode: "PROVIDER_SUBMISSION_FAILED",
      failureMessage:
        error instanceof Error
          ? error.message.slice(0, 2_000)
          : String(error).slice(0, 2_000),
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(eq(alibabaVideoJobs.id, jobId), eq(alibabaVideoJobs.userId, userId)),
    );
}

router.use("/openai/artifacts", requireAuth);

router.get("/openai/models", async (req, res) => {
  const models = await getAvailableChatModels();
  // General users are provisioned on OpenRouter budget models only; the
  // admin keeps the full provider catalog. Unauthenticated requests see the
  // restricted list too (they cannot start chats anyway).
  res.json(
    req.userRole === "admin"
      ? models
      : models.filter((model) => model.provider === "openrouter"),
  );
});

/** Lightweight authed probe the frontend access gate uses (403 = not invited). */
router.get("/openai/me", requireAuth, (req, res) => {
  res.json({ userId: getUserId(req), role: req.userRole ?? "user" });
});

const appSettingsSchema = z.object({
  defaultModel: z.string().trim().min(1).max(120),
  defaultReasoning: z.enum(["off", "low", "medium", "high"]),
  auditEnabled: z.boolean(),
  auditModelId: z.string().trim().min(1).max(120),
  auditReasoning: z.enum(["off", "low", "medium", "high"]),
  translationMode: z.enum([
    "off",
    "auto",
    "ja-en",
    "en-ja",
    "auto-ko",
    "ja-ko",
    "ko-ja",
    "auto-zh",
    "ja-zh",
    "zh-ja",
  ]),
});

/** Account-scoped UI settings so defaults follow the user across devices. */
router.get("/openai/settings", requireAuth, async (req, res) => {
  try {
    const [row] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, getUserId(req)))
      .limit(1);
    if (!row) {
      res.json({ settings: null });
      return;
    }
    res.json({ settings: JSON.parse(row.data) });
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "設定を取得できませんでした。" });
  }
});

router.put("/openai/settings", requireAuth, async (req, res) => {
  const parsed = appSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "設定の形式が不正です。" });
    return;
  }
  try {
    await db
      .insert(userSettings)
      .values({
        userId: getUserId(req),
        data: JSON.stringify(parsed.data),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { data: JSON.stringify(parsed.data), updatedAt: new Date() },
      });
    res.status(204).send();
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "設定を保存できませんでした。" });
  }
});

/** LLM provider API keys (BYOK) managed from the settings screen. */
router.get("/openai/providers", requireAuth, async (req, res) => {
  try {
    const providers = await listProviderCredentials(getUserId(req));
    res.json({ providers });
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "プロバイダー設定を取得できませんでした。" });
  }
});

router.put("/openai/providers/:provider", requireAuth, async (req, res) => {
  const provider = req.params.provider;
  if (!isProviderId(provider)) {
    res.status(400).json({ error: "未対応のプロバイダーです。" });
    return;
  }
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey : "";
  const baseUrl =
    typeof req.body?.baseUrl === "string" ? req.body.baseUrl : null;
  try {
    const saved = await upsertProviderCredential(
      getUserId(req),
      provider,
      apiKey,
      baseUrl,
    );
    res.json({ provider: saved });
  } catch (err) {
    const message =
      err instanceof Error && /空です/.test(err.message)
        ? err.message
        : "APIキーを保存できませんでした。";
    if (message.includes("空です")) {
      res.status(400).json({ error: message });
      return;
    }
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: message });
  }
});

router.delete("/openai/providers/:provider", requireAuth, async (req, res) => {
  const provider = req.params.provider;
  if (!isProviderId(provider)) {
    res.status(400).json({ error: "未対応のプロバイダーです。" });
    return;
  }
  try {
    await deleteProviderCredential(getUserId(req), provider);
    res.status(204).send();
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "APIキーを削除できませんでした。" });
  }
});

/** Validates a key against the provider without persisting it first. */
router.post("/openai/providers/:provider/test", requireAuth, async (req, res) => {
  const provider = req.params.provider;
  if (!isProviderId(provider)) {
    res.status(400).json({ error: "未対応のプロバイダーです。" });
    return;
  }
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  const baseUrl =
    typeof req.body?.baseUrl === "string" && req.body.baseUrl.trim()
      ? req.body.baseUrl.trim()
      : DEFAULT_PROVIDER_BASE_URLS[provider];
  if (!apiKey) {
    res.status(400).json({ error: "APIキーを入力してください。" });
    return;
  }

  const url =
    provider === "openai"
      ? (baseUrl || process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1") +
        "/models"
      : (baseUrl || "") + "/models";
  if (!url.startsWith("http")) {
    res.status(400).json({ error: "接続先URLが不正です。" });
    return;
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(12_000),
    });
    if (response.ok) {
      res.json({ ok: true, message: "接続に成功しました。" });
      return;
    }
    const detail = await response.text().catch(() => "");
    res.status(response.status === 401 || response.status === 403 ? 400 : 502).json({
      ok: false,
      error:
        response.status === 401 || response.status === 403
          ? "APIキーが拒否されました。キーを確認してください。"
          : `接続に失敗しました (HTTP ${response.status}).${detail ? ` ${detail.slice(0, 160)}` : ""}`,
    });
  } catch (err) {
    logSafeHttpError(req, 502, err, "HTTP_PROVIDER");
    res.status(502).json({ ok: false, error: "プロバイダーへの接続に失敗しました。" });
  }
});

router.get("/openai/capabilities", async (_req, res) => {
  res.json(await getCapabilityRegistryWithAvailability());
});

// Realtime voice runs on the admin's Alibaba credentials; keep it admin-only.
router.post("/openai/realtime/session", requireAuth, async (req, res) => {
  if (req.userRole !== "admin") {
    res.status(403).json({
      error: "リアルタイム音声は管理者のみ利用できます。",
      code: "ADMIN_ONLY",
    });
    return;
  }
  try {
    const userId = getUserId(req);
    const modelId =
      typeof req.body?.modelId === "string" ? req.body.modelId.trim() : "";
    const rawConversationId = req.body?.conversationId;
    const conversationId =
      rawConversationId === undefined
        ? undefined
        : typeof rawConversationId === "number" &&
            Number.isSafeInteger(rawConversationId) &&
            rawConversationId > 0
          ? rawConversationId
          : null;
    if (conversationId === null) {
      res.status(400).json({ error: "会話IDが不正です。" });
      return;
    }
    if (conversationId !== undefined) {
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
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
    }
    const session = createAlibabaRealtimeSession({
      userId,
      modelId,
      conversationId,
    });
    res.setHeader("Cache-Control", "no-store");
    res.json(session);
  } catch (error) {
    if (error instanceof AlibabaRealtimeError) {
      res
        .status(error.retryable ? 503 : 400)
        .json({ error: error.publicMessage });
      return;
    }
    logSafeHttpError(req, 500, error, "HTTP_PROVIDER");
    res.status(500).json({ error: "リアルタイム音声を開始できませんでした。" });
  }
});

router.post(
  "/openai/conversations/:conversationId/video-jobs",
  requireAuth,
  async (req, res) => {
    const userId = getUserId(req);
    const conversationId = parsePositiveInt(req.params.conversationId);
    if (conversationId === undefined) {
      res.status(400).json({ error: "Invalid conversation ID" });
      return;
    }

    const parsed = CreateOpenaiVideoJobBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "動画の入力または実行確認が不正です。" });
      return;
    }

    const input = parsed.data;
    const mode = input.mode as AlibabaVideoMode;
    let modelId: string;
    try {
      modelId = videoModelForMode(mode, input.modelId);
    } catch (error) {
      res.status(400).json({
        error:
          error instanceof AlibabaVideoError
            ? error.publicMessage
            : "指定された動画モデルは利用できません。",
      });
      return;
    }

    let job: typeof alibabaVideoJobs.$inferSelect;
    try {
      const now = new Date();
      job = await db.transaction(async (tx) => {
        const [conversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, conversationId),
              eq(conversations.userId, userId),
            ),
          )
          .limit(1);
        if (!conversation) {
          const error = new Error("Conversation not found");
          error.name = "ConversationNotFound";
          throw error;
        }

        const [requestMessage] = await tx
          .insert(messages)
          .values({
            conversationId,
            role: "user",
            content: [
              input.prompt.trim(),
              "",
              `動画生成: ${mode.toUpperCase()}`,
              input.referenceImages?.length
                ? `参照画像: ${input.referenceImages.length}枚`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n"),
          })
          .returning({ id: messages.id });
        if (!requestMessage)
          throw new Error("Video request message was not created");

        const [created] = await tx
          .insert(alibabaVideoJobs)
          .values({
            userId,
            conversationId,
            requestMessageId: requestMessage.id,
            // Reserve the idempotency key before calling the provider. The
            // placeholder is never polled by the worker and is replaced below.
            providerTaskId: `pending-${randomUUID()}`,
            idempotencyKey: input.idempotencyKey,
            modelId,
            mode,
            status: "SUBMITTING",
            providerExpiresAt: alibabaVideoProviderExpiresAt(now),
            updatedAt: now,
          })
          .returning();
        if (!created) throw new Error("Video job was not created");
        return created;
      });
    } catch (error) {
      if (error instanceof Error && error.name === "ConversationNotFound") {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      // A concurrent retry with the same key returns the already-reserved job.
      if ((error as { code?: unknown })?.code === "23505") {
        const existing = await db
          .select()
          .from(alibabaVideoJobs)
          .where(
            and(
              eq(alibabaVideoJobs.userId, userId),
              eq(alibabaVideoJobs.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (existing[0]) {
          res.status(200).json(await toPublicVideoJob(existing[0]));
          return;
        }
      }
      logSafeHttpError(req, 500, error, "HTTP_DATABASE");
      res.status(500).json({ error: "動画ジョブを準備できませんでした。" });
      return;
    }

    let submitted;
    try {
      submitted = await submitAlibabaVideoTask({
        mode,
        prompt: input.prompt,
        modelId,
        referenceImages: input.referenceImages,
        resolution: input.resolution,
        ratio: input.ratio,
        duration: input.duration,
        watermark: input.watermark,
        seed: input.seed,
      });
    } catch (error) {
      try {
        await markVideoSubmissionFailed(job.id, userId, error);
      } catch (persistError) {
        logSafeHttpError(req, 503, persistError, "HTTP_DATABASE");
      }
      const publicMessage =
        error instanceof AlibabaVideoError
          ? error.publicMessage
          : "動画生成サービスへの送信に失敗しました。";
      res.status(503).json({ error: publicMessage });
      return;
    }

    let persisted: typeof alibabaVideoJobs.$inferSelect | undefined;
    let persistenceError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const [updated] = await db
          .update(alibabaVideoJobs)
          .set({
            providerTaskId: submitted.taskId,
            providerRequestId: submitted.requestId,
            status: submitted.status,
            nextPollAt:
              submitted.status === "PENDING" || submitted.status === "RUNNING"
                ? new Date()
                : null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(alibabaVideoJobs.id, job.id),
              eq(alibabaVideoJobs.userId, userId),
            ),
          )
          .returning();
        if (updated) {
          persisted = updated;
          break;
        }
        persistenceError = new Error(
          "Video job reservation disappeared before provider task was linked",
        );
      } catch (error) {
        persistenceError = error;
      }
    }
    if (!persisted) {
      // Never submit again: the provider task was accepted, but the durable
      // link needs operational repair/retry rather than another billable call.
      logSafeHttpError(req, 503, persistenceError, "HTTP_DATABASE");
      res.status(503).json({
        error:
          "動画生成は受け付けられましたが、状態の保存に時間がかかっています。再送信せず、しばらくしてから履歴を確認してください。",
      });
      return;
    }

    res.status(201).json(await toPublicVideoJob(persisted));
  },
);

router.get("/openai/video-jobs/:jobId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const jobId = parsePositiveInt(req.params.jobId);
  if (jobId === undefined) {
    res.status(400).json({ error: "Invalid video job id" });
    return;
  }
  try {
    const job = await getOwnedVideoJob(jobId, userId);
    if (!job) {
      res.status(404).json({ error: "Video job not found" });
      return;
    }
    res.json(await toPublicVideoJob(job));
  } catch (error) {
    logSafeHttpError(req, 500, error, "HTTP_DATABASE");
    res.status(500).json({ error: "動画ジョブの状態を取得できませんでした。" });
  }
});

router.delete("/openai/video-jobs/:jobId", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const jobId = parsePositiveInt(req.params.jobId);
  if (jobId === undefined) {
    res.status(400).json({ error: "Invalid video job id" });
    return;
  }
  try {
    const job = await getOwnedVideoJob(jobId, userId);
    if (!job) {
      res.status(404).json({ error: "Video job not found" });
      return;
    }
    if (
      !canCancelAlibabaVideoStatus(
        job.status as
          | "PENDING"
          | "RUNNING"
          | "SUCCEEDED"
          | "FAILED"
          | "CANCELED"
          | "UNKNOWN",
      )
    ) {
      res
        .status(409)
        .json({ error: "この動画ジョブはすでにキャンセルできません。" });
      return;
    }

    let canceled;
    try {
      canceled = await cancelAlibabaVideoTask(job.providerTaskId);
    } catch (error) {
      res.status(503).json({
        error:
          error instanceof AlibabaVideoError
            ? error.publicMessage
            : "動画生成のキャンセルに失敗しました。",
      });
      return;
    }

    const [updated] = await db
      .update(alibabaVideoJobs)
      .set({
        status: canceled.status === "CANCELED" ? "CANCELED" : job.status,
        providerRequestId: canceled.requestId ?? job.providerRequestId,
        completedAt:
          canceled.status === "CANCELED" ? new Date() : job.completedAt,
        nextPollAt: canceled.status === "CANCELED" ? null : job.nextPollAt,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(alibabaVideoJobs.id, jobId),
          eq(alibabaVideoJobs.userId, userId),
          eq(alibabaVideoJobs.status, "PENDING"),
        ),
      )
      .returning();
    if (!updated) {
      const current = await getOwnedVideoJob(jobId, userId);
      if (
        current?.status === "CANCELED" ||
        current?.status === "FAILED" ||
        current?.status === "SUCCEEDED"
      ) {
        res.json(await toPublicVideoJob(current));
        return;
      }
      res.status(409).json({
        error: "動画ジョブの状態が変わったためキャンセルできませんでした。",
      });
      return;
    }
    res.json(await toPublicVideoJob(updated));
  } catch (error) {
    logSafeHttpError(req, 500, error, "HTTP_DATABASE");
    res.status(500).json({ error: "動画ジョブをキャンセルできませんでした。" });
  }
});

router.get(
  "/openai/artifacts/:artifactId",
  async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const artifactId = parsePositiveInt(req.params.artifactId);
    if (artifactId === undefined) {
      res.status(400).json({ error: "Invalid artifact id" });
      return;
    }
    try {
      const [artifact] = await db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.id, artifactId), eq(artifacts.userId, userId)))
        .limit(1);
      if (!artifact) {
        res.status(404).json({ error: "ファイルが見つかりません" });
        return;
      }
      res.setHeader("Content-Type", artifact.mime);
      res.setHeader("Content-Length", String(artifact.size));
      res.setHeader(
        "Content-Disposition",
        contentDisposition(artifact.filename),
      );
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (artifact.mime.toLowerCase().startsWith("text/html")) {
        res.setHeader("Content-Security-Policy", "sandbox");
      }
      res.send(artifact.content);
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "ファイルの取得に失敗しました" });
    }
  },
);

router.get("/openai/conversations", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const result = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(conversations.createdAt);
    res.json(result);
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

router.get(
  "/openai/conversations/:conversationId",
  requireAuth,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const conversationId = parsePositiveInt(req.params.conversationId);
      if (conversationId === undefined) {
        res.status(400).json({ error: "Invalid conversation ID" });
        return;
      }
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.userId, userId),
          ),
        )
        .limit(1);
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      const messagesResult = await getHydratedMessages(conversation.id, userId);
      res.json({
        ...conversation,
        messages: messagesResult,
      });
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "Failed to get conversation" });
    }
  },
);

router.post("/openai/conversations", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const parsed = CreateOpenaiConversationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const title = normalizeConversationTitle(parsed.data.title);
    if (!title) {
      res.status(400).json({ error: "会話名を入力してください" });
      return;
    }
    const rawProjectId = (req.body as { projectId?: unknown } | undefined)
      ?.projectId;
    const projectId =
      typeof rawProjectId === "number" &&
      Number.isSafeInteger(rawProjectId) &&
      rawProjectId > 0
        ? rawProjectId
        : null;
    const [conversation] = await db
      .insert(conversations)
      .values({ userId, title, projectId })
      .returning();
    res.status(201).json(conversation);
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

router.patch(
  "/openai/conversations/:conversationId",
  requireAuth,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const conversationId = parsePositiveInt(req.params.conversationId);
      if (conversationId === undefined) {
        res.status(400).json({ error: "Invalid conversation ID" });
        return;
      }
      const parsed = UpdateOpenaiConversationBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid request body" });
        return;
      }
      const title = normalizeConversationTitle(parsed.data.title);
      if (!title) {
        res.status(400).json({ error: "会話名を入力してください" });
        return;
      }
      const rawProjectId = (req.body as { projectId?: unknown } | undefined)
        ?.projectId;
      const patch: { title: string; projectId?: number | null } = { title };
      if (rawProjectId === null) {
        patch.projectId = null;
      } else if (
        typeof rawProjectId === "number" &&
        Number.isSafeInteger(rawProjectId) &&
        rawProjectId > 0
      ) {
        patch.projectId = rawProjectId;
      }
      const [updated] = await db
        .update(conversations)
        .set(patch)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.userId, userId),
          ),
        )
        .returning();
      if (!updated) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json(updated);
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "Failed to update conversation" });
    }
  },
);

router.delete("/openai/conversations", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    await db.delete(conversations).where(eq(conversations.userId, userId));
    res.status(204).send();
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "Failed to wipe conversations" });
  }
});

router.delete("/openai/memories", requireAuth, async (req, res) => {
  try {
    await deleteAllMemories(getUserId(req));
    res.status(204).send();
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "Failed to wipe memories" });
  }
});

router.delete(
  "/openai/conversations/:conversationId",
  requireAuth,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const conversationId = parsePositiveInt(req.params.conversationId);
      if (conversationId === undefined) {
        res.status(400).json({ error: "Invalid conversation ID" });
        return;
      }
      const [deleted] = await db
        .delete(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.userId, userId),
          ),
        )
        .returning({ id: conversations.id });
      if (!deleted) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.status(204).send();
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "Failed to delete conversation" });
    }
  },
);

router.get(
  "/openai/conversations/:conversationId/messages",
  requireAuth,
  async (req, res) => {
    try {
      const userId = getUserId(req);
      const conversationId = parsePositiveInt(req.params.conversationId);
      if (conversationId === undefined) {
        res.status(400).json({ error: "Invalid conversation ID" });
        return;
      }
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
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      res.json(await getHydratedMessages(conversationId, userId));
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "Failed to list messages" });
    }
  },
);

// The OpenAPI-generated Zod schema is the transport contract. Attachment
// byte/type validation remains in message-content.ts because it requires
// decoded-size checks and compatibility parsing.
const sendMessageBody = SendOpenaiMessageBody;

router.post(
  "/openai/conversations/:conversationId/messages",
  requireAuth,
  async (req, res) => {
    const userId = getUserId(req);
    const conversationId = parsePositiveInt(req.params.conversationId);
    if (conversationId === undefined) {
      res.status(400).json({ error: "Invalid conversation ID" });
      return;
    }

    const parsed = sendMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }

    const cancellation = createResponseCancellation(res);
    try {
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.userId, userId),
          ),
        )
        .limit(1);
      if (!conversation) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }
      if (!(await enforceGeneralUserAiAccess(req, res))) return;

      const requestedFileFormat = parsed.data.fileFormat as
        FileFormat | undefined;

      const shared = await resolveSharedChatParams(
        req,
        res,
        parsed.data,
        cancellation,
      );
      if (!shared) return;
      const {
        modelId,
        modelDef,
        reasoningLevel,
        auditModel,
        auditReasoningLevel,
        translationMode,
        supportsVision,
        useVisionBridge,
        audioAttachmentsForTools,
      } = shared;
      let newMessage = shared.resolvedMessage;

      if (cancellation.signal.aborted) return;
      const history = await db
        .select()
        .from(messages)
        .where(eq(messages.conversationId, conversationId))
        .orderBy(asc(messages.createdAt), asc(messages.id));
      if (cancellation.signal.aborted) return;

      const historicalImageBudget = createHistoricalImageBudget();
      const historicalChatMessages: {
        role: "user" | "assistant";
        content: unknown;
      }[] = [];
      // Walk newest-first so the bounded replay budget keeps the most recent
      // historical images, then restore chronological order for the model.
      for (const msg of [...history].reverse()) {
        if (msg.role === "user") {
          try {
            const parsedHistory = parseUserMessageContent(msg.content);
            historicalChatMessages.push({
              role: "user",
              content: modelContentForHistorical(
                parsedHistory,
                supportsVision,
                historicalImageBudget,
              ),
            });
          } catch (error) {
            logger.warn(
              safeFailureFields(
                error,
                "openai-route",
                "HISTORICAL_ATTACHMENT_OMITTED",
              ),
              "Historical attachment could not be reconstructed; omitting its payload",
            );
            historicalChatMessages.push({
              role: "user",
              content: fallbackHistoricalUserContent(msg.content),
            });
          }
        } else {
          historicalChatMessages.push({
            role: "assistant",
            content: msg.content,
          });
        }
      }
      historicalChatMessages.reverse();
      // Bounded replay keeps long-lived threads inside the model context
      // window instead of overflowing it (providers then drop old turns).
      const budgetedHistory = budgetConversationHistory(historicalChatMessages);
      const chatMessages = [...budgetedHistory.messages];
      chatMessages.push({
        role: "user",
        content: useVisionBridge
          ? newMessage.modelText
          : modelContentFor(newMessage, supportsVision),
      });
      if (cancellation.signal.aborted) return;

      const { client, provider } = getClientForModel(
        modelId,
        modelDef.provider,
      );

      await streamChatReply({
        req,
        res,
        client,
        provider,
        modelId,
        reasoningLevel,
        auditReasoningLevel,
        userText: newMessage.question,
        chatMessages: chatMessages as Parameters<
          typeof streamChatReply
        >[0]["chatMessages"],
        auditModel,
        attachmentsForAudit: {
          textFiles: newMessage.attachments
            .filter((attachment) => attachment.kind === "file")
            .map((attachment) => ({
              name: attachment.name,
              content: attachment.content,
            })),
          imageDataUrls: newMessage.images.map((image) => image.content),
        },
        visionBridgeImages: useVisionBridge
          ? newMessage.images.map((image) => image.content)
          : undefined,
        imageAttachmentsForTools: newMessage.images,
        audioAttachmentsForTools,
        translationMode,
        conversationId,
        requestedFileFormat,
        cancellation,
        memory: {
          enabled: true,
          userId,
          projectId: conversation.projectId,
        },
        userRole: (req.userRole ?? "user") as UserRole,
        publicAiError,
        onComplete: async ({
          content,
          sources,
          audit,
          factuality,
          artifacts: extractedArtifacts,
          generatedFiles,
          generatedAssets,
        }) => {
          if (cancellation.signal.aborted) return;
          const persisted = await persistChatCompletion({
            userId,
            conversationId,
            userContent: newMessage.storedContent,
            assistantContent: content,
            modelId,
            sources,
            audit,
            factuality,
            generatedFiles,
            generatedAssets,
            extractedArtifacts,
          });
          return {
            assets: persisted.assets,
            artifacts: persisted.artifacts,
            quotaExceeded: persisted.quotaExceeded,
          };
        },
        onFailure: async ({ content, sources }) => {
          if (cancellation.signal.aborted) return;
          const interruptedContent = content.trim()
            ? content
            : sources.length > 0
              ? "検索結果は取得できましたが、AI接続が中断したため最終回答を生成できませんでした。下の出典を参照するか、もう一度お試しください。"
              : undefined;
          await persistInterruptedChatTurn({
            userId,
            conversationId,
            userContent: newMessage.storedContent,
            assistantContent: interruptedContent,
            modelId,
            sources,
          });
        },
      });
    } catch (err) {
      logSafeHttpError(req, 500, err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to send message" });
      } else if (!res.writableEnded) {
        res.end();
      }
    } finally {
      cancellation.dispose();
    }
  },
);

router.delete("/openai/messages", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const parsed = DeleteOpenaiMessagesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    const requestedIds = [...new Set(parsed.data.ids)];
    const deletedIds = await deleteOwnedMessagesAndAssets(userId, requestedIds);
    if (deletedIds.length === 0) {
      res.status(404).json({ error: "Messages not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    logSafeHttpError(req, 500, err, "HTTP_DATABASE");
    res.status(500).json({ error: "Failed to delete messages" });
  }
});

router.post("/openai/ephemeral/messages", requireAuth, async (req, res) => {
  const parsed = sendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const cancellation = createResponseCancellation(res);
  try {
    if (parsed.data.fileFormat) {
      res.status(400).json({
        error:
          "プライベートセッションではPDF・Officeファイル生成を利用できません。通常の会話で実行してください。",
      });
      return;
    }
    if (!(await enforceGeneralUserAiAccess(req, res))) return;

    const shared = await resolveSharedChatParams(
      req,
      res,
      parsed.data,
      cancellation,
    );
    if (!shared) return;
    const {
      modelId,
      modelDef,
      reasoningLevel,
      auditModel,
      auditReasoningLevel,
      translationMode,
      supportsVision,
      useVisionBridge,
      audioAttachmentsForTools,
    } = shared;
    let newMessage = shared.resolvedMessage;

    if (cancellation.signal.aborted) return;
    const historicalImageBudget = createHistoricalImageBudget();
    const historicalChatMessages: {
      role: "user" | "assistant";
      content: unknown;
    }[] = [];
    for (const hist of [...(parsed.data.history ?? [])].reverse()) {
      if (hist.role === "user") {
        try {
          const parsedHistory = await resolveMessageBinaries(
            parseUserMessageContent(
              hist.content,
              hist.attachments as IncomingAttachment[] | undefined,
            ),
            res,
            cancellation.signal,
          );
          historicalChatMessages.push({
            role: "user",
            content: modelContentForHistorical(
              parsedHistory,
              supportsVision,
              historicalImageBudget,
            ),
          });
        } catch (error) {
          if (cancellation.signal.aborted) return;
          logger.warn(
            safeFailureFields(
              error,
              "openai-route",
              "HISTORICAL_ATTACHMENT_OMITTED",
            ),
            "Private-session history attachment could not be reconstructed; omitting its payload",
          );
          historicalChatMessages.push({
            role: "user",
            content: fallbackHistoricalUserContent(hist.content),
          });
        }
      } else {
        historicalChatMessages.push({
          role: "assistant",
          content: hist.content,
        });
      }
    }
    historicalChatMessages.reverse();
    const budgetedHistory = budgetConversationHistory(historicalChatMessages);
    const chatMessages = [...budgetedHistory.messages];
    chatMessages.push({
      role: "user",
      content: useVisionBridge
        ? newMessage.modelText
        : modelContentFor(newMessage, supportsVision),
    });
    if (cancellation.signal.aborted) return;

    const { client, provider } = getClientForModel(modelId, modelDef.provider);
    await streamChatReply({
      req,
      res,
      client,
      provider,
      modelId,
      reasoningLevel,
      auditReasoningLevel,
      userText: newMessage.question,
      chatMessages: chatMessages as Parameters<
        typeof streamChatReply
      >[0]["chatMessages"],
      auditModel,
      attachmentsForAudit: {
        textFiles: newMessage.attachments
          .filter((attachment) => attachment.kind === "file")
          .map((attachment) => ({
            name: attachment.name,
            content: attachment.content,
          })),
        imageDataUrls: newMessage.images.map((image) => image.content),
      },
      visionBridgeImages: useVisionBridge
        ? newMessage.images.map((image) => image.content)
        : undefined,
      imageAttachmentsForTools: newMessage.images,
      audioAttachmentsForTools,
      translationMode,
      includeArtifactContent: true,
      cancellation,
      memory: { enabled: false },
      userRole: (req.userRole ?? "user") as UserRole,
      publicAiError,
    });
  } catch (err) {
    logSafeHttpError(req, 500, err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to send message" });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    cancellation.dispose();
  }
});

// Download a generated asset. Only the owner of the parent conversation can access it.
router.get(
  "/openai/assets/:assetId",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = getUserId(req);
    const rawId = Array.isArray(req.params.assetId)
      ? req.params.assetId[0]
      : req.params.assetId;
    const assetId = parsePositiveInt(rawId);
    if (assetId === undefined) {
      res.status(400).json({ error: "Invalid asset id" });
      return;
    }

    try {
      const [asset] = await db
        .select()
        .from(assets)
        .where(eq(assets.id, assetId));
      if (!asset) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }

      const [conv] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, asset.conversationId),
            eq(conversations.userId, userId),
          ),
        );
      if (!conv) {
        res.status(404).json({ error: "Asset not found" });
        return;
      }

      const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
      if (!base64Pattern.test(asset.data)) {
        logSafeHttpError(
          req,
          500,
          new Error("invalid asset data"),
          "HTTP_INTERNAL",
        );
        res.status(500).json({ error: "ファイルデータが破損しています" });
        return;
      }
      const buffer = Buffer.from(asset.data, "base64");
      if (buffer.length !== asset.size) {
        logger.warn(
          { component: "openai-route", errorCode: "ASSET_SIZE_MISMATCH" },
          "Asset size mismatch; using decoded buffer length",
        );
      }
      res.setHeader("Content-Type", asset.mimeType);
      res.setHeader(
        "Content-Disposition",
        asset.mimeType.startsWith("audio/") ||
          asset.mimeType.startsWith("image/") ||
          asset.mimeType.startsWith("video/")
          ? "inline"
          : `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
      );
      res.setHeader("Content-Length", String(buffer.length));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end(buffer);
    } catch (err) {
      logSafeHttpError(req, 500, err, "HTTP_DATABASE");
      res.status(500).json({ error: "ファイルの取得に失敗しました" });
    }
  },
);

export default router;
