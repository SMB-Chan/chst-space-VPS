import { z } from "zod";
import type {
  SpecialistToolCall,
  SpecialistToolContext,
  SpecialistToolDefinition,
  SpecialistToolResult,
} from "./specialist-capabilities";
import {
  ToolBankPolicyError,
  copyToolToProject,
  createToolBankItem,
  getToolBankItem,
  listToolBank,
  softDeleteToolBankItem,
  updateToolBankItem,
} from "./tool-bank-store";

const saveArgs = z.object({
  name: z.string().min(1).max(160),
  code: z.string().min(1),
  summary: z.string().max(2000).optional(),
  language: z.string().max(40).optional(),
  usage: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  source_project_id: z.number().int().positive().optional(),
});

const searchArgs = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  status: z.enum(["active", "deprecated", "archived", "all"]).optional(),
});

const getArgs = z.object({
  id: z.number().int().positive(),
});

const updateArgs = z.object({
  id: z.number().int().positive(),
  change_summary: z.string().min(1).max(2000),
  name: z.string().min(1).max(160).optional(),
  summary: z.string().max(2000).optional(),
  language: z.string().max(40).optional(),
  usage: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  code: z.string().min(1).optional(),
  status: z.enum(["active", "deprecated", "archived"]).optional(),
});

const deleteArgs = z.object({
  id: z.number().int().positive(),
});

const copyArgs = z.object({
  id: z.number().int().positive(),
  project_id: z.number().int().positive(),
});

function parseArgs<T extends z.ZodTypeAny>(schema: T, raw: string): z.infer<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch {
    parsed = {};
  }
  return schema.parse(parsed);
}

function brief(tool: {
  id: number;
  name: string;
  slug: string;
  version: number;
  status: string;
  summary: string;
  language: string;
  useCount: number;
}): string {
  return [
    `id=${tool.id}`,
    `name=${tool.name}`,
    `slug=${tool.slug}`,
    `v${tool.version}`,
    `status=${tool.status}`,
    `lang=${tool.language}`,
    `uses=${tool.useCount}`,
    tool.summary ? `summary=${tool.summary}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export function getToolBankToolDefinitions(): SpecialistToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "tool_bank_save",
        description:
          "プロジェクト遂行中に作成した再利用価値の高いコード/スクリプトをツールバンクへ登録します。" +
          "関数・CLI・定型処理など、他プロジェクトでも使えるものを bank してください。summary に「何ができるか・どこで使えるか」を書いてください。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "ツール名" },
            code: { type: "string", description: "再利用するコード本文" },
            summary: { type: "string", description: "用途の要約" },
            language: { type: "string", description: "例: typescript / python / bash" },
            usage: { type: "string", description: "使い方・引数・前提" },
            tags: { type: "array", items: { type: "string" } },
            source_project_id: {
              type: "number",
              description: "bank 元プロジェクトID（任意）",
            },
          },
          required: ["name", "code"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_bank_search",
        description:
          "ツールバンクを検索します。再利用可能なツールを探すとき、まずこれを使い、必要なら tool_bank_get で本文を取得して tool_bank_copy でプロジェクトへコピーしてください。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "キーワード（任意）" },
            status: {
              type: "string",
              enum: ["active", "deprecated", "archived", "all"],
            },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_bank_get",
        description: "ツールバンクから1件の詳細（コード本文含む）を取得します。",
        parameters: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_bank_update",
        description:
          "ツールバンクのエントリを更新します。change_summary は必須。コード変更時は version が上がります。archived は更新不可です。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "number" },
            change_summary: {
              type: "string",
              description: "何をなぜ変えたか（必須）",
            },
            name: { type: "string" },
            summary: { type: "string" },
            language: { type: "string" },
            usage: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            code: { type: "string" },
            status: {
              type: "string",
              enum: ["active", "deprecated", "archived"],
            },
          },
          required: ["id", "change_summary"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_bank_delete",
        description:
          "ツールバンクから soft delete します。物理削除は30日後 or archivedかつ180日未使用のときのみ API 側で許可されます。",
        parameters: {
          type: "object",
          properties: { id: { type: "number" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "tool_bank_copy",
        description:
          "ツールバンクから現在のプロジェクトへコードをコピー（スナップショット）します。他プロジェクトで流用するときは必ずこちらを使ってください。",
        parameters: {
          type: "object",
          properties: {
            id: { type: "number" },
            project_id: { type: "number" },
          },
          required: ["id", "project_id"],
          additionalProperties: false,
        },
      },
    },
  ];
}

export async function runToolBankTool(
  call: SpecialistToolCall,
  context: SpecialistToolContext,
): Promise<SpecialistToolResult> {
  const capability = "tool-bank";
  try {
    if (!context.userId) {
      throw new Error("ツールバンクにはユーザーが必要です");
    }
    const userId = context.userId;

    if (call.name === "tool_bank_save") {
      const args = parseArgs(saveArgs, call.arguments);
      const tool = await createToolBankItem(userId, {
        name: args.name,
        code: args.code,
        summary: args.summary,
        language: args.language,
        usage: args.usage,
        tags: args.tags,
        sourceProjectId: args.source_project_id,
      });
      return {
        ok: true,
        capability,
        summary: `ツールバンクへ登録しました: ${tool.name} (id=${tool.id})`,
        text: brief(tool),
      };
    }

    if (call.name === "tool_bank_search") {
      const args = parseArgs(searchArgs, call.arguments);
      const tools = await listToolBank(userId, {
        query: args.query,
        status: args.status ?? "active",
      });
      if (tools.length === 0) {
        return {
          ok: true,
          capability,
          summary: "該当するツールはありません。",
          text: "",
        };
      }
      return {
        ok: true,
        capability,
        summary: `${tools.length}件のツールが見つかりました。`,
        text: tools
          .slice(0, 20)
          .map(
            (t) =>
              `- #${t.id} ${t.name} [${t.language}] v${t.version} ${t.status} — ${t.summary}`,
          )
          .join("\n"),
      };
    }

    if (call.name === "tool_bank_get") {
      const args = parseArgs(getArgs, call.arguments);
      const tool = await getToolBankItem(userId, args.id);
      if (!tool) {
        return {
          ok: false,
          capability,
          summary: `id=${args.id} が見つかりません。`,
          text: "",
        };
      }
      return {
        ok: true,
        capability,
        summary: brief(tool),
        text: [
          `# ${tool.name}`,
          tool.summary,
          tool.usage ? `\n## usage\n${tool.usage}` : "",
          `\n\`\`\`${tool.language}\n${tool.code}\n\`\`\``,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }

    if (call.name === "tool_bank_update") {
      const args = parseArgs(updateArgs, call.arguments);
      const tool = await updateToolBankItem(userId, args.id, {
        name: args.name,
        summary: args.summary,
        language: args.language,
        usage: args.usage,
        tags: args.tags,
        code: args.code,
        status: args.status,
        changeSummary: args.change_summary,
      });
      if (!tool) {
        return {
          ok: false,
          capability,
          summary: `id=${args.id} が見つかりません。`,
          text: "",
        };
      }
      return {
        ok: true,
        capability,
        summary: `更新しました (id=${tool.id} v${tool.version})`,
        text: brief(tool),
      };
    }

    if (call.name === "tool_bank_delete") {
      const args = parseArgs(deleteArgs, call.arguments);
      const tool = await softDeleteToolBankItem(userId, args.id);
      return {
        ok: Boolean(tool),
        capability,
        summary: tool
          ? `soft delete しました (id=${tool.id})`
          : "ツールが見つかりません。",
        text: "",
      };
    }

    if (call.name === "tool_bank_copy") {
      const args = parseArgs(copyArgs, call.arguments);
      const result = await copyToolToProject(userId, args.id, args.project_id);
      return {
        ok: true,
        capability,
        summary: `プロジェクト ${args.project_id} へコピーしました: ${result.tool.name} v${result.tool.version}`,
        text: result.tool.code,
      };
    }

    return {
      ok: false,
      capability,
      summary: `未対応のツールバンク操作: ${call.name}`,
      text: "",
    };
  } catch (err) {
    const message =
      err instanceof ToolBankPolicyError || err instanceof Error
        ? err.message
        : "ツールバンク操作に失敗しました。";
    return { ok: false, capability, summary: message, text: "" };
  }
}

export const TOOL_BANK_TOOL_NAMES = new Set([
  "tool_bank_save",
  "tool_bank_search",
  "tool_bank_get",
  "tool_bank_update",
  "tool_bank_delete",
  "tool_bank_copy",
]);
