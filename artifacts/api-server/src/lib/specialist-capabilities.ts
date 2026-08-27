import { z } from "zod";
import {
  AVAILABLE_MODELS,
  dashscopeClient,
  type ModelProvider,
} from "./ai-clients";
import { transcribeDashScopeAudio } from "./audio-transcription";

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

const SPECIALIST_MODELS: CapabilityModel[] = [
  {
    id: "qwen-image-plus",
    label: "Qwen Image Plus",
    provider: "dashscope",
    capabilities: ["image-generate"],
    configured: Boolean(dashscopeClient),
  },
  {
    id: "qwen-image-2.0-pro",
    label: "Qwen Image 2.0 Pro",
    provider: "dashscope",
    capabilities: ["image-edit"],
    configured: Boolean(dashscopeClient),
  },
  {
    id: "paraformer-v2",
    label: "Paraformer V2",
    provider: "dashscope",
    capabilities: ["speech-to-text"],
    configured: Boolean(dashscopeClient),
  },
  {
    id: "qwen-tts",
    label: "Qwen TTS",
    provider: "dashscope",
    capabilities: ["audio-synthesis"],
    configured: Boolean(dashscopeClient),
  },
  {
    id: "qwen-omni-turbo",
    label: "Qwen Omni Turbo",
    provider: "dashscope",
    capabilities: ["realtime"],
    configured: Boolean(dashscopeClient),
  },
  {
    id: "wan2.2-t2v-plus",
    label: "Wan 2.2 Video",
    provider: "dashscope",
    capabilities: ["video"],
    configured: Boolean(dashscopeClient),
  },
];

const CAPABILITY_DETAILS: Record<CapabilityId, Omit<CapabilityDescriptor, "id" | "models">> = {
  chat: {
    label: "チャット",
    description: "会話応答を生成するモデル",
    status: "available",
  },
  reasoning: {
    label: "推論",
    description: "深い推論と計画を行うモデル",
    status: "available",
  },
  vision: {
    label: "画像理解",
    description: "画像を読み取り、内容を説明するモデル",
    status: "available",
  },
  "image-generate": {
    label: "画像生成",
    description: "テキストから画像を生成する専門モデル",
    status: dashscopeClient ? "available" : "catalog-only",
  },
  "image-edit": {
    label: "画像編集",
    description: "添付画像を指示に沿って編集する専門モデル",
    status: dashscopeClient ? "available" : "catalog-only",
  },
  "speech-to-text": {
    label: "音声認識",
    description: "音声をテキストへ変換する専門モデル",
    status: dashscopeClient ? "available" : "catalog-only",
  },
  "audio-synthesis": {
    label: "音声合成",
    description: "テキストから音声を生成する能力",
    status: "catalog-only",
  },
  realtime: {
    label: "リアルタイム音声",
    description: "低遅延の音声対話能力",
    status: "catalog-only",
  },
  video: {
    label: "動画生成",
    description: "テキストや画像から動画を生成する能力",
    status: "catalog-only",
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
    // The static catalog remains the safe fallback when model discovery is
    // unavailable or a Token Plan deployment does not expose /models.
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

export function getCapabilityModels(): CapabilityModel[] {
  const chatModels = AVAILABLE_MODELS.map((model) => ({
    id: model.id,
    label: model.label,
    provider: model.provider,
    capabilities: chatModelCapabilities(model),
    configured: model.provider === "openai" || Boolean(dashscopeClient),
  }));
  return [...chatModels, ...SPECIALIST_MODELS];
}

export function getCapabilityRegistry(): {
  capabilities: CapabilityDescriptor[];
  models: CapabilityModel[];
} {
  const models = getCapabilityModels();
  const capabilities = CAPABILITY_IDS.map((id) => ({
    id,
    ...CAPABILITY_DETAILS[id],
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
  const models = getCapabilityModels().map((model) => ({
    ...model,
    configured: model.provider === "openai" ? true : Boolean(dashscopeClient) && (!ids || ids.has(model.id)),
  }));
  const capabilities = CAPABILITY_IDS.map((id) => ({
    id,
    ...CAPABILITY_DETAILS[id],
    status:
      CAPABILITY_DETAILS[id].status === "available" &&
      (id === "chat" || id === "reasoning" || id === "vision" || !ids ||
        models.some((model) => model.capabilities.includes(id) && model.configured))
        ? "available" as const
        : CAPABILITY_DETAILS[id].status,
    models: models.filter((model) => model.capabilities.includes(id)).map((model) => model.id),
  }));
  return { capabilities, models };
}

export interface GeneratedAsset {
  buffer: Buffer;
  filename: string;
  mimeType: string;
  size: number;
  capability: "image-generate" | "image-edit";
}

export interface SpecialistToolResult {
  ok: boolean;
  capability: "image-generate" | "image-edit" | "speech-to-text";
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
});

const imageEditArgs = z.object({
  imageName: z.string().trim().min(1).max(255),
  prompt: z.string().trim().min(1).max(4_000),
});

const transcribeArgs = z.object({
  attachmentName: z.string().trim().min(1).max(255),
});

export function getSpecialistTools(context: SpecialistToolContext): SpecialistToolDefinition[] {
  if (!dashscopeClient) return [];
  const tools: SpecialistToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "Alibaba Model Studioで画像を1枚生成します。画像が必要な場合だけ使い、同じターンで一度だけ呼び出してください。",
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
    },
  ];
  if (context.imageAttachments?.length) {
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
  if (context.audioAttachments?.length) {
    tools.push({
      type: "function",
      function: {
        name: "transcribe_audio",
        description:
          "添付音声をAlibaba Model Studioで文字起こしします。音声の内容確認が必要な場合だけ使ってください。",
        parameters: {
          type: "object",
          properties: {
            attachmentName: { type: "string", minLength: 1, maxLength: 255 },
          },
          required: ["attachmentName"],
          additionalProperties: false,
        },
      },
    });
  }
  return tools;
}

function decodeImageDataUrl(dataUrl: string): { mime: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/]*={0,2})$/i);
  if (!match) throw new Error("編集対象の画像形式が不正です");
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
    throw new Error("編集対象の画像サイズが上限を超えています");
  }
  return { mime: match[1].toLowerCase(), buffer };
}

function dataUrlToBuffer(value: string): Buffer | null {
  const match = value.match(/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/i);
  return match ? Buffer.from(match[1], "base64") : null;
}

async function imageResponseToAsset(
  response: unknown,
  capability: "image-generate" | "image-edit",
  signal?: AbortSignal,
): Promise<GeneratedAsset> {
  const body = response as {
    output?: { results?: { url?: unknown }[]; result_url?: unknown };
    data?: { url?: unknown; b64_json?: unknown }[];
  };
  const first = body.output?.results?.[0]?.url;
  const legacy = body.output?.result_url;
  const openAiData = body.data?.[0];
  const imageUrl =
    typeof first === "string" ? first : typeof legacy === "string" ? legacy : undefined;
  let buffer = typeof openAiData?.b64_json === "string"
    ? Buffer.from(openAiData.b64_json, "base64")
    : typeof openAiData?.url === "string"
      ? dataUrlToBuffer(openAiData.url)
      : null;
  if (!buffer && imageUrl) {
    if (imageUrl.startsWith("data:")) {
      buffer = dataUrlToBuffer(imageUrl);
    } else {
      const parsedUrl = new URL(imageUrl);
      if (
        parsedUrl.protocol !== "https:" ||
        !(
          parsedUrl.hostname === "aliyuncs.com" ||
          parsedUrl.hostname.endsWith(".aliyuncs.com")
        )
      ) {
        throw new Error("画像モデルが許可されていない取得先を返しました");
      }
      const imageResponse = await fetch(parsedUrl, { signal });
      if (!imageResponse.ok) throw new Error("生成画像の取得に失敗しました");
      buffer = Buffer.from(await imageResponse.arrayBuffer());
    }
  }
  if (!buffer) throw new Error("画像モデルが安全に取得できる画像データを返しませんでした");
  if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
    throw new Error("生成画像のサイズが上限を超えています");
  }
  return {
    buffer,
    filename: capability === "image-edit" ? "edited-image.png" : "generated-image.png",
    mimeType: "image/png",
    size: buffer.length,
    capability,
  };
}

function dashScopeEndpoint(path: string): string {
  const configured = process.env.DASHSCOPE_BASE_URL?.trim() ||
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1";
  const base = new URL(configured);
  return `${base.origin}${path}`;
}

async function callDashScopeImageApi(
  body: Record<string, unknown>,
  path: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const apiKey = process.env.DASHSCOPE_API_KEY;
  if (!apiKey) throw new Error("Alibaba Model Studioが設定されていません");
  const response = await fetch(dashScopeEndpoint(path), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof payload.message === "string" ? payload.message : "Alibaba画像APIの呼び出しに失敗しました";
    throw new Error(message.slice(0, 500));
  }
  return payload;
}

async function generateImage(
  prompt: string,
  size: "1024x1024" | "1536x1024" | "1024x1536",
  signal?: AbortSignal,
): Promise<GeneratedAsset> {
  if (!dashscopeClient) throw new Error("Alibaba Model Studioが設定されていません");
  const response = await callDashScopeImageApi(
    {
      model: "qwen-image-plus",
      input: { prompt },
      parameters: {
        size: size.replace("x", "*"),
        n: 1,
        watermark: false,
        prompt_extend: true,
      },
    },
    "/api/v1/services/aigc/image-generation/generation",
    signal,
  );
  return imageResponseToAsset(response, "image-generate", signal);
}

async function editImage(
  image: { name: string; content: string },
  prompt: string,
  signal?: AbortSignal,
): Promise<GeneratedAsset> {
  if (!dashscopeClient) throw new Error("Alibaba Model Studioが設定されていません");
  decodeImageDataUrl(image.content);
  const response = await callDashScopeImageApi(
    {
      model: "qwen-image-2.0-pro",
      input: {
        messages: [{
          role: "user",
          content: [{ image: image.content }, { text: prompt }],
        }],
      },
      parameters: { n: 1, watermark: false, prompt_extend: true },
    },
    "/api/v1/services/aigc/multimodal-generation/generation",
    signal,
  );
  return imageResponseToAsset(response, "image-edit", signal);
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
      const asset = await generateImage(args.prompt, args.size ?? "1024x1024", context.signal);
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
      const asset = await editImage(image, args.prompt, context.signal);
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
      });
      return {
        ok: true,
        capability: "speech-to-text",
        summary: "音声を文字起こししました。",
        text: text || "音声から認識できる内容が見つかりませんでした。",
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
            : "image-generate",
      summary: error instanceof Error ? error.message : "専門能力の実行に失敗しました",
    };
  }
}