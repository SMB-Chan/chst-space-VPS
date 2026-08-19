import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { conversations, messages, artifacts, assets } from "@workspace/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
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
import { streamChatReply } from "../../lib/chat-stream";
import { logger } from "../../lib/logger";
import type { FileFormat } from "../../lib/file-generation";
import { normalizeConversationTitle } from "../../lib/conversation-title";
import {
  UserMessageContentError,
  fallbackHistoricalUserContent,
  modelContentFor,
  parseUserMessageContent,
  type IncomingAttachment,
  type ParsedUserMessageContent,
} from "../../lib/message-content";

const router = Router();

const MAX_ARTIFACTS_PER_MESSAGE = 3;
const MAX_USER_ARTIFACT_BYTES = 50 * 1024 * 1024;

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

  return messageRows.map((message) => ({
    ...message,
    sources: parseStoredSources(message.sources),
    assetIds: parseStoredAssetIds(message.assetIds),
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

router.use("/openai/artifacts", requireAuth);

router.get("/openai/models", (_req, res) => {
  res.json(AVAILABLE_MODELS);
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

    const requestedFileFormat = parsed.data.fileFormat as FileFormat | undefined;

    const supportsVision = VISION_MODEL_IDS.has(modelId);
    if (newMessage.hasImages && !supportsVision) {
      res.status(400).json({
        error: `選択中のモデル（${modelDef.label}）は画像入力に対応していません。画像を送る場合は対応モデルに切り替えてください。`,
      });
      return;
    }

    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    const chatMessages: { role: "user" | "assistant"; content: unknown }[] = [];
    for (const msg of history) {
      if (msg.role === "user") {
        try {
          const parsedHistory = parseUserMessageContent(msg.content);
          chatMessages.push({
            role: "user",
            content: modelContentFor(parsedHistory, supportsVision),
          });
        } catch (error) {
          logger.warn(
            { err: error, messageId: msg.id, conversationId },
            "Historical attachment could not be reconstructed; omitting its payload",
          );
          chatMessages.push({ role: "user", content: fallbackHistoricalUserContent(msg.content) });
        }
      } else {
        chatMessages.push({ role: "assistant", content: msg.content });
      }
    }
    chatMessages.push({ role: "user", content: modelContentFor(newMessage, supportsVision) });

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
      conversationId,
      requestedFileFormat,
      publicAiError,
      onComplete: async ({ content, sources, audit, artifacts: extractedArtifacts, assetIds }) => {
        const messageInserts: (typeof messages.$inferInsert)[] = [
          { conversationId, role: "user", content: newMessage.storedContent },
          {
            conversationId,
            role: "assistant",
            content,
            modelId,
            sources: sources.length > 0 ? JSON.stringify(sources) : undefined,
            auditContent: audit?.content,
            auditModelId: audit?.modelId,
            assetIds: assetIds && assetIds.length > 0 ? JSON.stringify(assetIds) : undefined,
          },
        ];
        const inserted = await db.insert(messages).values(messageInserts).returning();
        const assistantMessage = inserted.find((m) => m.role === "assistant");
        if (assistantMessage && assetIds && assetIds.length > 0) {
          await db
            .update(assets)
            .set({ messageId: assistantMessage.id })
            .where(inArray(assets.id, assetIds));
        }
        if (!extractedArtifacts?.length || !assistantMessage) return;

        const existing = await db
          .select({ size: artifacts.size })
          .from(artifacts)
          .where(eq(artifacts.userId, userId));
        let usedBytes = existing.reduce((sum, row) => sum + row.size, 0);
        const savedArtifacts: { id: number; filename: string; mime: string; size: number }[] = [];
        for (const artifact of extractedArtifacts.slice(0, MAX_ARTIFACTS_PER_MESSAGE)) {
          if (usedBytes + artifact.size > MAX_USER_ARTIFACT_BYTES) {
            logger.warn({ userId, usedBytes, size: artifact.size }, "Skipping artifact beyond user quota");
            continue;
          }
          const [row] = await db
            .insert(artifacts)
            .values({
              conversationId,
              messageId: assistantMessage.id,
              userId,
              filename: artifact.filename,
              mime: artifact.mime,
              size: artifact.size,
              content: artifact.content,
            })
            .returning({
              id: artifacts.id,
              filename: artifacts.filename,
              mime: artifacts.mime,
              size: artifacts.size,
            });
          if (row) {
            savedArtifacts.push(row);
            usedBytes += row.size;
          }
        }
        return { artifacts: savedArtifacts };
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
    const owned = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(inArray(messages.id, requestedIds), eq(conversations.userId, userId)));
    const ownedIds = owned.map((m) => m.id);
    if (ownedIds.length === 0) {
      res.status(404).json({ error: "Messages not found" });
      return;
    }
    await db.delete(messages).where(inArray(messages.id, ownedIds));
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

    const supportsVision = VISION_MODEL_IDS.has(modelId);
    if (newMessage.hasImages && !supportsVision) {
      res.status(400).json({
        error: `選択中のモデル（${modelDef.label}）は画像入力に対応していません。画像を送る場合は対応モデルに切り替えてください。`,
      });
      return;
    }

    const chatMessages: { role: "user" | "assistant"; content: unknown }[] = [];
    for (const hist of parsed.data.history ?? []) {
      if (hist.role === "user") {
        try {
          const parsedHistory = parseUserMessageContent(
            hist.content,
            hist.attachments as IncomingAttachment[] | undefined,
          );
          chatMessages.push({
            role: "user",
            content: modelContentFor(parsedHistory, supportsVision),
          });
        } catch (error) {
          logger.warn(
            { err: error },
            "Private-session history attachment could not be reconstructed; omitting its payload",
          );
          chatMessages.push({ role: "user", content: fallbackHistoricalUserContent(hist.content) });
        }
      } else {
        chatMessages.push({ role: "assistant", content: hist.content });
      }
    }
    chatMessages.push({ role: "user", content: modelContentFor(newMessage, supportsVision) });

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
      `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
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
