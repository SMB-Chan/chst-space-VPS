import type OpenAI from "openai";
import type { ModelProvider, ReasoningLevel } from "./ai-clients";
import type { SpecialistToolCall } from "./specialist-capabilities";

export interface StreamModelTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamModelUsage {
  modelId: string;
  promptTokens: number;
  completionTokens: number;
}

export interface StreamModelTextInput {
  client: OpenAI;
  provider: ModelProvider;
  modelId: string;
  reasoningLevel: ReasoningLevel;
  maxOutputTokens?: number;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools?: StreamModelTool[];
  onToolCalls?: (calls: SpecialistToolCall[]) => void;
  onDelta: (text: string, kind: "content" | "reasoning") => void;
  /** Reported once per call with provider usage when available, else an estimate. */
  onUsage?: (usage: StreamModelUsage) => void;
  shouldStop: () => boolean;
  signal?: AbortSignal;
}

export type StreamModelTextFn = (args: StreamModelTextInput) => Promise<string>;

export type WithTimeoutFn = <T>(
  createPromise: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
  parentSignal?: AbortSignal,
) => Promise<T>;

export type StreamEventEmitter = (event: Record<string, unknown>) => void;
