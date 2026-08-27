import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { conversations, messages, artifacts, assets } from "@workspace/db/schema";
import { and, asc, eq } from "drizzle-orm";
import {
  CreateOpenaiConversationBody,
  DeleteOpenaiMessagesBody,
  SendOpenaiMessageBody,
  UpdateOpenaiConversationBody,
} from "@workspace/api-zod";
import { requireAuth, getUserId } from "../middleware";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  VISION_MODEL_IDS,
  parseReasoningLevel,
  getClientForModel,
} from "../../lib/ai-clients";
import {
  getAvailableChatModels,
  getCapabilityRegistryWithAvailability,
} from "../../lib/specialist-capabilities";
import { streamChatReply, withTimeout } from "../../lib/chat-stream";
import { isVisionBridgeAvailable } from "../../lib/vision-bridge";
import { parseTranslationMode } from "../../lib/translation";
import { logger } from "../../lib/logger";
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
} from "../../lib/completion-persistence";
import {
  createHistoricalImageBudget,
  modelContentForHistorical,
} from "../../lib/historical-image-budget";
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

const router = Router();

function publicAiError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const message = raw.toLowerCase();
  if (message.includes("429") || message.includes("quota") || message.includes("rate limit")) {
    return "AIの利用上限に達しました。しばらく待ってから再試行してください。";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "AIの応答がタイムアウトしました。再試行してください。";
  }
  if (
    message.includes("api key") ||
    message.includes("unauthorized") ||
    message.includes("authentication")
  ) {
    return "AI APIキーが無効です。Secretsを確認してください。";
  }
  return "AIの応答中にエラーが発生しました。";
}

function parsePositiveInt(raw: string | number | string[] | undefined): number | undefined {
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
      (id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0,
    );
  } catch {
    logger.warn({ raw }, "Ignoring malformed message assetIds JSON");
    return null;
  }
}

function parseStoredSources(raw: string | null): { title: string; url: string }[] | null {
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
    logger.warn({ raw }, "Ignoring malformed message sources JSON");
    return null;
  }
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^a-zA-Z0-9._-]+/g, "_") || "artifact.txt";
  const encoded = encodeURIComponent(filename).replace(/'/g, "%27");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
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
    .where(and(eq(artifacts.conversationId, conversationId), eq(artifacts.userId, userId)))
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

  return messageRows.map((message) => ({
    ...message,
    sources: parseStoredSources(message.sources),
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
  }));
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
): Promise<ParsedUserMessageContent> {
  if (!message.hasBinaries) return message;
  if (!res.headersSent) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
  }
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify({ status: "reading-files" })}\n\n`);
  }
  return withTimeout(
    (signal) =>
      resolveBinaryAttachments(
        message,
        (name) => {
          if (!res.writableEnded) {
            res.write(`data: ${JSON.stringify({ status: "reading-files", name })}\n\n`);
          }
        },
        signal,
      ),
    FILE_EXTRACTION_TIMEOUT_MS,
    "File extraction",
  );
}

router.use("/openai/artifacts", requireAuth);

router.get("/openai/models", async (_req, res) => {
  res.json(await getAvailableChatModels());
});

router.get("/openai/capabilities", async (_req, res) => {
  res.json(await getCapabilityRegistryWithAvailability());
});

router.post("/openai/realtime/session", requireAuth, (req, res) => {
  try {
    const userId = getUserId(req);
    const modelId = typeof req.body?.modelId === "string" ? req.body.modelId.trim() : "";
    const conversationId =
      typeof req.body?.conversationId === "number" ? req.body.conversationId : undefined;
    const session = createAlibabaRealtimeSession({ userId, modelId, conversationId });
    res.setHeader("Cache-Control", "no-store");
    res.json(session);
  } catch (error) {
    if (error instanceof AlibabaRealtimeError) {
      res.status(error.retryable ? 503 : 400).json({ error: error.publicMessage });
      return;
    }
    req.log.error({ err: error }, "Failed to create realtime session");
    res.status(500).json({ error: "リアルタイム音声を開始できませんでした。" });
  }
});

router.get("/openai/artifacts/:artifactId", async (req: Request, res: Response) => {
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
    res.setHeader("Content-Disposition", contentDisposition(artifact.filename));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (artifact.mime.toLowerCase().startsWith("text/html")) {
      res.setHeader("Content-Security-Policy", "sandbox");
    }
    res.send(artifact.content);
  } catch (err) {
    logger.error({ err, artifactId }, "Failed to download artifact");
    res.status(500).json({ error: "ファイルの取得に失敗しました" });
  }
});

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
    req.log.error({ err }, "Failed to list conversations");
    res.status(500).json({ error: "Failed to list conversations" });
  }
});

router.get("/openai/conversations/:conversationId", requireAuth, async (req, res) => {
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
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
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
    req.log.error({ err }, "Failed to get conversation");
    res.status(500).json({ error: "Failed to get conversation" });
  }
});

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
    const [conversation] = await db
      .insert(conversations)
      .values({ userId, title })
      .returning();
    res.status(201).json(conversation);
  } catch (err) {
    req.log.error({ err }, "Failed to create conversation");
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

router.patch("/openai/conversations/:conversationId", requireAuth, async (req, res) => {
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
    const [updated] = await db
      .update(conversations)
      .set({ title })
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .returning();
    if (!updated) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json(updated);
  } catch (err) {
    req.log.error({ err }, "Failed to update conversation");
    res.status(500).json({ error: "Failed to update conversation" });
  }
});

router.delete("/openai/conversations", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    await db.delete(conversations).where(eq(conversations.userId, userId));
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to wipe conversations");
    res.status(500).json({ error: "Failed to wipe conversations" });
  }
});

router.delete("/openai/conversations/:conversationId", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const conversationId = parsePositiveInt(req.params.conversationId);
    if (conversationId === undefined) {
      res.status(400).json({ error: "Invalid conversation ID" });
      return;
    }
    const [deleted] = await db
      .delete(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .returning({ id: conversations.id });
    if (!deleted) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    req.log.error({ err }, "Failed to delete conversation");
    res.status(500).json({ error: "Failed to delete conversation" });
  }
});

router.get("/openai/conversations/:conversationId/messages", requireAuth, async (req, res) => {
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
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .limit(1);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json(await getHydratedMessages(conversationId, userId));
  } catch (err) {
    req.log.error({ err }, "Failed to list messages");
    res.status(500).json({ error: "Failed to list messages" });
  }
});

// The OpenAPI-generated Zod schema is the transport contract. Attachment
// byte/type validation remains in message-content.ts because it requires
// decoded-size checks and compatibility parsing.
const sendMessageBody = SendOpenaiMessageBody;

router.post("/openai/conversations/:conversationId/messages", requireAuth, async (req, res) => {
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

  try {
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .limit(1);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    let newMessage: ParsedUserMessageContent;
    try {
      newMessage = parseUserMessageContent(
        parsed.data.content,
        parsed.data.attachments as IncomingAttachment[] | undefined,
      );
    } catch (error) {
      if (sendMessageContentError(res, error)) return;
      throw error;
    }

    const modelQuery = typeof req.query.model === "string" ? req.query.model : "";
    const requestedModelId = parsed.data.modelId || modelQuery || DEFAULT_MODEL;
    const modelDef = AVAILABLE_MODELS.find((model) => model.id === requestedModelId);
    if (!modelDef) {
      res.status(400).json({ error: `未対応のモデルです: ${requestedModelId}` });
      return;
    }
    const modelId = modelDef.id;
    const reasoningLevel = parseReasoningLevel(req.query.reasoning);
    const auditModelQuery = typeof req.query.auditModel === "string" ? req.query.auditModel : "";
    const auditModelId =
      auditModelQuery && auditModelQuery !== modelId && AVAILABLE_MODELS.some((m) => m.id === auditModelQuery)
        ? auditModelQuery
        : undefined;
    const auditReasoningLevel = parseReasoningLevel(req.query.auditReasoning);
    const translationMode = parseTranslationMode(req.query.translate);

    const requestedFileFormat = parsed.data.fileFormat as FileFormat | undefined;

    const supportsVision = VISION_MODEL_IDS.has(modelId);
    // Non-vision models are still usable with image attachments: a
    // vision-capable model transcribes the images to text first. Reject only
    // when no vision bridge can be constructed at all.
    const useVisionBridge = newMessage.hasImages && !supportsVision && isVisionBridgeAvailable();
    if (newMessage.hasImages && !supportsVision && !useVisionBridge) {
      res.status(400).json({
        error: `選択中のモデル（${modelDef.label}）は画像入力に対応していません。画像を送る場合は対応モデルに切り替えてください。`,
      });
      return;
    }

    const audioAttachmentsForTools = newMessage.binaries
      .filter((attachment) => attachment.family === "audio")
      .map((attachment) => ({
        name: attachment.name,
        buffer: attachment.buffer,
        mime: attachment.mime,
      }));

    try {
      newMessage = await resolveMessageBinaries(newMessage, res);
    } catch (err) {
      logger.warn({ err, conversationId }, "Attachment extraction failed");
      const message = extractionPublicError(err);
      if (!res.headersSent) {
        res.status(400).json({ error: message });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
      return;
    }

    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    const historicalImageBudget = createHistoricalImageBudget();
    const historicalChatMessages: { role: "user" | "assistant"; content: unknown }[] = [];
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
            { err: error, messageId: msg.id, conversationId },
            "Historical attachment could not be reconstructed; omitting its payload",
          );
          historicalChatMessages.push({
            role: "user",
            content: fallbackHistoricalUserContent(msg.content),
          });
        }
      } else {
        historicalChatMessages.push({ role: "assistant", content: msg.content });
      }
    }
    historicalChatMessages.reverse();
    const chatMessages = [...historicalChatMessages];
    chatMessages.push({
      role: "user",
      content: useVisionBridge
        ? newMessage.modelText
        : modelContentFor(newMessage, supportsVision),
    });

    const { client, provider } = getClientForModel(modelId);

    await streamChatReply({
      req,
      res,
      client,
      provider,
      modelId,
      reasoningLevel,
      auditReasoningLevel,
      userText: newMessage.question,
      chatMessages: chatMessages as Parameters<typeof streamChatReply>[0]["chatMessages"],
      auditModelId,
      attachmentsForAudit: {
        textFiles: newMessage.attachments
          .filter((attachment) => attachment.kind === "file")
          .map((attachment) => ({ name: attachment.name, content: attachment.content })),
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
      publicAiError,
      onComplete: async ({
        content,
        sources,
        audit,
        artifacts: extractedArtifacts,
        generatedFiles,
          generatedAssets,
      }) => {
        const persisted = await persistChatCompletion({
          userId,
          conversationId,
          userContent: newMessage.storedContent,
          assistantContent: content,
          modelId,
          sources,
          audit,
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
    });
  } catch (err) {
    logger.error({ err }, "Failed to send message");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to send message" });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

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
    req.log.error({ err }, "Failed to delete messages");
    res.status(500).json({ error: "Failed to delete messages" });
  }
});

router.post("/openai/ephemeral/messages", requireAuth, async (req, res) => {
  const parsed = sendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    if (parsed.data.fileFormat) {
      res.status(400).json({
        error: "プライベートセッションではPDF・Officeファイル生成を利用できません。通常の会話で実行してください。",
      });
      return;
    }

    let newMessage: ParsedUserMessageContent;
    try {
      newMessage = parseUserMessageContent(
        parsed.data.content,
        parsed.data.attachments as IncomingAttachment[] | undefined,
      );
    } catch (error) {
      if (sendMessageContentError(res, error)) return;
      throw error;
    }

    const modelQuery = typeof req.query.model === "string" ? req.query.model : "";
    const requestedModelId = parsed.data.modelId || modelQuery || DEFAULT_MODEL;
    const modelDef = AVAILABLE_MODELS.find((model) => model.id === requestedModelId);
    if (!modelDef) {
      res.status(400).json({ error: `未対応のモデルです: ${requestedModelId}` });
      return;
    }
    const modelId = modelDef.id;
    const reasoningLevel = parseReasoningLevel(req.query.reasoning);
    const auditModelQuery = typeof req.query.auditModel === "string" ? req.query.auditModel : "";
    const auditModelId =
      auditModelQuery && auditModelQuery !== modelId && AVAILABLE_MODELS.some((m) => m.id === auditModelQuery)
        ? auditModelQuery
        : undefined;
    const auditReasoningLevel = parseReasoningLevel(req.query.auditReasoning);
    const translationMode = parseTranslationMode(req.query.translate);

    const supportsVision = VISION_MODEL_IDS.has(modelId);
    // Non-vision models are still usable with image attachments: a
    // vision-capable model transcribes the images to text first. Reject only
    // when no vision bridge can be constructed at all.
    const useVisionBridge = newMessage.hasImages && !supportsVision && isVisionBridgeAvailable();
    if (newMessage.hasImages && !supportsVision && !useVisionBridge) {
      res.status(400).json({
        error: `選択中のモデル（${modelDef.label}）は画像入力に対応していません。画像を送る場合は対応モデルに切り替えてください。`,
      });
      return;
    }

    const audioAttachmentsForTools = newMessage.binaries
      .filter((attachment) => attachment.family === "audio")
      .map((attachment) => ({
        name: attachment.name,
        buffer: attachment.buffer,
        mime: attachment.mime,
      }));

    try {
      newMessage = await resolveMessageBinaries(newMessage, res);
    } catch (err) {
      logger.warn({ err }, "Attachment extraction failed");
      const message = extractionPublicError(err);
      if (!res.headersSent) {
        res.status(400).json({ error: message });
      } else if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
        res.end();
      }
      return;
    }

    const historicalImageBudget = createHistoricalImageBudget();
    const historicalChatMessages: { role: "user" | "assistant"; content: unknown }[] = [];
    for (const hist of [...(parsed.data.history ?? [])].reverse()) {
      if (hist.role === "user") {
        try {
          const parsedHistory = await resolveMessageBinaries(
            parseUserMessageContent(
              hist.content,
              hist.attachments as IncomingAttachment[] | undefined,
            ),
            res,
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
          logger.warn(
            { err: error },
            "Private-session history attachment could not be reconstructed; omitting its payload",
          );
          historicalChatMessages.push({
            role: "user",
            content: fallbackHistoricalUserContent(hist.content),
          });
        }
      } else {
        historicalChatMessages.push({ role: "assistant", content: hist.content });
      }
    }
    historicalChatMessages.reverse();
    const chatMessages = [...historicalChatMessages];
    chatMessages.push({
      role: "user",
      content: useVisionBridge
        ? newMessage.modelText
        : modelContentFor(newMessage, supportsVision),
    });

    const { client, provider } = getClientForModel(modelId);
    await streamChatReply({
      req,
      res,
      client,
      provider,
      modelId,
      reasoningLevel,
      auditReasoningLevel,
      userText: newMessage.question,
      chatMessages: chatMessages as Parameters<typeof streamChatReply>[0]["chatMessages"],
      auditModelId,
      attachmentsForAudit: {
        textFiles: newMessage.attachments
          .filter((attachment) => attachment.kind === "file")
          .map((attachment) => ({ name: attachment.name, content: attachment.content })),
        imageDataUrls: newMessage.images.map((image) => image.content),
      },
      visionBridgeImages: useVisionBridge
        ? newMessage.images.map((image) => image.content)
        : undefined,
      imageAttachmentsForTools: newMessage.images,
      audioAttachmentsForTools,
      translationMode,
      includeArtifactContent: true,
      publicAiError,
    });
  } catch (err) {
    logger.error({ err }, "Failed to send ephemeral message");
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to send message" });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

// Download a generated asset. Only the owner of the parent conversation can access it.
router.get("/openai/assets/:assetId", requireAuth, async (req, res): Promise<void> => {
  const userId = getUserId(req);
  const rawId = Array.isArray(req.params.assetId) ? req.params.assetId[0] : req.params.assetId;
  const assetId = parsePositiveInt(rawId);
  if (assetId === undefined) {
    res.status(400).json({ error: "Invalid asset id" });
    return;
  }

  try {
    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId));
    if (!asset) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const [conv] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, asset.conversationId), eq(conversations.userId, userId)));
    if (!conv) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
    if (!base64Pattern.test(asset.data)) {
      logger.error({ assetId }, "Asset data is not valid base64");
      res.status(500).json({ error: "ファイルデータが破損しています" });
      return;
    }
    const buffer = Buffer.from(asset.data, "base64");
    if (buffer.length !== asset.size) {
      logger.warn(
        { assetId, expectedSize: asset.size, actualSize: buffer.length },
        "Asset size mismatch; using decoded buffer length",
      );
    }
    res.setHeader("Content-Type", asset.mimeType);
    res.setHeader(
      "Content-Disposition",
      asset.mimeType.startsWith("audio/") || asset.mimeType.startsWith("image/")
        ? "inline"
        : `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
    );
    res.setHeader("Content-Length", String(buffer.length));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(buffer);
  } catch (err) {
    logger.error({ err, assetId }, "Failed to download asset");
    res.status(500).json({ error: "ファイルの取得に失敗しました" });
  }
});

export default router;
