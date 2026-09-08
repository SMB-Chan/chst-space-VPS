import type OpenAI from "openai";
import {
  applyGenerationParams,
  getClientForModel,
  resolveConfiguredVisionModel,
  modelSupportsVision,
} from "./ai-clients";
import { logger } from "./logger";

/**
 * Vision bridge ("目" の貸出): when the answering or auditing model cannot
 * see images (DeepSeek, GLM), a vision-capable model transcribes the attached
 * images into text first, and the text-only model works from that transcript.
 */

const DEFAULT_BRIDGE_MODEL_DASHSCOPE = "qwen3.6-flash";
const DEFAULT_BRIDGE_MODEL_OPENAI = "gpt-5.6-luna";

function resolveBridgeModelId(): string | null {
  const override = process.env.VISION_BRIDGE_MODEL?.trim();
  if (override && !modelSupportsVision(override)) return null;
  return resolveConfiguredVisionModel([
    process.env.VISION_BRIDGE_MODEL?.trim() ?? "",
    DEFAULT_BRIDGE_MODEL_DASHSCOPE,
    DEFAULT_BRIDGE_MODEL_OPENAI,
  ]);
}

export function isVisionBridgeAvailable(): boolean {
  return resolveBridgeModelId() !== null;
}

const TRANSCRIBE_SYSTEM_PROMPT = `あなたは画像の内容をテキストへ正確に書き起こす転記係です。画像を直接見られない別のモデルが、あなたの転記だけを頼りに回答します。

規則:
- 画像内の文字は可能な限り全文そのまま転記する。
- 図表・グラフ・数値は具体的な値を書く（軸、単位、凡例を含める）。
- 画面写真なら UI 構造と表示テキストを説明する。
- 推測・感想・評価は書かない。読み取れない部分は「判読不能」と明記する。
- 複数画像がある場合は画像ごとに区切って転記する。`;

export async function describeImagesForTextModel(args: {
  imageDataUrls: string[];
  question?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const modelId = resolveBridgeModelId();
  if (!modelId) {
    throw new Error(
      "No vision-capable model is configured for the vision bridge",
    );
  }
  const { client, provider } = getClientForModel(modelId);

  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: "text",
      text:
        `次の画像を転記してください。` +
        (args.question?.trim()
          ? `\n\n参考——ユーザーは画像について次の質問をしています（回答ではなく転記の重点付けに使うこと）:\n${args.question.trim().slice(0, 1000)}`
          : ""),
    },
    ...args.imageDataUrls.map(
      (url): OpenAI.Chat.Completions.ChatCompletionContentPart => ({
        type: "image_url",
        image_url: { url },
      }),
    ),
  ];

  const options: Record<string, unknown> = {
    model: modelId,
    messages: [
      { role: "system", content: TRANSCRIBE_SYSTEM_PROMPT },
      { role: "user", content },
    ],
    stream: false,
  };
  applyGenerationParams(options, modelId, provider, "off");

  logger.info(
    { bridgeModelId: modelId, imageCount: args.imageDataUrls.length },
    "Vision bridge transcription started",
  );
  const completion = await client.chat.completions.create(
    options as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    { signal: args.signal },
  );
  const text = completion.choices?.[0]?.message?.content ?? "";
  logger.info(
    { bridgeModelId: modelId, outputCharacters: text.length },
    "Vision bridge transcription completed",
  );
  return text.trim();
}
