import { z } from "zod";
import {
  AVAILABLE_MODELS,
  dashscopeClient,
  type ModelProvider,
} from "./ai-clients";
import { transcribeDashScopeAudio } from "./audio-transcription";
import { generateAlibabaImage } from "./alibaba-image";
import {
  QWEN_AUDIO_TTS_PLUS_VOICES,
  synthesizeAlibabaSpeech,
} from "./alibaba-tts";
import {
  isAlibabaSpecialistConfigured,
  isAlibabaTokenPlanKey,
} from "./alibaba-specialist-config";
import type { GeneratedAsset as StoredGeneratedAsset } from "./generated-assets";
import { ALIBABA_MODEL_CATALOG } from "./alibaba-capabilities";

export const CAPABILITY_IDS = [
  "chat",
  "reasoning",
  "vision",
  "image-generate",
  "image-edit",
  "speech-to-text",
  "audio-synthesis",
  "realtime",
  "video",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export interface CapabilityModel {
  id: string;
  label: string;
  provider: ModelProvider;
  capabilities: CapabilityId[];
  configured: boolean;
}

export interface CapabilityDescriptor {
  id: CapabilityId;
  label: string;
  description: string;
  status: "available" | "catalog-only";
  models: string[];
}

const SPECIALIST_MODEL_BASE: CapabilityModel[] = ALIBABA_MODEL_CATALOG
  .filter((model) => model.kind !== "chat")
  .map((model) => ({
    id: model.id,
    label: model.label,
    provider: "dashscope" as const,
    capabilities: model.capabilities.flatMap((capability): CapabilityId[] => {
      switch (capability) {
        case "image.generate":
          return ["image-generate"];
        case "image.edit":
          return ["image-edit"];
        case "audio.asr":
          return ["speech-to-text"];
        case "audio.tts":
          return ["audio-synthesis"];
        case "audio.realtime":
          return ["realtime"];
        case "video.t2v":
        case "video.i2v":
        case "video.r2v":
          return ["video"];
        default:
          return [];
      }
    }),
    configured: false,
  }));

// Paraformer remains a compatibility fallback for regular Model Studio
// installations. Token Plan keys are deliberately not accepted for custom
// backend specialist traffic.
SPECIALIST_MODEL_BASE.push({
  id: "paraformer-v2",
  label: "Paraformer V2",
  provider: "dashscope",
  capabilities: ["speech-to-text"],
  configured: false,
});

const CAPABILITY_DETAILS: Record<CapabilityId, Omit<CapabilityDescriptor, "id" | "models" | "status">> = {
  chat: {
    label: "チャット",
    description: "会話応答を生成するモデル",
  },
  reasoning: {
    label: "推論",
    description: "深い推論と計画を行うモデル",
  },
  vision: {
    label: "画像理解",
    description: "画像を読み取り、内容を説明するモデル",
  },
  "image-generate": {
    label: "画像生成",
    description: "テキストから画像を生成する専門モデル",
  },
  "image-edit": {
    label: "画像編集",
    description: "添付画像を指示に沿って編集する専門モデル",
  },
  "speech-to-text": {
    label: "音声認識",
    description: "音声をテキストへ変換する専門モデル",
  },
  "audio-synthesis": {
    label: "音声合成",
    description: "テキストから音声を生成する専門モデル",
  },
  realtime: {
    label: "リアルタイム音声",
    description: "低遅延の音声対話能力",
  },
  video: {
    label: "動画生成",
    description: "テキストや画像から動画を生成する能力",
  },
};

let dashScopeModelCache:
  | { ids: Set<string>; expiresAt: number }
  | { ids: null; expiresAt: number }
  | null = null;

function dashScopeModelsUrl(): string {
  const configured =
    process.env.DASHSCOPE_BASE_URL?.trim() ||
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
  return `${configured.replace(/\/+$/, "")}/models`;
}

async function readDashScopeModelIds(): Promise<Set<string> | null> {
  if (!dashscopeClient || !process.env.DASHSCOPE_API_KEY) return null;
  if (dashScopeModelCache && dashScopeModelCache.expiresAt > Date.now()) {
    return dashScopeModelCache.ids;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(dashScopeModelsUrl(), {
      headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`model list returned ${response.status}`);
    const payload = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = new Set(
      (payload.data ?? []).flatMap((item) => (typeof item.id === "string" ? [item.id] : [])),
    );
    if (ids.size === 0) throw new Error("model list was empty");
    dashScopeModelCache = { ids, expiresAt: Date.now() + 5 * 60_000 };
    return ids;
  } catch {
    dashScopeModelCache = { ids: null, expiresAt: Date.now() + 60_000 };
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function chatModelCapabilities(model: (typeof AVAILABLE_MODELS)[number]): CapabilityId[] {
  return [
    "chat",
    ...(model.supportsReasoning ? (["reasoning"] as const) : []),
    ...(model.supportsVision ? (["vision"] as const) : []),
  ];
}

function regularDashScopeTranscriptionConfigured(): boolean {
  const key = process.env.DASHSCOPE_API_KEY?.trim();
  return Boolean(dashscopeClient && key && !isAlibabaTokenPlanKey(key));
}

function specialistModelConfigured(model: CapabilityModel): boolean {
  if (model.id === "paraformer-v2") return regularDashScopeTranscriptionConfigured();
  if (model.id === "qwen-audio-3.0-asr-flash") return isAlibabaSpecialistConfigured();
  if (model.capabilities.includes("image-generate") || model.capabilities.includes("image-edit")) {
    return isAlibabaSpecialistConfigured();
  }
  if (model.id === "qwen-audio-3.0-tts-plus" && model.capabilities.includes("audio-synthesis")) {
    return isAlibabaSpecialistConfigured();
  }
  if (model.id === "qwen-audio-3.0-realtime-plus" && model.capabilities.includes("realtime")) {
    return isAlibabaSpecialistConfigured();
  }
  // HappyHorse transports remain catalog-only until their dedicated worker is
  // configured for the current process.
  return false;
}

function capabilityStatus(id: CapabilityId, models: CapabilityModel[]): "available" | "catalog-only" {
  if (id === "chat" || id === "reasoning" || id === "vision") return "available";
  return models.some((model) => model.configured && model.capabilities.includes(id))
    ? "available"
    : "catalog-only";
}

export function getCapabilityModels(): CapabilityModel[] {
  const chatModels = AVAILABLE_MODELS.map((model) => ({
    id: model.id,
    label: model.label,
    provider: model.provider,
    capabilities: chatModelCapabilities(model),
    configured: model.provider === "openai" || Boolean(dashscopeClient),
  }));
  const specialistModels = SPECIALIST_MODEL_BASE.map((model) => ({
    ...model,
    configured: specialistModelConfigured(model),
  }));
  return [...chatModels, ...specialistModels];
}

export function getCapabilityRegistry(): {
  capabilities: CapabilityDescriptor[];
  models: CapabilityModel[];
} {
  const models = getCapabilityModels();
  const capabilities = CAPABILITY_IDS.map((id) => ({
    id,
    ...CAPABILITY_DETAILS[id],
    status: capabilityStatus(id, models),
    models: models.filter((model) => model.capabilities.includes(id)).map((model) => model.id),
  }));
  return { capabilities, models };
}

export async function getAvailableChatModels(): Promise<(typeof AVAILABLE_MODELS)[number][]> {
  const ids = await readDashScopeModelIds();
  if (!ids) return [...AVAILABLE_MODELS];
  return AVAILABLE_MODELS.filter(
    (model) => model.provider === "openai" || ids.has(model.id),
  );
}

export async function getCapabilityRegistryWithAvailability(): Promise<{
  capabilities: CapabilityDescriptor[];
  models: CapabilityModel[];
}> {
  const ids = await readDashScopeModelIds();
  const models = getCapabilityModels().map((model) => {
    if (model.provider === "openai") return { ...model, configured: true };
    if (model.capabilities.includes("chat")) {
      return { ...model, configured: Boolean(dashscopeClient) && (!ids || ids.has(model.id)) };
    }
    return model;
  });
  const capabilities = CAPABILITY_IDS.map((id) => ({
    id,
    ...CAPABILITY_DETAILS[id],
    status: capabilityStatus(id, models),
    models: models.filter((model) => model.capabilities.includes(id)).map((model) => model.id),
  }));
  return { capabilities, models };
}

export type GeneratedAsset = StoredGeneratedAsset & {
  capability: "image-generate" | "image-edit" | "audio-synthesis";
};

export interface SpecialistToolResult {
  ok: boolean;
  capability: "image-generate" | "image-edit" | "speech-to-text" | "audio-synthesis";
  summary: string;
  text?: string;
  asset?: GeneratedAsset;
}

export interface SpecialistToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface SpecialistToolContext {
  imageAttachments?: { name: string; content: string }[];
  audioAttachments?: { name: string; buffer: Buffer; mime: string }[];
  signal?: AbortSignal;
}

export interface SpecialistToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const imageGenerationArgs = z.object({
  prompt: z.string().trim().min(1).max(4_000),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024"),
  modelId: z.string().trim().max(100).optional(),
  n: z.number().int().min(1).max(6).optional(),
});

const imageEditArgs = z.object({
  imageName: z.string().trim().min(1).max(255),
  prompt: z.string().trim().min(1).max(4_000),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).optional(),
  modelId: z.string().trim().max(100).optional(),
  n: z.number().int().min(1).max(6).optional(),
});

const transcribeArgs = z.object({
  attachmentName: z.string().trim().min(1).max(255),
  modelId: z.enum(["qwen-audio-3.0-asr-flash", "paraformer-v2"]).optional(),
  languageHints: z.array(z.string().trim().min(2).max(16)).max(4).optional(),
});

const synthesizeSpeechArgs = z.object({
  text: z.string().trim().min(1).max(10_000),
  modelId: z.literal("qwen-audio-3.0-tts-plus").optional(),
  voice: z.enum(QWEN_AUDIO_TTS_PLUS_VOICES).optional(),
  instruction: z.string().trim().max(1_000).optional(),
  languageHint: z.enum(["zh", "en"]).optional(),
  rate: z.number().min(0.5).max(2).optional(),
  pitch: z.number().min(0.5).max(2).optional(),
  volume: z.number().min(0).max(100).optional(),
});

export function getSpecialistTools(context: SpecialistToolContext): SpecialistToolDefinition[] {
  const specialistConfigured = isAlibabaSpecialistConfigured();
  if (!specialistConfigured && !regularDashScopeTranscriptionConfigured()) return [];
  const tools: SpecialistToolDefinition[] = [];

  if (specialistConfigured) {
    tools.push({
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Alibaba Model Studioで画像を1枚生成します。ユーザーが実際の画像生成を求めた場合だけ使ってください。",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 4_000 },
            size: { type: "string", enum: ["1024x1024", "1536x1024", "1024x1536"] },
          },
          required: ["prompt"],
          additionalProperties: false,
        },
      },
    });
    tools.push({
      type: "function",
      function: {
        name: "synthesize_speech",
        description:
          "Alibaba Model StudioのQwen Audio TTS Plusで中国語または英語のテキストをMP3音声にします。実際の読み上げ・音声化を求められた場合だけ使ってください。",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, maxLength: 10_000 },
            voice: { type: "string", enum: [...QWEN_AUDIO_TTS_PLUS_VOICES] },
            instruction: { type: "string", maxLength: 1_000 },
            languageHint: { type: "string", enum: ["zh", "en"] },
            rate: { type: "number", minimum: 0.5, maximum: 2 },
            pitch: { type: "number", minimum: 0.5, maximum: 2 },
            volume: { type: "number", minimum: 0, maximum: 100 },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    });
  }

  if (specialistConfigured && context.imageAttachments?.length) {
    tools.push({
      type: "function",
      function: {
        name: "edit_image",
        description:
          "添付画像をAlibaba Model Studioで編集します。画像名と編集指示を指定してください。",
        parameters: {
          type: "object",
          properties: {
            imageName: { type: "string", minLength: 1, maxLength: 255 },
            prompt: { type: "string", minLength: 1, maxLength: 4_000 },
          },
          required: ["imageName", "prompt"],
          additionalProperties: false,
        },
      },
    });
  }
  if (specialistConfigured && context.audioAttachments?.length) {
    tools.push({
      type: "function",
      function: {
        name: "transcribe_audio",
        description:
          "添付音声を通常のAlibaba Model Studio資格情報で文字起こしします。音声の内容確認が必要な場合だけ使ってください。",
        parameters: {
          type: "object",
          properties: {
            attachmentName: { type: "string", minLength: 1, maxLength: 255 },
            modelId: { type: "string", enum: ["qwen-audio-3.0-asr-flash", "paraformer-v2"] },
            languageHints: { type: "array", maxItems: 4, items: { type: "string", minLength: 2, maxLength: 16 } },
          },
          required: ["attachmentName"],
          additionalProperties: false,
        },
      },
    });
  }
  return tools;
}

async function generateImage(
  prompt: string,
  size: "1024x1024" | "1536x1024" | "1024x1536",
  modelId?: string,
  n?: number,
  signal?: AbortSignal,
): Promise<GeneratedAsset> {
  const [asset] = await generateAlibabaImage({
    prompt,
    size: size.replace("x", "*"),
    modelId,
    n,
    signal,
  });
  if (!asset) throw new Error("画像モデルが画像を返しませんでした");
  return { ...asset, capability: "image-generate" };
}

async function editImage(
  image: { name: string; content: string },
  prompt: string,
  size?: "1024x1024" | "1536x1024" | "1024x1536",
  modelId?: string,
  n?: number,
  signal?: AbortSignal,
): Promise<GeneratedAsset> {
  const [asset] = await generateAlibabaImage({
    prompt,
    referenceImages: [image.content],
    size: size?.replace("x", "*"),
    modelId,
    n,
    signal,
  });
  if (!asset) throw new Error("画像モデルが編集画像を返しませんでした");
  return { ...asset, capability: "image-edit" };
}

function parseToolArgs<T>(schema: z.ZodType<T>, raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("専門能力の引数JSONが不正です");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error("専門能力の引数が不正です");
  return result.data;
}

export async function executeSpecialistTool(
  call: SpecialistToolCall,
  context: SpecialistToolContext,
): Promise<SpecialistToolResult> {
  try {
    if (call.name === "generate_image") {
      const args = parseToolArgs(imageGenerationArgs, call.arguments);
      const asset = await generateImage(
        args.prompt,
        args.size ?? "1024x1024",
        args.modelId,
        args.n,
        context.signal,
      );
      return {
        ok: true,
        capability: "image-generate",
        summary: "画像を1枚生成しました。",
        asset,
      };
    }
    if (call.name === "edit_image") {
      const args = parseToolArgs(imageEditArgs, call.arguments);
      const image = context.imageAttachments?.find((item) => item.name === args.imageName);
      if (!image) throw new Error("指定された編集対象の画像が見つかりません");
      const asset = await editImage(
        image,
        args.prompt,
        args.size,
        args.modelId,
        args.n,
        context.signal,
      );
      return {
        ok: true,
        capability: "image-edit",
        summary: "添付画像を編集しました。",
        asset,
      };
    }
    if (call.name === "transcribe_audio") {
      const args = parseToolArgs(transcribeArgs, call.arguments);
      const audio = context.audioAttachments?.find((item) => item.name === args.attachmentName);
      if (!audio) throw new Error("指定された音声添付が見つかりません");
      const text = await transcribeDashScopeAudio({
        buffer: audio.buffer,
        filename: audio.name,
        mime: audio.mime,
        signal: context.signal,
        languageHints: args.languageHints,
      }, args.modelId);
      return {
        ok: true,
        capability: "speech-to-text",
        summary: "音声を文字起こししました。",
        text: text || "音声から認識できる内容が見つかりませんでした。",
      };
    }
    if (call.name === "synthesize_speech") {
      const args = parseToolArgs(synthesizeSpeechArgs, call.arguments);
      const speech = await synthesizeAlibabaSpeech({
        text: args.text,
        modelId: args.modelId,
        voice: args.voice,
        instruction: args.instruction,
        languageHint: args.languageHint,
        rate: args.rate,
        pitch: args.pitch,
        volume: args.volume,
        signal: context.signal,
      });
      const asset: GeneratedAsset = { ...speech, capability: "audio-synthesis" };
      return {
        ok: true,
        capability: "audio-synthesis",
        summary: "MP3音声を生成しました。",
        asset,
      };
    }
    throw new Error("許可されていない専門能力です");
  } catch (error) {
    return {
      ok: false,
      capability:
        call.name === "edit_image"
          ? "image-edit"
          : call.name === "transcribe_audio"
            ? "speech-to-text"
            : call.name === "synthesize_speech"
              ? "audio-synthesis"
              : "image-generate",
      summary: error instanceof Error ? error.message : "専門能力の実行に失敗しました",
    };
  }
}
