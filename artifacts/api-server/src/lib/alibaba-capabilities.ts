export type AlibabaCapability =
  | "chat"
  | "reasoning"
  | "vision"
  | "image.generate"
  | "image.edit"
  | "audio.asr"
  | "audio.tts"
  | "audio.realtime"
  | "video.t2v"
  | "video.i2v"
  | "video.r2v";

export type AlibabaTransport =
  | "openai-chat"
  | "token-plan-multimodal"
  | "dashscope-http"
  | "dashscope-websocket"
  | "dashscope-async-video";

export type AlibabaModelKind = "chat" | "image" | "audio" | "video";

export interface AlibabaModelSpec {
  id: string;
  label: string;
  kind: AlibabaModelKind;
  capabilities: readonly AlibabaCapability[];
  transport: AlibabaTransport;
  description: string;
}

/**
 * The known Model Studio Token Plan catalog. Runtime /models discovery can
 * further narrow configured chat models, but specialist models remain in this
 * registry and are never exposed as normal chat choices.
 */
export const ALIBABA_MODEL_CATALOG = [
  {
    id: "qwen3.8-max",
    label: "Qwen3.8 Max",
    kind: "chat",
    capabilities: ["chat", "reasoning", "vision"],
    transport: "openai-chat",
    description: "Alibaba最高性能・画像理解",
  },
  {
    id: "qwen3.8-flash",
    label: "Qwen3.8 Flash",
    kind: "chat",
    capabilities: ["chat", "reasoning", "vision"],
    transport: "openai-chat",
    description: "高速・画像理解",
  },
  {
    id: "qwen3.7-plus",
    label: "Qwen3.7 Plus",
    kind: "chat",
    capabilities: ["chat", "reasoning", "vision"],
    transport: "openai-chat",
    description: "高速・バランス・画像理解",
  },
  {
    id: "qwen3.7-max",
    label: "Qwen3.7 Max",
    kind: "chat",
    capabilities: ["chat", "reasoning"],
    transport: "openai-chat",
    description: "高性能テキスト推論",
  },
  {
    id: "qwen3.6-flash",
    label: "Qwen3.6 Flash",
    kind: "chat",
    capabilities: ["chat", "reasoning", "vision"],
    transport: "openai-chat",
    description: "最速・低コスト・画像理解",
  },
  {
    id: "deepseek-v4-pro-0813",
    label: "DeepSeek V4 Pro 0813",
    kind: "chat",
    capabilities: ["chat", "reasoning"],
    transport: "openai-chat",
    description: "DeepSeek V4 Pro スナップショット",
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    kind: "chat",
    capabilities: ["chat", "reasoning"],
    transport: "openai-chat",
    description: "推論特化",
  },
  {
    id: "deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731",
    kind: "chat",
    capabilities: ["chat", "reasoning"],
    transport: "openai-chat",
    description: "高速推論スナップショット",
  },
  {
    id: "glm-5.2",
    label: "GLM-5.2",
    kind: "chat",
    capabilities: ["chat", "reasoning"],
    transport: "openai-chat",
    description: "汎用推論",
  },
  {
    id: "qwen-image-3.0-pro",
    label: "Qwen Image 3.0 Pro",
    kind: "image",
    capabilities: ["image.generate", "image.edit"],
    transport: "token-plan-multimodal",
    description: "高品質画像生成・画像編集",
  },
  {
    id: "wan2.7-image",
    label: "Wan 2.7 Image",
    kind: "image",
    capabilities: ["image.generate", "image.edit"],
    transport: "token-plan-multimodal",
    description: "高速画像生成・画像編集",
  },
  {
    id: "wan2.7-image-pro",
    label: "Wan 2.7 Image Pro",
    kind: "image",
    capabilities: ["image.generate", "image.edit"],
    transport: "token-plan-multimodal",
    description: "高品質画像生成・4K T2I",
  },
  {
    id: "qwen-audio-3.0-asr-flash",
    label: "Qwen Audio 3.0 ASR Flash",
    kind: "audio",
    capabilities: ["audio.asr"],
    transport: "dashscope-http",
    description: "音声認識",
  },
  {
    id: "qwen-audio-3.0-tts-plus",
    label: "Qwen Audio 3.0 TTS Plus",
    kind: "audio",
    capabilities: ["audio.tts"],
    transport: "dashscope-websocket",
    description: "高品質音声合成",
  },
  {
    id: "qwen-audio-3.0-realtime-plus",
    label: "Qwen Audio 3.0 Realtime Plus",
    kind: "audio",
    capabilities: ["audio.realtime"],
    transport: "dashscope-websocket",
    description: "リアルタイム音声会話",
  },
  {
    id: "happyhorse-1.1-t2v",
    label: "HappyHorse 1.1 T2V",
    kind: "video",
    capabilities: ["video.t2v"],
    transport: "dashscope-async-video",
    description: "テキストから動画生成",
  },
  {
    id: "happyhorse-1.1-i2v",
    label: "HappyHorse 1.1 I2V",
    kind: "video",
    capabilities: ["video.i2v"],
    transport: "dashscope-async-video",
    description: "画像から動画生成",
  },
  {
    id: "happyhorse-1.1-r2v",
    label: "HappyHorse 1.1 R2V",
    kind: "video",
    capabilities: ["video.r2v"],
    transport: "dashscope-async-video",
    description: "参照素材から動画生成",
  },
] as const satisfies readonly AlibabaModelSpec[];

export type AlibabaModelId = (typeof ALIBABA_MODEL_CATALOG)[number]["id"];

export const ALIBABA_CHAT_MODELS = ALIBABA_MODEL_CATALOG.filter(
  (model) => model.kind === "chat",
);

export const ALIBABA_CAPABILITY_DEFAULTS = {
  "image.generate": "qwen-image-3.0-pro",
  "image.edit": "qwen-image-3.0-pro",
  "audio.asr": "paraformer-v2",
  "audio.tts": "qwen-audio-3.0-tts-plus",
  "audio.realtime": "qwen-audio-3.0-realtime-plus",
  "video.t2v": "happyhorse-1.1-t2v",
  "video.i2v": "happyhorse-1.1-i2v",
  "video.r2v": "happyhorse-1.1-r2v",
} as const satisfies Partial<Record<AlibabaCapability, AlibabaModelId | "paraformer-v2">>;

export function getAlibabaModel(modelId: string): AlibabaModelSpec | undefined {
  return ALIBABA_MODEL_CATALOG.find((model) => model.id === modelId);
}

export function modelHasAlibabaCapability(
  modelId: string,
  capability: AlibabaCapability,
): boolean {
  if (modelId === "paraformer-v2" && capability === "audio.asr") return true;
  return getAlibabaModel(modelId)?.capabilities.includes(capability) ?? false;
}

export function modelsForAlibabaCapability(
  capability: AlibabaCapability,
): AlibabaModelSpec[] {
  return ALIBABA_MODEL_CATALOG.filter((model) =>
    (model.capabilities as readonly AlibabaCapability[]).includes(capability),
  );
}