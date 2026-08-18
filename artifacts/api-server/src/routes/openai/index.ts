import { Router, type IRouter } from "express";
import type OpenAI from "openai";
import { db, conversations, messages } from "@workspace/db";
import {
  getClientForModel,
  AVAILABLE_MODELS,
  modelSupportsVision,
  getModelLabel,
  parseReasoningLevel,
} from "../../lib/ai-clients";
import {
  CreateOpenaiConversationBody,
  GetOpenaiConversationParams,
  DeleteOpenaiConversationParams,
  ListOpenaiMessagesParams,
  SendOpenaiMessageParams,
  SendOpenaiMessageBody,
} from "@workspace/api-zod";
import { logger } from "../../lib/logger";
import { streamChatReply, type ChatContentPart } from "../../lib/chat-stream";
import { normalizeConversationTitle } from "../../lib/conversation-title";
import { publicAiError } from "../../lib/public-error";
import { and, desc, eq } from "drizzle-orm";
import { requireAuth } from "../../middlewares/requireAuth";

function parseStoredSources(raw: string | null): unknown {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    logger.warn({ raw }, "Ignoring malformed message sources JSON");
    return null;
  }
}

const router: IRouter = Router();

// Matches user messages created by the frontend when an image is attached:
// "[Image: name]\n\n<data URL>\n\n---\n\nUser question: <question>"
const IMAGE_MESSAGE_RE =
  /^\[Image:\s([^\]]+)\]\n\n(data:image\/[a-zA-Z+.-]+;base64,[A-Za-z0-9+/=\s]+?)\n\n---\n\nUser question:\s([\s\S]*)$/;

interface ParsedUserContent {
  text: string;
  imageName?: string;
  imageDataUrl?: string;
}

function parseUserContent(content: string): ParsedUserContent {
  const m = content.match(IMAGE_MESSAGE_RE);
  if (!m) return { text: content };
  return { imageName: m[1], imageDataUrl: m[2].trim(), text: m[3] };
}

// Convert a stored user message into the payload sent to the model.
// Vision-capable models get structured content (text + image parts);
// non-vision models get the question text with a placeholder so history
// containing images does not break them.
function toModelContent(
  content: string,
  visionCapable: boolean
): string | ChatContentPart[] {
  const parsed = parseUserContent(content);
  if (!parsed.imageDataUrl) return content;
  if (!visionCapable) {
    return `[添付画像: ${parsed.imageName}（このモデルでは画像は読み取れません）]\n\n${parsed.text}`;
  }
  return [
    { type: "text", text: parsed.text },
    { type: "image_url", image_url: { url: parsed.imageDataUrl } },
  ];
}

// List available models (no auth required — static metadata)
router.get("/openai/models", async (_req, res): Promise<void> => {
  res.json(AVAILABLE_MODELS);
});

// All conversation/message routes require a signed-in user
router.use("/openai/conversations", requireAuth);
router.use("/openai/ephemeral", requireAuth);

// Wipe every conversation owned by the current user
router.delete("/openai/conversations", async (req, res): Promise<void> => {
  await db.delete(conversations).where(eq(conversations.userId, req.userId!));
  res.sendStatus(204);
});

// List all conversations owned by the current user
router.get("/openai/conversations", async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(conversations)
    .where(eq(conversations.userId, req.userId!))
    .orderBy(desc(conversations.createdAt));
  res.json(rows);
});

// Create a conversation
router.post("/openai/conversations", async (req, res): Promise<void> => {
  const parsed = CreateOpenaiConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const title = normalizeConversationTitle(parsed.data.title);
  if (!title) {
    res.status(400).json({ error: "タイトルを入力してください。" });
    return;
  }
  const [conv] = await db
    .insert(conversations)
    .values({ title, userId: req.userId! })
    .returning();
  res.status(201).json(conv);
});

// Get conversation with messages
router.get("/openai/conversations/:id", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = GetOpenaiConversationParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.userId!)));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.data.id))
    .orderBy(messages.createdAt);
  const parsedMsgs = msgs.map((m) => ({
    ...m,
    sources: parseStoredSources(m.sources),
  }));
  res.json({ ...conv, messages: parsedMsgs });
});

// Rename conversation
router.patch("/openai/conversations/:id", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteOpenaiConversationParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const rawTitle = typeof req.body?.title === "string" ? req.body.title : "";
  const title = normalizeConversationTitle(rawTitle);
  if (!title) {
    res.status(400).json({ error: "タイトルを入力してください。" });
    return;
  }
  const [updated] = await db
    .update(conversations)
    .set({ title })
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.userId!)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json(updated);
});

// Delete conversation
router.delete("/openai/conversations/:id", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = DeleteOpenaiConversationParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [deleted] = await db
    .delete(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.userId!)))
    .returning();
  if (!deleted) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.sendStatus(204);
});

// List messages in a conversation
router.get("/openai/conversations/:id/messages", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = ListOpenaiMessagesParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const [owned] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, params.data.id), eq(conversations.userId, req.userId!)));
  if (!owned) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, params.data.id))
    .orderBy(messages.createdAt);
  const parsedMsgs = msgs.map((m) => ({
    ...m,
    sources: parseStoredSources(m.sources),
  }));
  res.json(parsedMsgs);
});

// Send message — streaming SSE response
// Accepts optional ?model= query param to select the AI model
router.post("/openai/conversations/:id/messages", async (req, res): Promise<void> => {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const params = SendOpenaiMessageParams.safeParse({ id: rawId });
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SendOpenaiMessageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const conversationId = params.data.id;
  const userContent = body.data.content;
  const MAX_CONTENT_CHARS = 20 * 1024 * 1024;
  if (userContent.length > MAX_CONTENT_CHARS) {
    res.status(413).json({ error: "メッセージが大きすぎます。15MB以下の画像を添付してください。" });
    return;
  }
  const modelId = typeof req.query.model === "string" ? req.query.model : "gpt-5.6-terra";
  const reasoningLevel = parseReasoningLevel(req.query.reasoning);
  const auditReasoningLevel = parseReasoningLevel(req.query.auditReasoning);
  const auditModelId =
    typeof req.query.auditModel === "string" && req.query.auditModel !== modelId
      ? req.query.auditModel
      : undefined;

  // Resolve client for the requested model
  let aiClient: ReturnType<typeof getClientForModel>;
  try {
    aiClient = getClientForModel(modelId);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  // Reject image attachments up front when the selected model cannot see them
  const visionCapable = modelSupportsVision(modelId);
  const parsedNewMessage = parseUserContent(userContent);
  if (parsedNewMessage.imageDataUrl && !visionCapable) {
    res.status(400).json({
      error: `${getModelLabel(modelId)} は画像を読み取れません。画像を送る場合は GPT-5.6 Terra / Luna、o4-mini、または Qwen のモデルを選択してください。`,
    });
    return;
  }

  // Ensure conversation exists and belongs to the current user
  const [conv] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, req.userId!)));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  try {
    await db.insert(messages).values({
      conversationId,
      role: "user",
      content: userContent,
    });
  } catch (err) {
    logger.error({ err, conversationId }, "Failed to save user message");
    res.status(500).json({ error: publicAiError(err) });
    return;
  }

  // Load full history for context
  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);

  // User messages may contain an attached image (as a data URL). For
  // vision-capable models, convert those to structured multimodal content;
  // assistant/system messages stay plain strings.
  const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
    history.map((m) =>
      m.role === "user"
        ? { role: "user" as const, content: toModelContent(m.content, visionCapable) }
        : {
            role: m.role as "assistant" | "system",
            content: m.content,
          }
    );

  await streamChatReply({
    req,
    res,
    client: aiClient.client,
    provider: aiClient.provider,
    modelId,
    reasoningLevel,
    auditReasoningLevel,
    userText: parsedNewMessage.text,
    chatMessages,
    auditModelId,
    publicAiError,
    onComplete: async ({ content, sources, audit }) => {
      await db.insert(messages).values({
        conversationId,
        role: "assistant",
        content,
        modelId,
        sources: sources.length > 0 ? JSON.stringify(sources) : null,
        auditContent: audit?.content ?? null,
        auditModelId: audit?.modelId ?? null,
      });
    },
  });
});

const MAX_CONTENT_CHARS = 20 * 1024 * 1024;
const MAX_EPHEMERAL_HISTORY = 40;

// Private session: stream a reply without writing to the database.
router.post("/openai/ephemeral/messages", async (req, res): Promise<void> => {
  const body = SendOpenaiMessageBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const userContent = body.data.content;
  if (userContent.length > MAX_CONTENT_CHARS) {
    res.status(413).json({ error: "メッセージが大きすぎます。15MB以下の画像を添付してください。" });
    return;
  }

  const modelId = typeof req.query.model === "string" ? req.query.model : "gpt-5.6-terra";
  const reasoningLevel = parseReasoningLevel(req.query.reasoning);
  const auditReasoningLevel = parseReasoningLevel(req.query.auditReasoning);
  const auditModelId =
    typeof req.query.auditModel === "string" && req.query.auditModel !== modelId
      ? req.query.auditModel
      : undefined;

  let aiClient: ReturnType<typeof getClientForModel>;
  try {
    aiClient = getClientForModel(modelId);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }

  const visionCapable = modelSupportsVision(modelId);
  const parsedNewMessage = parseUserContent(userContent);
  if (parsedNewMessage.imageDataUrl && !visionCapable) {
    res.status(400).json({
      error: `${getModelLabel(modelId)} は画像を読み取れません。画像を送る場合は GPT-5.6 Terra / Luna、o4-mini、または Qwen のモデルを選択してください。`,
    });
    return;
  }

  const rawHistory = Array.isArray((req.body as { history?: unknown }).history)
    ? ((req.body as { history: unknown[] }).history)
    : [];
  const prior = rawHistory
    .slice(-MAX_EPHEMERAL_HISTORY)
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const rec = item as { role?: unknown; content?: unknown };
      if ((rec.role !== "user" && rec.role !== "assistant") || typeof rec.content !== "string") {
        return [];
      }
      return [{ role: rec.role, content: rec.content }];
    });

  const chatMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    ...prior.map((m) =>
      m.role === "user"
        ? { role: "user" as const, content: toModelContent(m.content, visionCapable) }
        : { role: "assistant" as const, content: m.content },
    ),
    { role: "user", content: toModelContent(userContent, visionCapable) },
  ];

  await streamChatReply({
    req,
    res,
    client: aiClient.client,
    provider: aiClient.provider,
    modelId,
    reasoningLevel,
    auditReasoningLevel,
    userText: parsedNewMessage.text,
    chatMessages,
    auditModelId,
    publicAiError,
  });
});

export default router;
