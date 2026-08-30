import OpenAI from "openai";
import { logger } from "./logger";
import { createLlmTimeContextFetch } from "./llm-time-context";
import {
  createAlibabaTokenPlanQuotaGuardedFetch,
  resolveAlibabaDashScopeBaseUrl,
} from "./alibaba-token-plan-usage";

// Replit-managed OpenAI proxy
if (!process.env.AI_INTEGRATIONS_OPENAI_BASE_URL) {
  throw new Error("AI_INTEGRATIONS_OPENAI_BASE_URL must be set.");
}
if (!process.env.AI_INTEGRATIONS_OPENAI_API_KEY) {
  throw new Error("AI_INTEGRATIONS_OPENAI_API_KEY must be set.");
}

// Every OpenAI-compatible /chat/completions request gets a fresh, authoritative
// Asia/Tokyo timestamp immediately before transport. Non-chat endpoints pass
// through unchanged.
const llmFetch = createLlmTimeContextFetch();

export const openaiClient = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  fetch: llmFetch,
});

// DashScope (Alibaba Cloud) — OpenAI-compatible endpoint
let dashscopeClient: OpenAI | null = null;

if (process.env.DASHSCOPE_API_KEY) {
  const dashscopeBaseUrl = resolveAlibabaDashScopeBaseUrl(process.env);
  dashscopeClient = new OpenAI({
    apiKey: process.env.DASHSCOPE_API_KEY,
    baseURL: dashscopeBaseUrl,
    // For Personal Token Plan keys, the wrapper can query Alibaba's official
    // console quota endpoint before a high-cost chat request. It is a no-op
    // for ordinary Model Studio keys or when console telemetry is unavailable.
    fetch: createAlibabaTokenPlanQuotaGuardedFetch(llmFetch),
  });
  logger.info("DashScope client initialized");
} else {
  logger.warn("DASHSCOPE_API_KEY not set — Qwen models unavailable");
}

export { dashscopeClient };

export type ModelProvider = "openai" | "dashscope";
export type ReasoningKind = "none" | "openai" | "dashscope";
export type ReasoningLevel = "off" | "low" | "medium" | "high";

export const AVAILABLE_MODELS = [
  // OpenAI models (via Replit AI Integrations)
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", provider: "openai" as ModelProvider, description: "高性能・汎用", supportsVision: true, supportsReasoning: true, reasoning: "openai" as ReasoningKind },
  { id: "gpt-5.6-luna",  label: "GPT-5.6 Luna",  provider: "openai" as ModelProvider, description: "高速・低コスト", supportsVision: true, supportsReasoning: true, reasoning: "openai" as ReasoningKind },
  { id: "o4-mini",       label: "o4-mini",        provider: "openai" as ModelProvider, description: "高度な推論", supportsVision: true, supportsReasoning: true, reasoning: "openai" as ReasoningKind },
  // Alibaba Cloud Model Studio (Token Plan endpoint)
  // Qwen 3.6/3.7 and GLM 5.2 enable thinking by default — always send enable_thinking explicitly.
  { id: "qwen3.8-max",             label: "Qwen3.8 Max",             provider: "dashscope" as ModelProvider, description: "Alibaba最高性能", supportsVision: true,  supportsReasoning: true, reasoning: "dashscope" as ReasoningKind },
  { id: "qwen3.8-flash",           label: "Qwen3.8 Flash",           provider: "dashscope" as ModelProvider, description: "高速・画像理解", supportsVision: true,  supportsReasoning: true, reasoning: "dashscope" as ReasoningKind },
  { id: "qwen3.7-plus",            label: "Qwen3.7 Plus",            provider: "dashscope" as ModelProvider, description: "高速・バランス", supportsVision: true,  supportsReasoning: true, reasoning: "dashscope" as ReasoningKind },
  { id: "qwen3.7-max",             label: "Qwen3.7 Max",             provider: "dashscope" as ModelProvider, description: "高性能テキスト推論", supportsVision: false, supportsReasoning: true, reasoning: "dashscope" as ReasoningKind },
  { id: "qwen3.6-flash",           label: "Qwen3.6 Flash",           provider: "dashscope" as ModelProvider, description: "最速・低コスト", supportsVision: true,  supportsReasoning: true, reasoning: "dashscope" as ReasoningKind },
  { id: "deepseek-v4-pro-0813",    label: "DeepSeek V4 Pro 0813",   provider: "dashscope" as ModelProvider, description: "推論特化スナップショット", supportsVision: false, supportsReasoning: true, reasoning: "dashscope" as ReasoningKind },
  { id: "deepseek-v4-pro",         label: "DeepSeek V4 Pro",         provider: "dashscope" as ModelProvider, description: "推論特化", supportsVision: false, supportsReasoning: true, reasoning: "dashscope" as ReasoningKind },
  { id: "deepseek-v4-flash-0731",  label: "DeepSeek V4 Flash 0731",  provider: "dashscope" as ModelProvider, description: "高速推論スナップショット", supportsVision: false, supportsReasoning: true, reasoning: "dashscope" as ReasoningKind },
  { id: "glm-5.2",                 label: "GLM-5.2",                 provider: "dashscope" as ModelProvider, description: "汎用", supportsVision: false, supportsReasoning: true, reasoning: "dashscope" as ReasoningKind },
] as const;

export type ModelId = typeof AVAILABLE_MODELS[number]["id"];

export const DEFAULT_MODEL: ModelId = AVAILABLE_MODELS[0].id;

export const VISION_MODEL_IDS = new Set<string>(
  AVAILABLE_MODELS.filter((m) => m.supportsVision).map((m) => m.id),
);

export function modelSupportsVision(modelId: string): boolean {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  return model ? model.supportsVision : false;
}

export function getModelLabel(modelId: string): string {
  return AVAILABLE_MODELS.find((m) => m.id === modelId)?.label ?? modelId;
}

export function parseReasoningLevel(raw: unknown): ReasoningLevel {
  if (raw === "off" || raw === "low" || raw === "medium" || raw === "high") return raw;
  return "medium";
}

const THINKING_BUDGET: Record<Exclude<ReasoningLevel, "off">, number> = {
  low: 1024,
  medium: 4096,
  high: 8192,
};

/**
 * Provider-specific generation params: token cap, incremental DashScope
 * streaming, and reasoning / thinking level.
 */
export function applyGenerationParams(
  opts: Record<string, unknown>,
  modelId: string,
  provider: ModelProvider,
  level: ReasoningLevel,
): void {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  if (provider === "openai") {
    opts.max_completion_tokens = 8192;
    // Only o-series reliably accepts reasoning_effort on the Replit proxy.
    // Sending it to gpt-5.6-* returns 400 Unsupported parameter.
    if (model?.reasoning === "openai" && modelId.startsWith("o")) {
      opts.reasoning_effort = level === "off" ? "low" : level;
    }
    return;
  }

  opts.max_tokens = 8192;
  const extra: Record<string, unknown> = { incremental_output: true };
  if (model?.reasoning === "dashscope") {
    extra.enable_thinking = level !== "off";
    if (level !== "off") {
      if (modelId.startsWith("qwen3.8")) {
        extra.reasoning_effort = level === "high" ? "xhigh" : level;
      } else {
        extra.thinking_budget = THINKING_BUDGET[level];
      }
    }
  }
  opts.extra_body = extra;
}

export function applySafeGenerationParams(
  opts: Record<string, unknown>,
  provider: ModelProvider,
): void {
  delete opts.reasoning_effort;
  delete opts.extra_body;
  if (provider === "openai") {
    opts.max_completion_tokens = 8192;
    delete opts.max_tokens;
  } else {
    opts.max_tokens = 8192;
    delete opts.max_completion_tokens;
    opts.extra_body = { incremental_output: true };
  }
}

export function isUnsupportedGenerationParam(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  const msg = err instanceof Error ? err.message : String(err);
  if (status != null && status !== 400) return false;
  return /unsupported parameter|unknown parameter|unrecognized|invalid.?request|extra_body|reasoning_effort|enable_thinking|thinking_budget|incremental_output/i.test(
    msg,
  );
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
