import OpenAI from "openai";
import { logger } from "./logger";
import { createLlmTimeContextFetch } from "./llm-time-context";
import {
  createAlibabaTokenPlanQuotaGuardedFetch,
  resolveAlibabaDashScopeBaseUrl,
} from "./alibaba-token-plan-usage";
import {
  type CircuitBreaker,
  CircuitBreakerOpenError,
  getOrCreateCircuitBreaker,
} from "./circuit-breaker";

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

// OpenRouter — OpenAI-compatible aggregator. Optional: chat models only.
// A dedicated key with a spend limit (see .env.example) is the hard budget
// cap; openrouter-budget.ts watches that limit and hides the models when
// the allowance is nearly spent.
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

let openrouterClient: OpenAI | null = null;

if (process.env.OPENROUTER_API_KEY?.trim()) {
  openrouterClient = new OpenAI({
    apiKey: process.env.OPENROUTER_API_KEY.trim(),
    baseURL: OPENROUTER_BASE_URL,
    fetch: llmFetch,
    defaultHeaders: {
      // OpenRouter attribution headers (optional but recommended).
      "HTTP-Referer":
        process.env.APP_PUBLIC_URL?.trim() || "https://chat-smb.replit.app",
      "X-Title": "Chat Space",
    },
  });
  logger.info("OpenRouter client initialized");
} else {
  logger.warn("OPENROUTER_API_KEY not set — OpenRouter models unavailable");
}

export { openrouterClient };

export type ModelProvider = "openai" | "dashscope" | "openrouter";
export type ReasoningKind = "none" | "openai" | "dashscope" | "openrouter";
export type ReasoningLevel = "off" | "low" | "medium" | "high";

export interface ChatModel {
  id: string;
  label: string;
  provider: ModelProvider;
  description: string;
  supportsVision: boolean;
  supportsReasoning: boolean;
  reasoning: ReasoningKind;
}

export const AVAILABLE_MODELS = [
  // OpenAI models (via Replit AI Integrations)
  {
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    provider: "openai" as ModelProvider,
    description: "高性能・汎用",
    supportsVision: true,
    supportsReasoning: true,
    reasoning: "openai" as ReasoningKind,
  },
  {
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai" as ModelProvider,
    description: "高速・低コスト",
    supportsVision: true,
    supportsReasoning: true,
    reasoning: "openai" as ReasoningKind,
  },
  {
    id: "o4-mini",
    label: "o4-mini",
    provider: "openai" as ModelProvider,
    description: "高度な推論",
    supportsVision: true,
    supportsReasoning: true,
    reasoning: "openai" as ReasoningKind,
  },
  // Alibaba Cloud Model Studio (Token Plan endpoint)
  // Qwen 3.6/3.7 and GLM 5.2 enable thinking by default — always send enable_thinking explicitly.
  {
    id: "qwen3.8-max",
    label: "Qwen3.8 Max",
    provider: "dashscope" as ModelProvider,
    description: "Alibaba最高性能",
    supportsVision: true,
    supportsReasoning: true,
    reasoning: "dashscope" as ReasoningKind,
  },
  {
    id: "qwen3.8-flash",
    label: "Qwen3.8 Flash",
    provider: "dashscope" as ModelProvider,
    description: "高速・画像理解",
    supportsVision: true,
    supportsReasoning: true,
    reasoning: "dashscope" as ReasoningKind,
  },
  {
    id: "qwen3.7-plus",
    label: "Qwen3.7 Plus",
    provider: "dashscope" as ModelProvider,
    description: "高速・バランス",
    supportsVision: true,
    supportsReasoning: true,
    reasoning: "dashscope" as ReasoningKind,
  },
  {
    id: "qwen3.7-max",
    label: "Qwen3.7 Max",
    provider: "dashscope" as ModelProvider,
    description: "高性能テキスト推論",
    supportsVision: false,
    supportsReasoning: true,
    reasoning: "dashscope" as ReasoningKind,
  },
  {
    id: "qwen3.6-flash",
    label: "Qwen3.6 Flash",
    provider: "dashscope" as ModelProvider,
    description: "最速・低コスト",
    supportsVision: true,
    supportsReasoning: true,
    reasoning: "dashscope" as ReasoningKind,
  },
  {
    id: "deepseek-v4-pro-0813",
    label: "DeepSeek V4 Pro 0813",
    provider: "dashscope" as ModelProvider,
    description: "推論特化スナップショット",
    supportsVision: false,
    supportsReasoning: true,
    reasoning: "dashscope" as ReasoningKind,
  },
  {
    id: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "dashscope" as ModelProvider,
    description: "推論特化",
    supportsVision: false,
    supportsReasoning: true,
    reasoning: "dashscope" as ReasoningKind,
  },
  {
    id: "deepseek-v4-flash-0731",
    label: "DeepSeek V4 Flash 0731",
    provider: "dashscope" as ModelProvider,
    description: "高速推論スナップショット",
    supportsVision: false,
    supportsReasoning: true,
    reasoning: "dashscope" as ReasoningKind,
  },
  {
    id: "glm-5.2",
    label: "GLM-5.2",
    provider: "dashscope" as ModelProvider,
    description: "汎用",
    supportsVision: false,
    supportsReasoning: true,
    reasoning: "dashscope" as ReasoningKind,
  },
  // OpenRouter (openai-compatible aggregator) — budget-tier picks verified
  // against the live catalog. Prices (per 1M tokens, 2026-09):
  //   gemini-2.5-flash-lite $0.10/$0.40 · gpt-4o-mini $0.15/$0.60
  //   deepseek-chat $0.32/$0.89 · qwen3-235b-thinking $0.23/$2.30
  {
    id: "google/gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash-Lite (OR)",
    provider: "openrouter" as ModelProvider,
    description: "最安・1M文脈・画像理解",
    supportsVision: true,
    supportsReasoning: true,
    reasoning: "openrouter" as ReasoningKind,
  },
  {
    id: "openai/gpt-4o-mini",
    label: "GPT-4o mini (OR)",
    provider: "openrouter" as ModelProvider,
    description: "低コスト・画像理解",
    supportsVision: true,
    supportsReasoning: false,
    reasoning: "none" as ReasoningKind,
  },
  {
    id: "deepseek/deepseek-chat",
    label: "DeepSeek V3 Chat (OR)",
    provider: "openrouter" as ModelProvider,
    description: "汎用・テキスト特化",
    supportsVision: false,
    supportsReasoning: false,
    reasoning: "none" as ReasoningKind,
  },
  {
    id: "qwen/qwen3-235b-a22b-thinking-2507",
    label: "Qwen3 235B Thinking (OR)",
    provider: "openrouter" as ModelProvider,
    description: "推論特化（常時思考）",
    supportsVision: false,
    supportsReasoning: true,
    reasoning: "none" as ReasoningKind,
  },
] as const satisfies readonly ChatModel[];

export type ModelId = string;

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
  if (raw === "off" || raw === "low" || raw === "medium" || raw === "high")
    return raw;
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
  const model = AVAILABLE_MODELS.find(
    (m) => m.id === modelId && m.provider === provider,
  );
  if (provider === "openai") {
    opts.max_completion_tokens = 8192;
    // Only o-series reliably accepts reasoning_effort on the Replit proxy.
    // Sending it to gpt-5.6-* returns 400 Unsupported parameter.
    if (model?.reasoning === "openai" && modelId.startsWith("o")) {
      opts.reasoning_effort = level === "off" ? "low" : level;
    }
    return;
  }

  if (provider === "openrouter") {
    opts.max_tokens = 8192;
    // OpenRouter unified reasoning param. Models that reject it are covered
    // by the unsupported-parameter retry (applySafeGenerationParams).
    if (model?.reasoning === "openrouter" && level !== "off") {
      opts.reasoning = { effort: level };
    }
    return;
  }

  opts.max_tokens = 8192;
  // Alibaba's OpenAI-compatible API accepts these vendor parameters at the
  // request-body top level when used through the OpenAI Node.js SDK. The
  // Python SDK's extra_body convention is not interpreted by the Node SDK.
  opts.incremental_output = true;
  if (model?.reasoning === "dashscope") {
    opts.enable_thinking = level !== "off";
    if (level !== "off") {
      if (modelId.startsWith("qwen3.8")) {
        opts.reasoning_effort = level === "high" ? "xhigh" : level;
      } else if (modelId === "deepseek-v4-flash-0731") {
        opts.reasoning_effort =
          level === "low" ? "low" : level === "high" ? "max" : "high";
      } else if (modelId.startsWith("deepseek-v4-")) {
        opts.reasoning_effort = level === "high" ? "max" : "high";
      } else if (modelId.startsWith("glm-")) {
        opts.reasoning_effort = level;
      } else {
        opts.thinking_budget = THINKING_BUDGET[level];
      }
    }
  }
}

export function applySafeGenerationParams(
  opts: Record<string, unknown>,
  provider: ModelProvider,
): void {
  delete opts.reasoning;
  delete opts.reasoning_effort;
  delete opts.enable_thinking;
  delete opts.thinking_budget;
  delete opts.incremental_output;
  delete opts.tool_stream;
  delete opts.extra_body;
  if (provider === "openai") {
    opts.max_completion_tokens = 8192;
    delete opts.max_tokens;
  } else {
    opts.max_tokens = 8192;
    delete opts.max_completion_tokens;
    if (provider === "dashscope") {
      opts.incremental_output = true;
    }
  }
}

/**
 * Retry an otherwise successful-but-empty completion without spending the
 * entire token budget on hidden reasoning again.
 */
export function applyNonReasoningGenerationParams(
  opts: Record<string, unknown>,
  provider: ModelProvider,
): void {
  applySafeGenerationParams(opts, provider);
  if (provider === "dashscope") {
    opts.enable_thinking = false;
  }
}

/** GLM requires tool_stream for function-call deltas in streaming responses. */
export function applyStreamingToolParams(
  opts: Record<string, unknown>,
  modelId: string,
  provider: ModelProvider,
  hasTools: boolean,
): void {
  delete opts.tool_stream;
  if (provider !== "dashscope" || !hasTools || !modelId.startsWith("glm-")) {
    return;
  }
  opts.tool_stream = true;
}

export function isUnsupportedGenerationParam(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  const msg = err instanceof Error ? err.message : String(err);
  if (status != null && status !== 400) return false;
  return /unsupported parameter|unknown parameter|unrecognized|invalid.?request|extra_body|reasoning|enable_thinking|thinking_budget|incremental_output|tool_stream/i.test(
    msg,
  );
}

export function getClientForModel(
  modelId: string,
  explicitProvider?: ModelProvider,
): { client: OpenAI; provider: ModelProvider } {
  const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
  const provider = explicitProvider ?? model?.provider;
  if (!provider) {
    throw new Error(`未対応のモデルです: ${modelId}`);
  }
  if (provider === "dashscope") {
    if (!dashscopeClient) {
      throw new Error(
        "DashScope APIキーが設定されていません。DASHSCOPE_API_KEY を確認してください。",
      );
    }
    return { client: dashscopeClient, provider: "dashscope" };
  }
  if (provider === "openrouter") {
    if (!openrouterClient) {
      throw new Error(
        "OpenRouter APIキーが設定されていません。OPENROUTER_API_KEY を確認してください。",
      );
    }
    return { client: openrouterClient, provider: "openrouter" };
  }
  return { client: openaiClient, provider: "openai" };
}

const openaiCircuit = getOrCreateCircuitBreaker("openai", {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});
const dashscopeCircuit = getOrCreateCircuitBreaker("dashscope", {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});
const openrouterCircuit = getOrCreateCircuitBreaker("openrouter", {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
});

export function getCircuitBreakerForProvider(
  provider: ModelProvider,
): CircuitBreaker {
  if (provider === "dashscope") return dashscopeCircuit;
  if (provider === "openrouter") return openrouterCircuit;
  return openaiCircuit;
}

export async function withCircuitBreaker<T>(
  provider: ModelProvider,
  fn: () => Promise<T>,
): Promise<T> {
  const circuit = getCircuitBreakerForProvider(provider);
  try {
    return await circuit.execute(fn);
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      throw new Error(
        `${provider === "dashscope" ? "DashScope" : "OpenAI"} APIが一時的に利用できません。しばらく待ってから再試行してください。`,
      );
    }
    throw err;
  }
}
