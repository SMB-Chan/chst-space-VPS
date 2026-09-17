import { z } from "zod";
import type {
  SpecialistToolCall,
  SpecialistToolDefinition,
} from "./specialist-capabilities";
import {
  applyCodingEdit,
  applyCodingWrite,
  diffLines,
  listCodingDir,
  normalizeCodingPath,
  persistableCodingTouch,
  readCodingFile,
  searchCodingFiles,
  type CodingTouch,
} from "./coding-mode";

export const CODING_TOOL_NAMES = [
  "code_list",
  "code_read",
  "code_search",
  "code_write",
  "code_edit",
] as const;

export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

const listArgs = z.object({
  path: z.string().trim().max(500).optional(),
});

const readArgs = z.object({
  path: z.string().trim().min(1).max(500),
  offset: z.number().int().min(1).max(100_000).optional(),
  limit: z.number().int().min(1).max(2_000).optional(),
});

const searchArgs = z.object({
  query: z.string().trim().min(1).max(300),
  path: z.string().trim().max(500).optional(),
  glob: z.string().trim().max(80).optional(),
  maxResults: z.number().int().min(1).max(40).optional(),
});

const writeArgs = z.object({
  path: z.string().trim().min(1).max(500),
  content: z.string().max(1_000_000),
});

const editArgs = z.object({
  path: z.string().trim().min(1).max(500),
  old_string: z.string().min(1).max(100_000),
  new_string: z.string().max(100_000),
  replace_all: z.boolean().optional(),
});

export interface CodingToolResult {
  ok: boolean;
  name: string;
  summary: string;
  text?: string;
  touch?: ReturnType<typeof persistableCodingTouch>;
}

export function isCodingTool(call: { name: string }): boolean {
  return (CODING_TOOL_NAMES as readonly string[]).includes(call.name);
}

export function getCodingToolDefinitions(): SpecialistToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "code_list",
        description:
          "プロジェクト内のディレクトリを一覧します。path 省略時はルートです。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "相対ディレクトリ" },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "code_read",
        description:
          "プロジェクト内のテキストファイルを行番号付きで読みます。大きいファイルは offset/limit で分割してください。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 2000 },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "code_search",
        description:
          "プロジェクト内を正規表現または文字列で検索します。先にこれを使って変更箇所を特定してください。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            path: { type: "string", description: "検索開始パス" },
            glob: { type: "string", description: "例: .ts または .tsx" },
            maxResults: { type: "integer", minimum: 1, maximum: 40 },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "code_write",
        description:
          "新規ファイルの作成、またはファイル全体の置き換え。既存ファイルの部分変更には code_edit を使ってください。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "code_edit",
        description:
          "既存ファイルの部分置換。old_string はファイル内で一意にしてください。複数置換は replace_all=true。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
            replace_all: { type: "boolean" },
          },
          required: ["path", "old_string", "new_string"],
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
    throw new Error("ツール引数の JSON が不正です。");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error("ツール引数が不正です。");
  return result.data;
}

export function executeCodingTool(
  call: SpecialistToolCall,
  rootDir: string,
): CodingToolResult {
  try {
    if (call.name === "code_list") {
      const args = parseArgs(listArgs, call.arguments);
      const entries = listCodingDir(rootDir, args.path ?? "");
      return {
        ok: true,
        name: call.name,
        summary: `${entries.length} 件`,
        text: JSON.stringify(entries),
      };
    }
    if (call.name === "code_read") {
      const args = parseArgs(readArgs, call.arguments);
      const file = readCodingFile(rootDir, args.path, args.offset, args.limit);
      return {
        ok: true,
        name: call.name,
        summary: `${file.path} L${file.startLine}-${file.endLine}`,
        text: JSON.stringify(file),
      };
    }
    if (call.name === "code_search") {
      const args = parseArgs(searchArgs, call.arguments);
      const hits = searchCodingFiles(rootDir, args.query, {
        path: args.path,
        glob: args.glob,
        maxResults: args.maxResults,
      });
      return {
        ok: true,
        name: call.name,
        summary: `${hits.length} 件ヒット`,
        text: JSON.stringify(hits),
      };
    }
    if (call.name === "code_write") {
      const args = parseArgs(writeArgs, call.arguments);
      const clean = normalizeCodingPath(args.path);
      if (!clean) throw new Error("パスが不正です。");
      const written = applyCodingWrite(rootDir, clean, args.content);
      const diff = diffLines(written.previous, args.content);
      const touch: CodingTouch = {
        path: clean,
        kind: written.kind,
        added: diff.added,
        removed: diff.removed,
        patch: diff.patch,
      };
      return {
        ok: true,
        name: call.name,
        summary:
          written.kind === "create" ? `${clean} を作成` : `${clean} を更新`,
        text: JSON.stringify({
          path: clean,
          kind: written.kind,
          added: diff.added,
          removed: diff.removed,
        }),
        touch: persistableCodingTouch(touch),
      };
    }
    if (call.name === "code_edit") {
      const args = parseArgs(editArgs, call.arguments);
      const touch = applyCodingEdit(
        rootDir,
        args.path,
        args.old_string,
        args.new_string,
        args.replace_all === true,
      );
      return {
        ok: true,
        name: call.name,
        summary: `${touch.path} を編集 (+${touch.added ?? 0}/-${touch.removed ?? 0})`,
        text: JSON.stringify({
          path: touch.path,
          kind: touch.kind,
          added: touch.added,
          removed: touch.removed,
        }),
        touch: persistableCodingTouch(touch),
      };
    }
    return {
      ok: false,
      name: call.name,
      summary: "未知のコーディングツールです。",
    };
  } catch (error) {
    return {
      ok: false,
      name: call.name,
      summary:
        error instanceof Error ? error.message : "ツール実行に失敗しました。",
    };
  }
}
