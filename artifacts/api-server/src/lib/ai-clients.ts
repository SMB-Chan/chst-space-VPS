import OpenAI from "openai";
import { logger } from "./logger";

// Replit-managed OpenAI proxy
if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  throw new Error("AI_INTEGRATIONS_OPENAI_BASE_URL must be set.");
}
if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY must be set.");
}

export const openaiClient = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

// DashScope (Alibaba Cloud) — OpenAI-compatible endpoint
let dashscopeClient: OpenAI | null = null;

const DASHSCOPE_BASE_URL =
  process.env.DASHSCOPE_BASE_URL ??
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

if (process.env.DASHSCOPE_API_KEY) {
  dashscopeClient = new OpenAI({
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseURL: DASHSCOPE_BASE_URL,
  });
  logger.info("DashScope client initialized");
} else {
  logger.warn("DASHSCOPE_API_KEY not set — Qwen models unavailable");
}

export { dashscopeClient };

export type ModelProvider = "openai" | "dashscope";

export const AVAILABLE_MODELS = [
  // OpenAI models (via Replit AI Integrations)
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai" as ModelProvider, description: "高性能・汎用", supportsVision: true },
  { id: "gpt-5.6-luna",  label: "GPT-5.6 Luna",  provider: "openai" as ModelProvider, description: "高速・低コスト", supportsVision: true },
  { id: "o4-mini",       label: "o4-mini",        provider: "openai" as ModelProvider, description: "高度な推論", supportsVision: true },
  // Alibaba Cloud Model Studio (Token Plan endpoint)
  { id: "qwen3.8-max",           label: "Qwen3.8 Max",       provider: "dashscope" as ModelProvider, description: "Alibaba最高性能", supportsVision: true },
  { id: "qwen3.7-plus",          label: "Qwen3.7 Plus",      provider: "dashscope" as ModelProvider, description: "高速・バランス", supportsVision: true },
  { id: "qwen3.6-flash",         label: "Qwen3.6 Flash",     provider: "dashscope" as ModelProvider, description: "最速・低コスト", supportsVision: true },
  { id: "deepseek-v4-pro",       label: "DeepSeek V4 Pro",   provider: "dashscope" as ModelProvider, description: "推論特化", supportsVision: false },
  { id: "glm-5.2",               label: "GLM-5.2",           provider: "dashscope" as ModelProvider, description: "汎用", supportsVision: false },
] as const;

export type ModelId = typeof AVAILABLE_MODELS[number]["id"];

export function modelSupportsVision(modelId: string): boolean {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  return model ? model.supportsVision : false;
}

export function getModelLabel(modelId: string): string {
  return AVAILABLE_MODELS.find((m) => m.id === modelId)?.label ?? modelId;
}

export function getClientForModel(modelId: string): { client: OpenAI; provider: ModelProvider } {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (!model) {
    throw new Error(`未対応のモデルです: ${modelId}`);
  }
  if (model.provider === "dashscope") {
    if (!dashscopeClient) {
      throw new Error("DashScope APIキーが設定されていません。DASHSCOPE_API_KEY を確認してください。");
    }
    return { client: dashscopeClient, provider: "dashscope" };
  }
  return { client: openaiClient, provider: "openai" };
}
