import { z } from "zod";
import {
  storeMemory,
  recallMemories,
  updateMemory,
  forgetMemory,
  supersedeMemory,
  findRelevantMemories,
  runMemoryMaintenance,
  formatMemoriesForPrompt,
  type MemoryEntry,
  type StoreMemoryInput,
} from "./llm-memory-store";
import type {
  SpecialistToolCall,
  SpecialistToolContext,
  SpecialistToolDefinition,
  SpecialistToolResult,
} from "./specialist-capabilities";

const memoryStoreArgs = z.object({
  topic: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(4000),
  source_url: z.string().trim().max(2000).optional(),
  valid_as_of: z.string().trim().max(20).optional(),
  expires_at: z.string().trim().max(30).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
});

const memoryRecallArgs = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(20).optional(),
});

const memoryUpdateArgs = z.object({
  id: z.string().trim().min(1).max(50),
  topic: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(4000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  expires_at: z.string().trim().max(30).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
});

const memoryForgetArgs = z.object({
  id: z.string().trim().min(1).max(50),
});

const memorySupersedeArgs = z.object({
  old_id: z.string().trim().min(1).max(50),
  new_id: z.string().trim().min(1).max(50),
});

export function getMemoryToolDefinitions(): SpecialistToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "memory_store",
        description:
          "新しい知識をあなたの記憶に保存します。Web検索で得た重要な情報や、ユーザーから学んだ事実を保存してください。" +
          "トピックは短く具体的にし、内容は要約して書いてください。同じトピックの古い記憶がある場合はmemory_supersedeを使って置き換えてください。",
        parameters: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "記憶のトピック（短く具体的に）",
            },
            content: {
              type: "string",
              description: "記憶する内容（要約された事実）",
            },
            source_url: {
              type: "string",
              description: "情報の出典URL",
            },
            confidence: {
              type: "number",
              description: "この情報の信頼度（0.0-1.0）",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "分類タグ（最大10個）",
            },
          },
          required: ["topic", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_recall",
        description:
          "あなたの記憶からキーワードで情報を検索します。過去の会話で学んだ情報を思い出すために使ってください。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "検索キーワード",
            },
            limit: {
              type: "number",
              description: "最大取得件数（デフォルト10）",
            },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_update",
        description:
          "既存の記憶の内容を更新します。新しい情報で置き換える場合や、信頼度を変更する場合に使ってください。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "更新対象の記憶ID" },
            topic: { type: "string", description: "新しいトピック" },
            content: { type: "string", description: "新しい内容" },
            confidence: {
              type: "number",
              description: "新しい信頼度（0.0-1.0）",
            },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_forget",
        description:
          "不要になった記憶を削除します。誤った情報や古い情報で不要になったものに対して使ってください。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "削除対象の記憶ID" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_supersede",
        description:
          "古い記憶を新しい記憶で置き換えます。同じトピックについて新しい情報を得た場合、古い記憶をsupersedeしてから新しい情報をstoreしてください。",
        parameters: {
          type: "object",
          properties: {
            old_id: {
              type: "string",
              description: "置き換えられる古い記憶のID",
            },
            new_id: {
              type: "string",
              description: "新しい記憶のID",
            },
          },
          required: ["old_id", "new_id"],
          additionalProperties: false,
        },
      },
    },
  ];
}

function parseArgs<T>(schema: z.ZodType<T>, raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("メモリツールの引数JSONが不正です");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error("メモリツールの引数が不正です");
  return result.data;
}

function formatMemoryBrief(m: MemoryEntry): string {
  return `[${m.id}] ${m.topic} (信頼度: ${m.confidence.toFixed(1)}, 学習日: ${m.learned_at.slice(0, 10)})\n  ${m.content.slice(0, 200)}`;
}

export async function executeMemoryTool(
  call: SpecialistToolCall,
  context: Pick<SpecialistToolContext, "userId" | "memoryEnabled">,
): Promise<SpecialistToolResult> {
  try {
    if (!context.memoryEnabled || !context.userId) {
      throw new Error("このセッションでは長期メモリは無効です");
    }
    const userId = context.userId;
    if (call.name === "memory_store") {
      const args = parseArgs(memoryStoreArgs, call.arguments);
      const entry = await storeMemory(userId, args as StoreMemoryInput);
      return {
        ok: true,
        capability: "web-search",
        summary: `記憶を保存しました (ID: ${entry.id})`,
        text: `記憶ID: ${entry.id}\nトピック: ${entry.topic}\n内容: ${entry.content.slice(0, 200)}\n有効期限: ${entry.expires_at?.slice(0, 10) ?? "無期限"}`,
      };
    }

    if (call.name === "memory_recall") {
      const args = parseArgs(memoryRecallArgs, call.arguments);
      const memories = await recallMemories(userId, args.query, args.limit);
      if (memories.length === 0) {
        return {
          ok: true,
          capability: "web-search",
          summary: "該当する記憶が見つかりませんでした。",
          text: "",
        };
      }
      return {
        ok: true,
        capability: "web-search",
        summary: `${memories.length}件の記憶を思い出しました。`,
        text: memories.map(formatMemoryBrief).join("\n\n"),
      };
    }

    if (call.name === "memory_update") {
      const args = parseArgs(memoryUpdateArgs, call.arguments);
      const { id, ...updates } = args;
      const updated = await updateMemory(userId, id, updates);
      if (!updated) {
        return {
          ok: false,
          capability: "web-search",
          summary: `記憶ID ${id} が見つかりませんでした。`,
          text: "",
        };
      }
      return {
        ok: true,
        capability: "web-search",
        summary: `記憶を更新しました (ID: ${id})`,
        text: formatMemoryBrief(updated),
      };
    }

    if (call.name === "memory_forget") {
      const args = parseArgs(memoryForgetArgs, call.arguments);
      const success = await forgetMemory(userId, args.id);
      return {
        ok: success,
        capability: "web-search",
        summary: success
          ? `記憶を削除しました (ID: ${args.id})`
          : `記憶ID ${args.id} が見つかりませんでした。`,
        text: "",
      };
    }

    if (call.name === "memory_supersede") {
      const args = parseArgs(memorySupersedeArgs, call.arguments);
      const success = await supersedeMemory(userId, args.old_id, args.new_id);
      return {
        ok: success,
        capability: "web-search",
        summary: success
          ? `古い記憶 ${args.old_id} を新しい記憶 ${args.new_id} で置き換えました。`
          : `記憶ID ${args.old_id} が見つかりませんでした。`,
        text: "",
      };
    }

    throw new Error("不明なメモリツールです");
  } catch (error) {
    return {
      ok: false,
      capability: "web-search",
      summary:
        error instanceof Error
          ? error.message
          : "メモリツールの実行に失敗しました",
      text: "",
    };
  }
}

/** Memory tool names for identification in the research loop. */
export const MEMORY_TOOL_NAMES = new Set([
  "memory_store",
  "memory_recall",
  "memory_update",
  "memory_forget",
  "memory_supersede",
]);

export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name);
}

// Re-export for convenience
export { findRelevantMemories, formatMemoriesForPrompt, runMemoryMaintenance };
