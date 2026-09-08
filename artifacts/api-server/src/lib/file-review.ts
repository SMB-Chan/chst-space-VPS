import type OpenAI from "openai";
import {
  getClientForModel,
  resolveConfiguredVisionModel,
  applyGenerationParams,
} from "./ai-clients";
import { logger } from "./logger";
import type { FileFormat } from "./file-generation";

const DEFAULT_VISION_MODEL = "gpt-5.6-terra";
const NO_ISSUE_MARKERS = [
  "NO_ISSUES",
  "問題なし",
  "問題はありません",
  "問題は見つかりません",
];

export function getVisionClient(modelId?: string): {
  client: OpenAI;
  modelId: string;
} {
  const resolvedModelId = resolveConfiguredVisionModel([
    modelId ?? "",
    DEFAULT_VISION_MODEL,
  ]);
  if (!resolvedModelId)
    throw new Error("利用可能な画像理解モデルがありません。");
  const { client } = getClientForModel(resolvedModelId);
  return { client, modelId: resolvedModelId };
}

export function buildLayoutReviewPrompt(
  format: FileFormat,
  pageCount: number,
): string {
  const formatName =
    format === "pdf"
      ? "PDF"
      : format === "docx"
        ? "Word"
        : format === "xlsx"
          ? "Excel"
          : "PowerPoint";

  return [
    `You are reviewing the generated ${formatName} document rendered as ${pageCount} preview image(s).`,
    "",
    "Check the following and suggest concrete improvements:",
    "- Text readability (font size, contrast, alignment)",
    "- Page margins and whitespace",
    "- Heading hierarchy and consistency",
    "- Bullet/list formatting",
    "- Table readability (borders, column widths, headers)",
    "- Slide/page layout balance",
    "- Any overflow, truncation, or broken layout",
    "",
    "If the layout is good and no changes are needed, reply with exactly: NO_ISSUES",
    "If you find issues, reply with a concise numbered list of specific changes to make. Do not include general praise.",
  ].join("\n");
}

export function hasActionableFeedback(feedback: string): boolean {
  const normalized = feedback.trim();
  if (!normalized) return false;
  return !NO_ISSUE_MARKERS.some((marker) =>
    normalized.toLowerCase().includes(marker.toLowerCase()),
  );
}

export async function reviewLayout(args: {
  client: OpenAI;
  modelId: string;
  format: FileFormat;
  images: Buffer[];
  originalData?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const { client, modelId, format, images, originalData, signal } = args;

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: buildLayoutReviewPrompt(format, images.length) },
  ];

  for (const image of images) {
    content.push({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${image.toString("base64")}` },
    });
  }

  if (originalData) {
    content.push({
      type: "text",
      text: `Original structured data used to generate the file:\n${originalData}`,
    });
  }

  const { provider } = getClientForModel(modelId);
  const options: Record<string, unknown> = {
    model: modelId,
    messages: [{ role: "user", content }],
  };
  applyGenerationParams(options, modelId, provider, "off");
  options[
    provider === "openai" || provider === "xiaomi"
      ? "max_completion_tokens"
      : "max_tokens"
  ] = 2048;
  const response = await client.chat.completions.create(
    options as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    { signal },
  );

  const text = response.choices[0]?.message?.content?.trim() ?? "";
  if (!text) {
    logger.warn(
      { stage: "layout-review-model", modelId, format },
      "Vision layout review returned empty response",
    );
    return "";
  }
  return text;
}
