import type OpenAI from "openai";
import type { ModelProvider, ReasoningLevel } from "./ai-clients";
import {
  executeCodingTool,
  isCodingTool,
  type CodingToolResult,
} from "./coding-tools";
import {
  CODING_MAX_FILES_PER_TURN,
  persistableCodingTouch,
} from "./coding-mode";
import { logger, safeFailureFields } from "./logger";
import type { SpecialistToolCall } from "./specialist-capabilities";
import type {
  StreamEventEmitter,
  StreamModelTextFn,
  StreamModelTool,
  StreamModelUsage,
  WithTimeoutFn,
} from "./chat-stream-stage-types";

export const CODING_MAX_STEPS = 12;
export const CODING_MAX_TOOL_CALLS = 24;
const CODING_TOOL_TIMEOUT_MS = 15_000;
const CODING_FINAL_PROMPT = `コーディングツールの実行は終了しました。追加のツールは呼び出さないでください。
変更したファイルと理由を短くまとめ、コード全文は貼らないでください。未完了の作業があれば次に何が必要かだけ書いてください。`;

export interface CodingLoopResult {
  responseText: string;
  touches: ReturnType<typeof persistableCodingTouch>[];
  executedToolCount: number;
}

function emitDelta(
  emit: StreamEventEmitter,
  clientGone: () => boolean,
  signal: AbortSignal,
  text: string,
  kind: "content" | "reasoning",
): void {
  if (clientGone()) return;
  if (kind === "reasoning") {
    if (!signal.aborted) emit({ status: "thinking" });
    return;
  }
  emit({ content: text, status: "generating" });
}

function mergeTouch(
  touches: ReturnType<typeof persistableCodingTouch>[],
  touch: ReturnType<typeof persistableCodingTouch>,
): void {
  const index = touches.findIndex((item) => item.path === touch.path);
  if (index >= 0) touches[index] = touch;
  else touches.push(touch);
}

export async function runCodingLoop(args: {
  client: OpenAI;
  provider: ModelProvider;
  modelId: string;
  reasoningLevel: ReasoningLevel;
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  tools: StreamModelTool[];
  initialCalls: SpecialistToolCall[];
  rootDir: string;
  signal: AbortSignal;
  clientGone: () => boolean;
  emit: StreamEventEmitter;
  streamText: StreamModelTextFn;
  withTimeout: WithTimeoutFn;
  onUsage?: (usage: StreamModelUsage) => void;
}): Promise<CodingLoopResult> {
  const touches: ReturnType<typeof persistableCodingTouch>[] = [];
  let currentCalls = args.initialCalls.filter(isCodingTool);
  let executedToolCount = 0;
  let step = 0;
  let responseText = "";
  let hitLimit = false;

  while (
    currentCalls.length > 0 &&
    step < CODING_MAX_STEPS &&
    executedToolCount < CODING_MAX_TOOL_CALLS &&
    !args.signal.aborted
  ) {
    step += 1;
    const remaining = CODING_MAX_TOOL_CALLS - executedToolCount;
    const wave = currentCalls.slice(0, remaining);
    if (wave.length === 0) break;
    if (!args.clientGone()) {
      args.emit({
        status: "coding",
        step,
        maxSteps: CODING_MAX_STEPS,
        toolCount: wave.length,
      });
    }

    const toolResults: {
      call: SpecialistToolCall;
      result: CodingToolResult;
    }[] = [];
    for (const call of wave) {
      if (args.clientGone() || args.signal.aborted) break;
      if (
        (call.name === "code_write" || call.name === "code_edit") &&
        touches.length >= CODING_MAX_FILES_PER_TURN
      ) {
        toolResults.push({
          call,
          result: {
            ok: false,
            name: call.name,
            summary: `1ターンの書き込み上限 (${CODING_MAX_FILES_PER_TURN}) に達しました。`,
          },
        });
        executedToolCount += 1;
        continue;
      }
      if (!args.clientGone()) {
        args.emit({
          status: "specialist",
          capability: call.name,
          phase: "running",
        });
      }
      let result: CodingToolResult;
      try {
        result = await args.withTimeout(
          async () => executeCodingTool(call, args.rootDir),
          CODING_TOOL_TIMEOUT_MS,
          "Coding tool",
          args.signal,
        );
      } catch (error) {
        if (args.signal.aborted) throw error;
        logger.warn(
          safeFailureFields(error, "chat-stream", "CODING_TOOL_FAILED"),
          `Coding tool ${call.name} failed`,
        );
        result = {
          ok: false,
          name: call.name,
          summary:
            error instanceof Error
              ? error.message
              : "ツール実行中にエラーが発生しました。",
        };
      }
      executedToolCount += 1;
      if (result.touch) {
        mergeTouch(touches, result.touch);
        if (!args.clientGone()) args.emit({ filesMeta: touches });
      }
      if (!args.clientGone()) {
        args.emit({
          status: result.ok ? "specialist" : "specialist_warning",
          capability: call.name,
          phase: result.ok ? "completed" : "failed",
          message: result.summary,
        });
      }
      toolResults.push({ call, result });
    }

    args.messages.push({
      role: "assistant",
      content: null,
      ...(args.provider === "xiaomi"
        ? { reasoning_content: toolResults[0]?.call.reasoningContent ?? "" }
        : {}),
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
          summary: result.summary,
          text: result.text,
        }),
      });
    }

    const nextCalls: SpecialistToolCall[] = [];
    const continuation = await args.streamText({
      client: args.client,
      provider: args.provider,
      modelId: args.modelId,
      reasoningLevel: args.reasoningLevel,
      messages: args.messages,
      tools: args.tools,
      onToolCalls: (calls) => nextCalls.push(...calls.filter(isCodingTool)),
      onDelta: (text, kind) =>
        emitDelta(args.emit, args.clientGone, args.signal, text, kind),
      onUsage: args.onUsage,
      shouldStop: () => args.clientGone() || args.signal.aborted,
      signal: args.signal,
    });
    responseText += continuation;
    const remainingAfter = CODING_MAX_TOOL_CALLS - executedToolCount;
    if (nextCalls.length > 0 && step < CODING_MAX_STEPS && remainingAfter > 0) {
      currentCalls = nextCalls.slice(0, remainingAfter);
      continue;
    }
    if (nextCalls.length > 0) hitLimit = true;
    break;
  }

  if (
    (hitLimit || !responseText.trim()) &&
    executedToolCount > 0 &&
    !args.signal.aborted
  ) {
    args.messages.push({ role: "system", content: CODING_FINAL_PROMPT });
    const finalAnswer = await args.streamText({
      client: args.client,
      provider: args.provider,
      modelId: args.modelId,
      reasoningLevel: args.reasoningLevel,
      messages: args.messages,
      onDelta: (text, kind) =>
        emitDelta(args.emit, args.clientGone, args.signal, text, kind),
      onUsage: args.onUsage,
      shouldStop: () => args.clientGone() || args.signal.aborted,
      signal: args.signal,
    });
    if (finalAnswer.trim()) responseText += finalAnswer;
  }

  return { responseText, touches, executedToolCount };
}
