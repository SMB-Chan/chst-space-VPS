import { z } from "zod";
import {
  storeMemory,
  recallMemories,
  updateMemory,
  forgetMemory,
  invalidateMemory,
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

import {
  memoryStoreSchema,
  memoryUpdateSchema,
  memoryIdSchema,
  memoryInvalidateSchema,
} from "./llm-memory-schema";

const memoryStoreArgs = memoryStoreSchema;

const memoryRecallArgs = z.object({
  query: z.string().trim().min(1).max(200),
  limit: z.number().int().min(1).max(20).optional(),
});

const memoryUpdateArgs = z
  .object({
    id: memoryIdSchema,
    expected_revision: z.number().int().positive(),
  })
  .passthrough()
  .transform(({ id, ...updates }) => ({
    id,
    ...memoryUpdateSchema.parse(updates),
  }));
const memoryInvalidateArgs = memoryInvalidateSchema.extend({
  id: memoryIdSchema,
  expected_revision: z.number().int().positive(),
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
          "kindで本人の発言・出典付き事実・推測・未確認を区別してください。推測と未確認は回答の自動参照対象になりません。sourced_factにはsource_urlとvalid_as_ofが必要です。内容は短く要約してください。",
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
            kind: {
              type: "string",
              enum: [
                "user_statement",
                "sourced_fact",
                "inference",
                "unverified",
              ],
              description:
                "情報の由来。ユーザーが明言した内容はuser_statement、出典付き事実はsourced_fact。自己判断で検証済みに昇格しない。",
            },
            category: {
              type: "string",
              enum: ["preference", "decision", "progress", "knowledge"],
            },
            source_url: {
              type: "string",
              description: "本文を確認したHTTP(S)出典URL",
            },
            source_ref: {
              type: "string",
              description: "会話や資料の参照ID（任意）",
            },
            valid_as_of: {
              type: "string",
              description: "情報の基準日 YYYY-MM-DD",
            },
            expires_at: {
              type: "string",
              description:
                "有効期限（タイムゾーン付きISO 8601日時）。時事情報は短く設定。",
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
          required: ["topic", "content", "kind", "category"],
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
          "既存の有効な記憶を訂正し、旧版を履歴に保存します。取得したrevisionをexpected_revisionへ渡してください。期限切れ・失効した記憶は更新できません。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "更新対象の記憶ID" },
            expected_revision: {
              type: "integer",
              description: "直前に取得したrevision（競合検知）",
            },
            reason: { type: "string", description: "訂正の理由" },
            tags: { type: "array", items: { type: "string" } },
            topic: { type: "string", description: "新しいトピック" },
            content: { type: "string", description: "新しい内容" },
            kind: {
              type: "string",
              enum: [
                "user_statement",
                "sourced_fact",
                "inference",
                "unverified",
              ],
              description:
                "情報の由来。ユーザーが明言した内容はuser_statement、出典付き事実はsourced_fact。自己判断で検証済みに昇格しない。",
            },
            category: {
              type: "string",
              enum: ["preference", "decision", "progress", "knowledge"],
            },
            source_url: {
              type: "string",
              description: "本文を確認したHTTP(S)出典URL",
            },
            source_ref: {
              type: "string",
              description: "会話や資料の参照ID（任意）",
            },
            valid_as_of: {
              type: "string",
              description: "情報の基準日 YYYY-MM-DD",
            },
            expires_at: {
              type: "string",
              description:
                "有効期限（タイムゾーン付きISO 8601日時）。時事情報は短く設定。",
            },
            confidence: {
              type: "number",
              description: "新しい信頼度（0.0-1.0）",
            },
          },
          required: ["id", "expected_revision"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_forget",
        description:
          "不要な記憶の本文と訂正履歴を完全削除します。誤りの経緯を一時的に残したい場合はmemory_invalidateを使ってください。",
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
        name: "memory_invalidate",
        description:
          "誤り・不要・古い記憶を直ちに検索対象から外します。本文と履歴は30日後の定期処理で自動廃棄します。即時の完全削除にはmemory_forgetを使います。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string" },
            reason: {
              type: "string",
              enum: ["incorrect", "unnecessary", "outdated"],
            },
            expected_revision: { type: "integer" },
          },
          required: ["id", "reason", "expected_revision"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_supersede",
        description:
          "先にmemory_storeで新しい記憶を保存し、そのIDをnew_idに指定して古い記憶を置き換えます。両方が有効な同じユーザーの記憶である必要があります。",
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
  return JSON.stringify({
    id: m.id,
    revision: m.revision,
    topic: m.topic,
    kind: m.kind,
    expires_at: m.expires_at,
    invalidated_at: m.invalidated_at,
  });
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
        text: formatMemoryBrief(entry),
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
        summary: "記憶を取得し、入力予算に収まる参考情報を提示します。",
        text: formatMemoriesForPrompt(memories),
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

    if (call.name === "memory_invalidate") {
      const args = parseArgs(memoryInvalidateArgs, call.arguments);
      const success = await invalidateMemory(
        userId,
        args.id,
        args.reason,
        args.expected_revision,
      );
      return {
        ok: success,
        capability: "web-search",
        summary: success
          ? "記憶を失効させ、参照対象から外しました。"
          : "記憶が見つかりませんでした。",
        text: "",
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
  "memory_invalidate",
  "memory_supersede",
]);

export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOL_NAMES.has(name);
}

// Re-export for convenience
export { findRelevantMemories, formatMemoriesForPrompt, runMemoryMaintenance };
