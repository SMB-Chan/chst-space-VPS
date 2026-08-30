import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureAssetsSchema,
  ensureMessageSchema,
} from "./ensure-schema";

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

const testUsers = new Set<string>();
let pool: (typeof import("@workspace/db"))["pool"];
let persistChatCompletion: typeof import("./completion-persistence")["persistChatCompletion"];
let deleteOwnedMessagesAndAssets: typeof import("./completion-persistence")["deleteOwnedMessagesAndAssets"];

function userId(label: string): string {
  const id = `completion-persistence-test:${label}:${randomUUID()}`;
  testUsers.add(id);
  return id;
}

async function createConversation(user: string, label: string): Promise<number> {
  const result = await pool.query<{ id: number }>(
    "INSERT INTO conversations (title, user_id) VALUES ($1, $2) RETURNING id",
    [`Integration ${label}`, user],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Failed to create integration-test conversation");
  return id;
}

function generatedFile(filename: string, bytes: number) {
  const buffer = Buffer.alloc(bytes, 7);
  return {
    buffer,
    filename,
    mimeType: "application/pdf",
    size: buffer.length,
    format: "pdf" as const,
  };
}

function textArtifact(filename: string, bytes: number) {
  const content = "x".repeat(bytes);
  return {
    filename,
    mime: "text/plain; charset=utf-8",
    content,
    size: Buffer.byteLength(content, "utf8"),
  };
}

async function tableCount(table: "messages" | "assets" | "artifacts", conversationId: number) {
  const result = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM ${table} WHERE conversation_id = $1`,
    [conversationId],
  );
  return result.rows[0]?.count ?? 0;
}

describePostgres("completion persistence PostgreSQL invariants", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    await ensureMessageSchema((sql) => pool.query(sql));
    await ensureAssetsSchema((sql) => pool.query(sql));
    ({ persistChatCompletion, deleteOwnedMessagesAndAssets } = await import(
      "./completion-persistence"
    ));
  });

  afterAll(async () => {
    if (!pool || testUsers.size === 0) return;
    await pool.query("DELETE FROM conversations WHERE user_id = ANY($1::text[])", [
      [...testUsers],
    ]);
  });

  it("serializes concurrent quota decisions for one user across conversations", async () => {
    const user = userId("quota-race");
    const firstConversation = await createConversation(user, "quota-a");
    const secondConversation = await createConversation(user, "quota-b");

    const persist = (conversationId: number, filename: string) =>
      persistChatCompletion(
        {
          userId: user,
          conversationId,
          userContent: `request ${filename}`,
          assistantContent: `response ${filename}`,
          modelId: "integration-model",
          sources: [],
          generatedFiles: [generatedFile(filename, 8)],
        },
        { quotaBytes: 8 },
      );

    const [first, second] = await Promise.all([
      persist(firstConversation, "first.pdf"),
      persist(secondConversation, "second.pdf"),
    ]);

    expect(first.assets.length + second.assets.length).toBe(1);
    expect([first.quotaExceeded, second.quotaExceeded].filter(Boolean)).toHaveLength(1);

    const assetRows = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
         FROM assets
         JOIN conversations ON conversations.id = assets.conversation_id
        WHERE conversations.user_id = $1`,
      [user],
    );
    expect(assetRows.rows[0]?.count).toBe(1);
    expect(await tableCount("messages", firstConversation)).toBe(2);
    expect(await tableCount("messages", secondConversation)).toBe(2);
  });

  it("rolls back messages and an accepted binary when a later artifact insert fails", async () => {
    const user = userId("rollback");
    const conversationId = await createConversation(user, "rollback");
    const malformedArtifact = {
      filename: "broken.txt",
      mime: undefined as unknown as string,
      content: "x",
      size: 1,
    };

    await expect(
      persistChatCompletion(
        {
          userId: user,
          conversationId,
          userContent: "rollback request",
          assistantContent: "rollback response",
          modelId: "integration-model",
          sources: [],
          generatedFiles: [generatedFile("rollback.pdf", 4)],
          extractedArtifacts: [malformedArtifact],
        },
        { quotaBytes: 0 },
      ),
    ).rejects.toThrow();

    expect(await tableCount("messages", conversationId)).toBe(0);
    expect(await tableCount("assets", conversationId)).toBe(0);
    expect(await tableCount("artifacts", conversationId)).toBe(0);
  });

  it("enforces ownership during message deletion and removes owned downloads", async () => {
    const owner = userId("owner");
    const otherUser = userId("other");
    const conversationId = await createConversation(owner, "owner-delete");

    await persistChatCompletion(
      {
        userId: owner,
        conversationId,
        userContent: "owner request",
        assistantContent: "owner response",
        modelId: "integration-model",
        sources: [],
        generatedFiles: [generatedFile("owned.pdf", 4)],
        extractedArtifacts: [textArtifact("owned.txt", 4)],
      },
      { quotaBytes: 20 },
    );

    const assistant = await pool.query<{ id: number }>(
      `SELECT id FROM messages
        WHERE conversation_id = $1 AND role = 'assistant'
        ORDER BY id DESC LIMIT 1`,
      [conversationId],
    );
    const assistantId = assistant.rows[0]?.id;
    if (!assistantId) throw new Error("Assistant message was not persisted");

    expect(await deleteOwnedMessagesAndAssets(otherUser, [assistantId])).toEqual([]);
    expect(await tableCount("assets", conversationId)).toBe(1);
    expect(await tableCount("artifacts", conversationId)).toBe(1);

    expect(await deleteOwnedMessagesAndAssets(owner, [assistantId])).toEqual([assistantId]);
    expect(await tableCount("assets", conversationId)).toBe(0);
    expect(await tableCount("artifacts", conversationId)).toBe(0);
    const remainingAssistant = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM messages
        WHERE conversation_id = $1 AND id = $2`,
      [conversationId, assistantId],
    );
    expect(remainingAssistant.rows[0]?.count).toBe(0);
  });

  it("prioritizes the requested binary and preserves artifact sourceIndex under quota", async () => {
    const user = userId("mixed-quota");
    const conversationId = await createConversation(user, "mixed-quota");

    const result = await persistChatCompletion(
      {
        userId: user,
        conversationId,
        userContent: "mixed quota request",
        assistantContent: "mixed quota response",
        modelId: "integration-model",
        sources: [],
        generatedFiles: [generatedFile("priority.pdf", 6)],
        extractedArtifacts: [
          textArtifact("first.txt", 4),
          textArtifact("second.txt", 4),
        ],
      },
      { quotaBytes: 10 },
    );

    expect(result.assets).toHaveLength(1);
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.sourceIndex).toBe(0);
    expect(result.artifacts[0]?.filename).toBe("first.txt");
    expect(result.quotaExceeded).toBe(true);
    expect(await tableCount("assets", conversationId)).toBe(1);
    expect(await tableCount("artifacts", conversationId)).toBe(1);
  });

  it("persists generated audio with metadata for authenticated playback", async () => {
    const user = userId("audio");
    const conversationId = await createConversation(user, "audio");
    const buffer = Buffer.from("ID3-audio");

    const result = await persistChatCompletion(
      {
        userId: user,
        conversationId,
        userContent: "read this aloud",
        assistantContent: "音声を生成しました。",
        modelId: "qwen3.8-flash",
        sources: [],
        generatedAssets: [
          {
            buffer,
            filename: "alibaba-qwen-audio.mp3",
            mimeType: "audio/mpeg",
            size: buffer.length,
            capability: "audio-synthesis",
          },
        ],
      },
      { quotaBytes: 100 },
    );

    expect(result.assets).toEqual([
      {
        id: expect.any(Number),
        filename: "alibaba-qwen-audio.mp3",
        mimeType: "audio/mpeg",
        size: buffer.length,
      },
    ]);
    const row = await pool.query<{ mime_type: string; size: number }>(
      "SELECT mime_type, size FROM assets WHERE conversation_id = $1",
      [conversationId],
    );
    expect(row.rows).toEqual([{ mime_type: "audio/mpeg", size: buffer.length }]);
  });
});
