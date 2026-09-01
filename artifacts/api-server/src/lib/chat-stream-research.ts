import type OpenAI from "openai";
import type { ModelProvider, ReasoningLevel } from "./ai-clients";
import { mergeResearchEvidence, type FactualitySource } from "./factuality";
import { logger, safeFailureFields } from "./logger";
import { shouldSynthesizeResearchAnswer } from "./chat-stream-policy";
import type {
  StreamEventEmitter,
  StreamModelTextFn,
  StreamModelTool,
  WithTimeoutFn,
} from "./chat-stream-stage-types";
import {
  executeSpecialistTool,
  isEvidenceTool,
  isSpecialistMutationTool,
  type SpecialistToolCall,
  type SpecialistToolResult,
} from "./specialist-capabilities";

const MAX_RESEARCH_STEPS = 6;
const RESEARCH_STEP_TIMEOUT_MS = 30_000;
const RESEARCH_FINAL_SYNTHESIS_SYSTEM_PROMPT = `検索ツールの実行段階は終了しました。追加のツールは呼び出せません。
これまでに取得したツール結果だけを使い、ユーザーの質問への最終回答を今すぐ完成させてください。検索するという宣言や作業予定は書かず、根拠番号を引用し、不明点は不明と明示してください。`;
const RESEARCH_FINAL_ANSWER_FALLBACK =
  "検索結果は取得できましたが、モデルが最終回答を生成できませんでした。条件を少し絞って、もう一度お試しください。";

export function partitionSpecialistToolCalls(calls: SpecialistToolCall[]): {
  researchCalls: SpecialistToolCall[];
  nonResearchCalls: SpecialistToolCall[];
} {
  const researchCalls = calls.filter(isEvidenceTool);
  return {
    researchCalls,
    nonResearchCalls: calls.filter(
      (call) =>
        !isEvidenceTool(call) &&
        !(researchCalls.length > 0 && isSpecialistMutationTool(call)),
    ),
  };
}

function appendDeferredCalls(
  target: SpecialistToolCall[],
  calls: SpecialistToolCall[],
): void {
  for (const call of calls) {
    if (
      !isEvidenceTool(call) &&
      !isSpecialistMutationTool(call) &&
      !target.includes(call)
    ) {
      target.push(call);
    }
  }
}

function emitModelDelta(
  emit: StreamEventEmitter,
  clientGone: () => boolean,
  signal: AbortSignal,
  text: string,
  kind: "content" | "reasoning",
): void {
  if (clientGone()) return;
  if (kind === "reasoning") {
    if (!signal.aborted) emit({ status: "thinking" });
  } else {
    emit({ content: text, status: "generating" });
  }
}

export interface ResearchLoopResult {
  responseText: string;
  sources: FactualitySource[];
  evidenceParts: string[];
  deferredCalls: SpecialistToolCall[];
  executedToolCount: number;
}

/** Run the bounded research loop and append tool messages to `messages`. */
export async function runResearchLoop(args: {
  client: OpenAI;
  provider: ModelProvider;
  modelId: string;
  reasoningLevel: ReasoningLevel;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools: StreamModelTool[];
  initialCalls: SpecialistToolCall[];
  hasPendingNonResearchCalls: boolean;
  imageAttachments?: { name: string; content: string; bytes: number }[];
  audioAttachments?: { name: string; buffer: Buffer; mime: string }[];
  userId?: string;
  memoryEnabled?: boolean;
  signal: AbortSignal;
  clientGone: () => boolean;
  emit: StreamEventEmitter;
  streamText: StreamModelTextFn;
  withTimeout: WithTimeoutFn;
}): Promise<ResearchLoopResult> {
  const sources: FactualitySource[] = [];
  const evidenceParts: string[] = [];
  const deferredCalls: SpecialistToolCall[] = [];
  let executedToolCount = 0;
  let continuationText = "";
  let responseText = "";
  let hitStepLimitWithPendingResearch = false;
  let researchStep = 0;
  let currentResearchCalls = args.initialCalls;

  while (
    currentResearchCalls.length > 0 &&
    researchStep < MAX_RESEARCH_STEPS &&
    !args.signal.aborted
  ) {
    researchStep += 1;
    if (!args.clientGone()) {
      args.emit({
        status: "researching",
        step: researchStep,
        maxSteps: MAX_RESEARCH_STEPS,
        toolCount: currentResearchCalls.length,
      });
    }

    const toolResults: {
      call: SpecialistToolCall;
      result: Awaited<ReturnType<typeof executeSpecialistTool>>;
    }[] = [];
    for (const toolCall of currentResearchCalls) {
      if (args.clientGone() || args.signal.aborted) break;
      if (!args.clientGone()) {
        args.emit({
          status: "specialist",
          capability: toolCall.name,
          phase: "running",
        });
      }
      let result = await (async () => {
        try {
          return await args.withTimeout(
            (signal) =>
              executeSpecialistTool(toolCall, {
                imageAttachments: args.imageAttachments,
                audioAttachments: args.audioAttachments,
                userId: args.userId,
                memoryEnabled: args.memoryEnabled,
                signal,
              }),
            RESEARCH_STEP_TIMEOUT_MS,
            "Research step",
            args.signal,
          );
        } catch (error) {
          if (args.signal.aborted) throw error;
          logger.warn(
            safeFailureFields(error, "chat-stream", "RESEARCH_TOOL_FAILED"),
            `Research tool ${toolCall.name} failed; returning error to model`,
          );
          return {
            ok: false,
            capability: toolCall.name as SpecialistToolResult["capability"],
            summary:
              error instanceof Error
                ? error.message
                : "ツール実行中にエラーが発生しました",
            text: "",
          } satisfies SpecialistToolResult;
        }
      })();
      executedToolCount += 1;
      if (result.sources?.length) {
        const merged = mergeResearchEvidence({
          text: result.text ?? "",
          sources: result.sources,
          accumulatedSources: sources,
        });
        sources.splice(0, sources.length, ...merged.sources);
        result = { ...result, text: merged.text };
      }
      if (result.text?.trim()) evidenceParts.push(result.text);
      toolResults.push({ call: toolCall, result });
      if (!args.clientGone()) {
        args.emit({
          status: result.ok ? "specialist" : "specialist_warning",
          capability: result.capability,
          phase: result.ok ? "completed" : "failed",
          message: result.summary,
        });
      }
    }

    args.messages.push({
      role: "assistant",
      content: null,
      tool_calls: toolResults.map(({ call }) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    for (const { call, result } of toolResults) {
      args.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify({
          ok: result.ok,
          capability: result.capability,
          summary: result.summary,
          text: result.text,
        }),
      });
    }

    if (sources.length > 0 && !args.clientGone()) args.emit({ sources });

    const nextRoundCalls: SpecialistToolCall[] = [];
    const continuation = await args.streamText({
      client: args.client,
      provider: args.provider,
      modelId: args.modelId,
      reasoningLevel: args.reasoningLevel,
      messages: args.messages,
      tools: args.tools,
      onToolCalls: (calls) => nextRoundCalls.push(...calls),
      onDelta: (text, kind) =>
        emitModelDelta(args.emit, args.clientGone, args.signal, text, kind),
      shouldStop: () => args.clientGone() || args.signal.aborted,
      signal: args.signal,
    });
    responseText += continuation;
    continuationText += continuation;

    const nextResearchCalls = nextRoundCalls.filter(isEvidenceTool);
    if (nextResearchCalls.length > 0 && researchStep < MAX_RESEARCH_STEPS) {
      currentResearchCalls = nextResearchCalls;
      appendDeferredCalls(deferredCalls, nextRoundCalls);
      continue;
    }

    if (nextResearchCalls.length > 0 && researchStep >= MAX_RESEARCH_STEPS) {
      hitStepLimitWithPendingResearch = true;
    }
    if (nextRoundCalls.some((call) => !isEvidenceTool(call))) {
      appendDeferredCalls(deferredCalls, nextRoundCalls);
    }
    break;
  }

  if (
    !args.hasPendingNonResearchCalls &&
    deferredCalls.length === 0 &&
    shouldSynthesizeResearchAnswer({
      executedToolCount,
      continuationText,
      hitStepLimitWithPendingResearch,
    }) &&
    !args.signal.aborted
  ) {
    args.messages.push({
      role: "system",
      content: RESEARCH_FINAL_SYNTHESIS_SYSTEM_PROMPT,
    });
    const finalAnswer = await args.streamText({
      client: args.client,
      provider: args.provider,
      modelId: args.modelId,
      reasoningLevel: args.reasoningLevel,
      messages: args.messages,
      onDelta: (text, kind) =>
        emitModelDelta(args.emit, args.clientGone, args.signal, text, kind),
      shouldStop: () => args.clientGone() || args.signal.aborted,
      signal: args.signal,
    });
    if (finalAnswer.trim()) {
      responseText += finalAnswer;
    } else if (!args.clientGone()) {
      const fallback = `\n\n${RESEARCH_FINAL_ANSWER_FALLBACK}`;
      responseText += fallback;
      args.emit({ content: fallback, status: "generating" });
    }
  }

  return {
    responseText,
    sources,
    evidenceParts,
    deferredCalls,
    executedToolCount,
  };
}
