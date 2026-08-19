import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { conversations, messages, artifacts, assets } from "@workspace/db/schema";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, getUserId } from "../middleware";
import {
  AVAILABLE_MODELS,
  DEFAULT_MODEL,
  VISION_MODEL_IDS,
  parseReasoningLevel,
  getClientForModel,
} from "../../lib/ai-clients";
import { ensureChatSchema } from "../../lib/ensure-schema";
import { streamChatReply } from "../../lib/chat-stream";
import { logger } from "../../lib/logger";
import type { FileFormat } from "../../lib/file-generation";

const router = Router();

const IMAGE_DATA_URL_REGEX = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB base64-decoded limit
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

function parseStoredAssetIds(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is number => typeof id === "number");
  } catch {
    logger.warn({ raw }, "Ignoring malformed message assetIds JSON");
    return null;
  }
}

function extractImageDataUrl(content: string): { text: string; imageUrl?: string } {
  const match = content.match(IMAGE_DATA_URL_REGEX);
  if (!match) return { text: content };
  const text = content.replace(IMAGE_DATA_URL_REGEX, "").trim();
  return { text, imageUrl: match[0] };
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^a-zA-Z0-9._-]+/g, "_") || "artifact.txt";
  const encoded = encodeURIComponent(filename).replace(/'/g, "%27");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

router.use("/openai/artifacts", requireAuth);

router.get("/openai/models", (_req, res) => {
  res.json(AVAILABLE_MODELS);
});

router.get("/openai/artifacts/:artifactId", async (req: Request, res: Response) => {
  const userId = getUserId(req);
  const artifactId = Number.parseInt(String(req.params.artifactId ?? ""), 10);
  if (!Number.isFinite(artifactId)) {
    res.status(400).json({ error: "Invalid artifact id" });
    return;
  }
  try {
    await ensureChatSchema();
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
    res.send(artifact.content);
  } catch (err) {
    logger.error({ err, artifactId }, "Failed to download artifact");
    res.status(500).json({ error: "ファイルの取得に失敗しました" });
  }
});

router.get("/openai/conversations", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    await ensureChatSchema();
    const result = await db
      .select()
      .from(conversations)
      .where(eq(conversations.userId, userId))
      .orderBy(conversations.createdAt);
    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to list conversations");
    res.status(500).json({ error: "Failed to list conversations" }
    );
  }
});

router.get("/openai/conversations/:conversationId", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const conversationId = parseInt(String(req.params.conversationId ?? ""), 10);
    if (isNaN(conversationId)) {
      res.status(400).json({ error: "Invalid conversation ID" });
      return;
    }
    await ensureChatSchema();
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .limit(1);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    const messagesResult = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversation.id))
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
      .where(and(eq(artifacts.conversationId, conversation.id), eq(artifacts.userId, userId)))
      .orderBy(asc(artifacts.id));
    res.json({
      ...conversation,
      messages: messagesResult.map((message) => ({
        ...message,
        assetIds: parseStoredAssetIds(message.assetIds),
        artifacts: artifactRows
          .filter((artifact) => artifact.messageId === message.id)
          .map(({ messageId: _messageId, ...artifact }) => ({
            ...artifact,
            downloadUrl: `/api/openai/artifacts/${artifact.id}`,
          })),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get conversation");
    res.status(500).json({ error: "Failed to get conversation" });
  }
});

const createConversationBody = z.object({ title: z.string().min(1).max(200) });

router.post("/openai/conversations", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const parsed = createConversationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    await ensureChatSchema();
    const [conversation] = await db
      .insert(conversations)
      .values({ userId, title: parsed.data.title })
      .returning();
    res.json(conversation);
  } catch (err) {
    req.log.error({ err }, "Failed to create conversation");
    res.status(500).json({ error: "Failed to create conversation" });
  }
});

router.delete("/openai/conversations/:conversationId", requireAuth, async (req, res) => {
  try {
    const userId = getUserId(req);
    const conversationId = parseInt(String(req.params.conversationId ?? ""), 10);
    if (isNaN(conversationId)) {
      res.status(400).json({ error: "Invalid conversation ID" });
      return;
    }
    await ensureChatSchema();
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

const sendMessageBody = z.object({
  content: z.string().min(1).max(100_000),
  modelId: z.string().optional(),
});

const REQUESTED_FILE_FORMATS = ["pdf", "docx", "xlsx", "pptx"] as const;

router.post("/openai/conversations/:conversationId/messages", requireAuth, async (req, res) => {
  const userId = getUserId(req);
  const conversationId = parseInt(String(req.params.conversationId ?? ""), 10);
  if (isNaN(conversationId)) {
    res.status(400).json({ error: "Invalid conversation ID" });
    return;
  }

  const parsed = sendMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  try {
    await ensureChatSchema();
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
      .limit(1);
    if (!conversation) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }

    const { text: newMessageText, imageUrl: newImageUrl } = extractImageDataUrl(parsed.data.content);
    const modelId = parsed.data.modelId || DEFAULT_MODEL;
    const reasoningLevel = parseReasoningLevel(req.query.reasoning);
    const auditModelQuery = typeof req.query.auditModel === "string" ? req.query.auditModel : "";
    const auditModelId =
      auditModelQuery && auditModelQuery !== modelId && AVAILABLE_MODELS.some((m) => m.id === auditModelQuery)
        ? auditModelQuery
        : undefined;
    const auditReasoningLevel = parseReasoningLevel(req.query.auditReasoning);

    const requestedFileFormat =
      typeof req.body?.fileFormat === "string" &&
      (REQUESTED_FILE_FORMATS as readonly string[]).includes(req.body.fileFormat)
        ? (req.body.fileFormat as FileFormat)
        : undefined;

    const modelDef = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (newImageUrl && modelDef && !VISION_MODEL_IDS.has(modelDef.id)) {
      res.status(400).json({
        error: `選択中のモデル（${modelDef.label}）は画像入力に対応していません。画像を送る場合は対応モデルに切り替えてください。`,
      });
      return;
    }

    if (newImageUrl) {
      const approxBytes = Math.floor(newImageUrl.length * 0.75);
      if (approxBytes > MAX_IMAGE_BYTES) {
        res.status(413).json({ error: "画像が大きすぎます。10MB以下にしてください。" });
        return;
      }
    }

    const history = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.createdAt), asc(messages.id));

    const chatMessages: { role: "user" | "assistant"; content: unknown }[] = [];
    for (const msg of history) {
      const { text: msgText, imageUrl: msgImageUrl } = extractImageDataUrl(msg.content);
      if (msgImageUrl && msg.role === "user") {
        chatMessages.push({
          role: "user",
          content: [
            { type: "text", text: msgText || "（画像）" },
            { type: "image_url", image_url: { url: msgImageUrl } },
          ],
        });
      } else {
        chatMessages.push({ role: msg.role as "user" | "assistant", content: msgText });
      }
    }
    if (newImageUrl) {
      chatMessages.push({
        role: "user",
        content: [
          { type: "text", text: newMessageText || "この画像について説明してください。" },
          { type: "image_url", image_url: { url: newImageUrl } },
        ],
      });
    } else {
      chatMessages.push({ role: "user", content: newMessageText });
    }

    const { client, provider } = getClientForModel(modelId);

    await streamChatReply({
      req,
      res,
      client,
      provider,
      modelId,
      reasoningLevel,
      auditReasoningLevel,
      userText: newMessageText,
      chatMessages: chatMessages as Parameters<typeof streamChatReply>[0]["chatMessages"],
      auditModelId,
      conversationId,
      requestedFileFormat,
      publicAiError,
      onComplete: async ({ content, sources, audit, artifacts: extractedArtifacts, assetIds }) => {
        const messageInserts: (typeof messages.$inferInsert)[] = [
          { conversationId, role: "user", content: parsed.data.content },
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
    const parsed = z.object({ ids: z.array(z.number().int()).min(1).max(200) }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request body" });
      return;
    }
    await ensureChatSchema();
    const owned = await db
      .select({ id: messages.id })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(and(inArray(messages.id, parsed.data.ids), eq(conversations.userId, userId)));
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
    const { text: newMessageText, imageUrl: newImageUrl } = extractImageDataUrl(parsed.data.content);
    const modelId = parsed.data.modelId || DEFAULT_MODEL;
    const reasoningLevel = parseReasoningLevel(req.query.reasoning);
    const auditModelQuery = typeof req.query.auditModel === "string" ? req.query.auditModel : "";
    const auditModelId =
      auditModelQuery && auditModelQuery !== modelId && AVAILABLE_MODELS.some((m) => m.id === auditModelQuery)
        ? auditModelQuery
        : undefined;
    const auditReasoningLevel = parseReasoningLevel(req.query.auditReasoning);

    const modelDef = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (newImageUrl && modelDef && !VISION_MODEL_IDS.has(modelDef.id)) {
      res.status(400).json({
        error: `選択中のモデル（${modelDef.label}）は画像入力に対応していません。画像を送る場合は対応モデルに切り替えてください。`,
      });
      return;
    }

    if (newImageUrl) {
      const approxBytes = Math.floor(newImageUrl.length * 0.75);
      if (approxBytes > MAX_IMAGE_BYTES) {
        res.status(413).json({ error: "画像が大きすぎます。10MB以下にしてください。" });
        return;
      }
    }

    const chatMessages: { role: "user"; content: unknown }[] = [];
    if (newImageUrl) {
      chatMessages.push({
        role: "user",
        content: [
          { type: "text", text: newMessageText || "この画像について説明してください。" },
          { type: "image_url", image_url: { url: newImageUrl } },
        ],
      });
    } else {
      chatMessages.push({ role: "user", content: newMessageText });
    }

    const { client, provider } = getClientForModel(modelId);
    await streamChatReply({
      req,
      res,
      client,
      provider,
      modelId,
      reasoningLevel,
      auditReasoningLevel,
      userText: newMessageText,
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
  const assetId = Number.parseInt(rawId, 10);
  if (!Number.isFinite(assetId)) {
    res.status(400).json({ error: "Invalid asset id" });
    return;
  }

  try {
    await ensureChatSchema();
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

    const buffer = Buffer.from(asset.data, "base64");
    res.setHeader("Content-Type", asset.mimeType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(asset.filename)}`,
    );
    res.setHeader("Content-Length", String(buffer.length));
    res.end(buffer);
  } catch (err) {
    logger.error({ err, assetId }, "Failed to download asset");
    res.status(500).json({ error: "ファイルの取得に失敗しました" });
  }
});

export default router;
