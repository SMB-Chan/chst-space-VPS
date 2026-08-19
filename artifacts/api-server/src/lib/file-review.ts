import type OpenAI from "openai";
import { getClientForModel, modelSupportsVision } from "./ai-clients";
import { logger } from "./logger";
import type { FileFormat } from "./file-generation";

const DEFAULT_VISION_MODEL = "gpt-5.6-terra";
const NO_ISSUE_MARKERS = ["NO_ISSUES", "問題なし", "問題はありません", "問題は見つかりません"];

export function getVisionClient(modelId?: string): { client: OpenAI; modelId: string } {
  const resolvedModelId = modelId && modelSupportsVision(modelId) ? modelId : DEFAULT_VISION_MODEL;
  const { client } = getClientForModel(resolvedModelId);
  return { client, modelId: resolvedModelId };
}

export function buildLayoutReviewPrompt(format: FileFormat, pageCount: number): string {
  const formatName =
    format === "pdf" ? "PDF" :
    format === "docx" ? "Word" :
    format === "xlsx" ? "Excel" :
    "PowerPoint";

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
}): Promise<string> {
  const { client, modelId, format, images, originalData } = args;

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

  try {
    const response = await client.chat.completions.create({
      model: modelId,
      messages: [{ role: "user", content }],
      max_tokens: 2048,
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text) {
      logger.warn({ modelId }, "Vision layout review returned empty response");
      return "";
    }
    return text;
  } catch (err) {
    logger.warn({ err, modelId }, "Vision layout review failed");
    return "";
  }
}
