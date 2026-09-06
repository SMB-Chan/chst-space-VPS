import { z } from "zod";
import type OpenAI from "openai";
import {
  AVAILABLE_MODELS,
  dashscopeClient,
  openaiClient,
  type ChatModel,
  type ModelProvider,
} from "./ai-clients";
import {
  isOpenRouterOverBudget,
  openRouterConfigured,
} from "./openrouter-budget";
import { transcribeDashScopeAudio } from "./audio-transcription";
import {
  getMemoryToolDefinitions,
  executeMemoryTool,
  isMemoryTool,
} from "./llm-memory-tools";
import {
  getFormToolDefinitions,
  executeFormTool,
  isFormTool,
} from "./form-tools";
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
  "web-search",
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

const SPECIALIST_MODEL_BASE: CapabilityModel[] = ALIBABA_MODEL_CATALOG.filter(
  (model) => model.kind !== "chat",
).map((model) => ({
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

const CAPABILITY_DETAILS: Record<
  CapabilityId,
  Omit<CapabilityDescriptor, "id" | "models" | "status">
> = {
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
  "web-search": {
    label: "Web検索",
    description: "Webを検索して最新情報・事実確認を行う能力",
  },
};

type ModelDiscoveryCache = {
  client: OpenAI;
  ids: Set<string> | null;
  expiresAt: number;
};

let dashScopeModelCache: ModelDiscoveryCache | null = null;
let openAiModelCache: ModelDiscoveryCache | null = null;

async function readModelIds(
  client: OpenAI | null,
  cache: ModelDiscoveryCache | null,
  setCache: (next: ModelDiscoveryCache) => void,
): Promise<Set<string> | null> {
  if (!client) return null;
  if (cache?.client === client && cache.expiresAt > Date.now()) {
    return cache.ids;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await client.models.list({ signal: controller.signal });
    const ids = new Set(
      response.data.flatMap((item) =>
        typeof item.id === "string" ? [item.id] : [],
      ),
    );
    if (ids.size === 0) throw new Error("model list was empty");
    setCache({ client, ids, expiresAt: Date.now() + 5 * 60_000 });
    return ids;
  } catch {
    setCache({ client, ids: null, expiresAt: Date.now() + 60_000 });
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readDashScopeModelIds(): Promise<Set<string> | null> {
  return readModelIds(dashscopeClient, dashScopeModelCache, (next) => {
    dashScopeModelCache = next;
  });
}

async function readOpenAiModelIds(): Promise<Set<string> | null> {
  return readModelIds(openaiClient, openAiModelCache, (next) => {
    openAiModelCache = next;
  });
}

export function resetModelDiscoveryCache(): void {
  dashScopeModelCache = null;
  openAiModelCache = null;
}

function chatModelCapabilities(model: ChatModel): CapabilityId[] {
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
  if (model.id === "paraformer-v2")
    return regularDashScopeTranscriptionConfigured();
  if (model.id === "qwen-audio-3.0-asr-flash")
    return isAlibabaSpecialistConfigured();
  if (
    model.capabilities.includes("image-generate") ||
    model.capabilities.includes("image-edit")
  ) {
    return isAlibabaSpecialistConfigured();
  }
  if (
    model.id === "qwen-audio-3.0-tts-plus" &&
    model.capabilities.includes("audio-synthesis")
  ) {
    return isAlibabaSpecialistConfigured();
  }
  if (
    model.id === "qwen-audio-3.0-realtime-plus" &&
    model.capabilities.includes("realtime")
  ) {
    return isAlibabaSpecialistConfigured();
  }
  // HappyHorse remains catalog-only in the chat model registry; its dedicated
  // authenticated video-job route checks the specialist transport directly.
  return false;
}

function capabilityStatus(
  id: CapabilityId,
  models: CapabilityModel[],
): "available" | "catalog-only" {
  if (id === "chat" || id === "reasoning" || id === "vision")
    return "available";
  return models.some(
    (model) => model.configured && model.capabilities.includes(id),
  )
    ? "available"
    : "catalog-only";
}

export function getCapabilityModels(): CapabilityModel[] {
  const chatModels = AVAILABLE_MODELS.map((model) => ({
    id: model.id,
    label: model.label,
    provider: model.provider,
    capabilities: chatModelCapabilities(model),
    configured:
      model.provider === "openai" ||
      (model.provider === "openrouter" && openRouterConfigured()) ||
      Boolean(dashscopeClient),
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
    models: models
      .filter((model) => model.capabilities.includes(id))
      .map((model) => model.id),
  }));
  return { capabilities, models };
}

function formatDiscoveredLabel(id: string): string {
  return id
    .split(/[-_.]/)
    .map((part) =>
      part.length <= 2
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}

const CHAT_MODEL_PATTERNS = [
  /^gpt-/i,
  /^o\d/i,
  /^chatgpt-/i,
  /^qwen/i,
  /^deepseek/i,
  /^glm/i,
];

export function mergeAvailableChatModels(
  discoveredModels: ReadonlyArray<{
    provider: ModelProvider;
    ids: ReadonlySet<string> | null;
  }>,
): ChatModel[] {
  const idsByProvider = new Map(
    discoveredModels.map(({ provider, ids }) => [provider, ids]),
  );
  const catalogIds = new Set<string>(AVAILABLE_MODELS.map((m) => m.id));
  const result: ChatModel[] = [];
  const resultIds = new Set<string>();

  for (const model of AVAILABLE_MODELS) {
    const providerIds = idsByProvider.get(model.provider);
    if (!providerIds || providerIds.has(model.id)) {
      result.push(model);
      resultIds.add(model.id);
    }
  }

  const discovered = [
    ...discoveredModels.flatMap(({ provider, ids }) =>
      ids
        ? [...ids].map((id) => ({
            id,
            provider,
          }))
        : [],
    ),
  ];

  for (const { id, provider } of discovered) {
    if (catalogIds.has(id) || resultIds.has(id)) continue;
    if (!CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(id))) continue;
    result.push({
      id,
      label: formatDiscoveredLabel(id),
      provider,
      description: "動的に検出されたモデル",
      supportsVision: false,
      supportsReasoning: false,
      reasoning: "none",
    });
    resultIds.add(id);
  }

  return result;
}

export async function getAvailableChatModels(): Promise<ChatModel[]> {
  const [dashScopeIds, openAiIds, openRouterOverBudget] = await Promise.all([
    readDashScopeModelIds(),
    readOpenAiModelIds(),
    isOpenRouterOverBudget(),
  ]);

  const models = mergeAvailableChatModels([
    { provider: "dashscope", ids: dashScopeIds },
    { provider: "openai", ids: openAiIds },
    // OpenRouter discovery is deliberately disabled: the aggregator lists
    // hundreds of third-party ids whose vision/reasoning capabilities we
    // cannot describe, which would flood the picker with unlabelled entries.
    // The curated catalog is the source of truth for OpenRouter.
    { provider: "openrouter", ids: null },
  ]);
  // Hide the OpenRouter catalog once the key budget is nearly spent.
  return openRouterOverBudget
    ? models.filter((model) => model.provider !== "openrouter")
    : models;
}

export async function getCapabilityRegistryWithAvailability(): Promise<{
  capabilities: CapabilityDescriptor[];
  models: CapabilityModel[];
}> {
  const [ids, openRouterOverBudget] = await Promise.all([
    readDashScopeModelIds(),
    isOpenRouterOverBudget(),
  ]);
  const models = getCapabilityModels().map((model) => {
    if (model.provider === "openai") return { ...model, configured: true };
    if (
      model.provider === "openrouter" &&
      model.capabilities.includes("chat")
    ) {
      return {
        ...model,
        configured: openRouterConfigured() && !openRouterOverBudget,
      };
    }
    if (model.capabilities.includes("chat")) {
      return {
        ...model,
        configured: Boolean(dashscopeClient) && (!ids || ids.has(model.id)),
      };
    }
    return model;
  });
  const capabilities = CAPABILITY_IDS.map((id) => ({
    id,
    ...CAPABILITY_DETAILS[id],
    status: capabilityStatus(id, models),
    models: models
      .filter((model) => model.capabilities.includes(id))
      .map((model) => model.id),
  }));
  return { capabilities, models };
}

export type GeneratedAsset = StoredGeneratedAsset & {
  capability: "image-generate" | "image-edit" | "audio-synthesis";
};

export interface SpecialistToolResult {
  ok: boolean;
  capability:
    | "image-generate"
    | "image-edit"
    | "speech-to-text"
    | "audio-synthesis"
    | "web-search"
    | "fetch-page";
  summary: string;
  text?: string;
  asset?: GeneratedAsset;
  sources?: { title: string; url: string; publishedAt?: string | null }[];
}

export interface SpecialistToolCall {
  id: string;
  name: string;
  arguments: string;
}

const EVIDENCE_TOOL_NAMES = new Set(["web_search", "fetch_page"]);
const READ_ONLY_TOOL_NAMES = new Set(["memory_recall", "analyze_forms"]);
const MUTATION_TOOL_NAMES = new Set([
  "memory_store",
  "memory_update",
  "memory_forget",
  "memory_invalidate",
  "memory_supersede",
]);
const EXTERNAL_ACTION_TOOL_NAMES = new Set(["fill_form"]);

export function isEvidenceTool(call: SpecialistToolCall): boolean {
  return EVIDENCE_TOOL_NAMES.has(call.name);
}

export function isReadOnlySpecialistTool(call: SpecialistToolCall): boolean {
  return READ_ONLY_TOOL_NAMES.has(call.name) || isEvidenceTool(call);
}

export function isSpecialistMutationTool(call: SpecialistToolCall): boolean {
  return MUTATION_TOOL_NAMES.has(call.name);
}

export function isExternalActionTool(call: SpecialistToolCall): boolean {
  return EXTERNAL_ACTION_TOOL_NAMES.has(call.name);
}

export interface SpecialistToolContext {
  imageAttachments?: { name: string; content: string }[];
  audioAttachments?: { name: string; buffer: Buffer; mime: string }[];
  signal?: AbortSignal;
  userId?: string;
  memoryEnabled?: boolean;
  formSubmissionApproved?: boolean;
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

const webSearchArgs = z.object({
  query: z.string().trim().min(1).max(500),
  fetchContent: z.boolean().optional(),
});

const fetchPageArgs = z.object({
  url: z.string().trim().min(1).max(2000),
});

export function getSpecialistTools(
  context: SpecialistToolContext,
): SpecialistToolDefinition[] {
  const specialistConfigured = isAlibabaSpecialistConfigured();
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
            size: {
              type: "string",
              enum: ["1024x1024", "1536x1024", "1024x1536"],
            },
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
  if (
    (specialistConfigured || regularDashScopeTranscriptionConfigured()) &&
    context.audioAttachments?.length
  ) {
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
            modelId: {
              type: "string",
              enum: ["qwen-audio-3.0-asr-flash", "paraformer-v2"],
            },
            languageHints: {
              type: "array",
              maxItems: 4,
              items: { type: "string", minLength: 2, maxLength: 16 },
            },
          },
          required: ["attachmentName"],
          additionalProperties: false,
        },
      },
    });
  }
  tools.push({
    type: "function",
    function: {
      name: "web_search",
      description:
        "Web検索を実行します。最新の情報・事実確認・複数の情報源からの裏付けが必要な場合に使用してください。検索クエリは具体的で対象を絞ったものにしてください。fetchContent=trueで上位結果のページ本文も取得します。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "検索クエリ",
          },
          fetchContent: {
            type: "boolean",
            description:
              "trueの場合、上位結果のページ本文も取得します。重要そうなページの本文をまとめて読みたい場合に指定してください。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  });
  tools.push({
    type: "function",
    function: {
      name: "fetch_page",
      description:
        "指定URLのWebページを取得し、本文テキストを抽出します。検索結果で見つけた重要なページを詳しく読みたい場合に使用してください。",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            minLength: 1,
            maxLength: 2000,
            description: "取得対象のURL (http/https)",
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
  });

  if (context.memoryEnabled && context.userId) {
    tools.push(...getMemoryToolDefinitions());
  }

  // Submission stays unavailable until a route supplies a user-confirmation
  // token. Analysis is read-only and can remain available independently.
  tools.push(
    ...getFormToolDefinitions().filter(
      (tool) =>
        tool.function.name !== "fill_form" ||
        context.formSubmissionApproved === true,
    ),
  );

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
      const image = context.imageAttachments?.find(
        (item) => item.name === args.imageName,
      );
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
      const audio = context.audioAttachments?.find(
        (item) => item.name === args.attachmentName,
      );
      if (!audio) throw new Error("指定された音声添付が見つかりません");
      const text = await transcribeDashScopeAudio(
        {
          buffer: audio.buffer,
          filename: audio.name,
          mime: audio.mime,
          signal: context.signal,
          languageHints: args.languageHints,
        },
        args.modelId,
      );
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
      const asset: GeneratedAsset = {
        ...speech,
        capability: "audio-synthesis",
      };
      return {
        ok: true,
        capability: "audio-synthesis",
        summary: "MP3音声を生成しました。",
        asset,
      };
    }
    if (call.name === "web_search") {
      const args = parseToolArgs(webSearchArgs, call.arguments);
      const { searchWeb, fetchPageText } = await import("./web-search");
      const results = await searchWeb(args.query, context.signal);
      if (results.length === 0) {
        return {
          ok: true,
          capability: "web-search",
          summary: "Web検索で結果が見つかりませんでした。",
          text: "",
        };
      }
      const top = results.slice(0, 5);
      const sources = top.map((r) => ({
        title: r.title,
        url: r.url,
        publishedAt: null as string | null,
      }));
      const snippetLines = top.map(
        (r, i) =>
          `[${i + 1}] ${r.title}\n    URL: ${r.url}\n    概要: ${r.snippet}`,
      );
      if (args.fetchContent) {
        const pages = await Promise.all(
          top.map((r) => fetchPageText(r.url, context.signal)),
        );
        const contentBlocks: string[] = [];
        pages.forEach((page, i) => {
          if (page) {
            sources[i].publishedAt = page.publishedAt ?? null;
            contentBlocks.push(
              `[${i + 1}] ${page.title || top[i].title}\n    URL: ${top[i].url}\n    概要: ${top[i].snippet}\n    本文:\n${page.text}`,
            );
          } else {
            contentBlocks.push(snippetLines[i]);
          }
        });
        return {
          ok: true,
          capability: "web-search",
          summary: `Web検索で${results.length}件の結果を取得し、${contentBlocks.filter((b) => b.includes("本文:")).length}件のページ本文を取得しました。`,
          text: contentBlocks.join("\n\n"),
          sources,
        };
      }
      return {
        ok: true,
        capability: "web-search",
        summary: `Web検索で${results.length}件の結果を取得しました。`,
        text: snippetLines.join("\n\n"),
        sources,
      };
    }
    if (call.name === "fetch_page") {
      const args = parseToolArgs(fetchPageArgs, call.arguments);
      const { fetchPageText } = await import("./web-search");
      const page = await fetchPageText(args.url, context.signal);
      if (!page) {
        return {
          ok: true,
          capability: "fetch-page",
          summary:
            "ページを取得できませんでした（タイムアウト・アクセス拒否・ボット対策など）。",
          text: "",
        };
      }
      return {
        ok: true,
        capability: "fetch-page",
        summary: `ページ「${page.title}」を取得しました。`,
        text: `タイトル: ${page.title}\nURL: ${args.url}${page.publishedAt ? `\n公開日: ${page.publishedAt}` : ""}\n本文:\n${page.text}`,
        sources: [
          {
            title: page.title,
            url: args.url,
            publishedAt: page.publishedAt ?? null,
          },
        ],
      };
    }
    // Memory tools: delegate to the memory tools module
    if (isMemoryTool(call.name)) {
      return executeMemoryTool(call, context);
    }
    // Form tools: delegate to the form tools module
    if (isFormTool(call.name)) {
      return executeFormTool(call, {
        submissionApproved: context.formSubmissionApproved === true,
      });
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
              : call.name === "web_search"
                ? "web-search"
                : call.name === "fetch_page"
                  ? "fetch-page"
                  : "image-generate",
      summary:
        error instanceof Error ? error.message : "専門能力の実行に失敗しました",
    };
  }
}
