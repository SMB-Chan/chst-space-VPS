import { z } from "zod";
import { extractFormsFromPage, fillAndSubmitForm } from "./form-fill";
import type {
  SpecialistToolCall,
  SpecialistToolDefinition,
  SpecialistToolResult,
} from "./specialist-capabilities";

const analyzeFormsArgs = z.object({
  url: z.string().trim().min(1).max(2000),
});

const fillFormArgs = z.object({
  url: z.string().trim().min(1).max(2000),
  formIndex: z.number().int().min(0).max(20),
  fieldValues: z
    .record(z.string().trim().min(0).max(500))
    .refine((obj) => Object.keys(obj).length <= 5, {
      message: "fieldValues must have at most 5 entries",
    }),
});

export function getFormToolDefinitions(): SpecialistToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "analyze_forms",
        description:
          "Webページのフォームを分析します。検索ボックス、計算機、変換ツールなどの情報取得用フォームを検出します。" +
          "各フォームには安全性判定（safe/blocked/uncertain）が付与されます。safeと判定されたフォームのみ操作可能です。" +
          "個人情報・決済・ログイン関連のフォームは自動的にブロックされます。",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "分析対象のURL",
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "fill_form",
        description:
          "Webページのフォームに入力して送信します。analyze_formsでsafeと判定されたフォームのみ操作可能です。" +
          "個人情報（メールアドレス、電話番号、パスワード等）は絶対に入力しないでください。" +
          "検索クエリや変換値など、情報取得に必要な入力のみ行ってください。",
        parameters: {
          type: "object",
          properties: {
            url: {
              type: "string",
              description: "フォームがあるページのURL",
            },
            formIndex: {
              type: "number",
              description: "操作対象のフォーム番号（analyze_formsのindex）",
            },
            fieldValues: {
              type: "object",
              description:
                "入力する値（フィールド名またはID → 値のマップ）。最大5フィールド。",
              additionalProperties: { type: "string" },
            },
          },
          required: ["url", "formIndex", "fieldValues"],
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
    throw new Error("フォームツールの引数JSONが不正です");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error("フォームツールの引数が不正です");
  return result.data;
}

export async function executeFormTool(
  call: SpecialistToolCall,
  options: { submissionApproved: boolean },
): Promise<SpecialistToolResult> {
  try {
    if (call.name === "analyze_forms") {
      const args = parseArgs(analyzeFormsArgs, call.arguments);
      const forms = await extractFormsFromPage(args.url);

      if (forms.length === 0) {
        return {
          ok: true,
          capability: "web-search",
          summary: "ページにフォームが見つかりませんでした。",
          text: "",
        };
      }

      const safeForms = forms.filter((f) => f.safety.verdict === "safe");
      const blockedForms = forms.filter((f) => f.safety.verdict === "blocked");

      const lines = forms.map((f) => {
        const safetyIcon =
          f.safety.verdict === "safe"
            ? "✅"
            : f.safety.verdict === "blocked"
              ? "🚫"
              : "⚠️";
        const fieldList = f.fields
          .filter(
            (field) =>
              !["hidden", "submit", "button", "reset"].includes(
                field.type.toLowerCase(),
              ),
          )
          .map(
            (field) =>
              `    - ${field.name || field.id || "(unnamed)"} (${field.type}): ${field.placeholder || field.label || "no description"}`,
          )
          .join("\n");

        return (
          `[フォーム ${f.index}] ${safetyIcon} ${f.safety.verdict.toUpperCase()} (リスク: ${f.safety.riskScore})\n` +
          `  URL: ${f.action}\n` +
          `  送信方法: ${f.method}\n` +
          `  送信ボタン: ${f.submitText}\n` +
          `  フィールド:\n${fieldList}`
        );
      });

      return {
        ok: true,
        capability: "web-search",
        summary: `${forms.length}個のフォームを検出（safe: ${safeForms.length}, blocked: ${blockedForms.length}）。`,
        text: lines.join("\n\n"),
      };
    }

    if (call.name === "fill_form") {
      if (!options.submissionApproved) {
        throw new Error(
          "フォーム送信には、送信内容を表示した後のユーザーによる明示確認が必要です",
        );
      }
      const args = parseArgs(fillFormArgs, call.arguments);
      const result = await fillAndSubmitForm(
        args.url,
        args.formIndex,
        args.fieldValues,
      );

      if (!result.success) {
        const blockedReasons = result.safety.reasons
          .filter((r) => r.severity === "critical")
          .map((r) => r.detail)
          .join("; ");
        return {
          ok: true,
          capability: "web-search",
          summary: `フォーム操作は安全上ブロックされました: ${blockedReasons || result.safety.verdict}`,
          text: "",
        };
      }

      return {
        ok: true,
        capability: "web-search",
        summary: `フォーム送信が成功しました。結果ページ: ${result.resultUrl}`,
        text: result.resultText.slice(0, 3000),
      };
    }

    throw new Error("不明なフォームツールです");
  } catch (error) {
    return {
      ok: false,
      capability: "web-search",
      summary:
        error instanceof Error
          ? error.message
          : "フォームツールの実行に失敗しました",
      text: "",
    };
  }
}

export const FORM_TOOL_NAMES = new Set(["analyze_forms", "fill_form"]);

export function isFormTool(name: string): boolean {
  return FORM_TOOL_NAMES.has(name);
}
