import type OpenAI from "openai";
import type { ModelProvider, ReasoningLevel } from "./ai-clients";
import { mergeResearchEvidence, type FactualitySource } from "./factuality";
import { logger, safeFailureFields } from "./logger";
import { shouldSynthesizeResearchAnswer } from "./chat-stream-policy";
import type {
  StreamEventEmitter,
  StreamModelTextFn,
  StreamModelTool,
  StreamModelUsage,
  WithTimeoutFn,
} from "./chat-stream-stage-types";
import {
  executeSpecialistTool,
  isEvidenceTool,
  isSpecialistMutationTool,
  type SpecialistToolCall,
  type SpecialistToolResult,
} from "./specialist-capabilities";
import {
  buildForcedGapSearch,
  buildResearchGapInstruction,
  hasSufficientResearchCoverage,
  researchCoverage,
  researchDepthPolicy,
  selectDeepPageFetches,
} from "./research-depth";
import {
  buildEvidenceFacetGapSearch,
  buildEvidenceMatrixFinalInstruction,
  buildEvidenceMatrixGapInstruction,
  buildEvidenceMatrixUserMessage,
  EVIDENCE_MATRIX_SYSTEM_PROMPT,
  inferRequiredEvidenceFacets,
  parseEvidenceMatrixAssessment,
  type EvidenceFacetRequirement,
  type EvidenceMatrixAssessment,
} from "./research-evidence-matrix";

const RESEARCH_STEP_TIMEOUT_MS = 30_000;
const EVIDENCE_MATRIX_TIMEOUT_MS = 15_000;
const MAX_EVIDENCE_MATRIX_ASSESSMENTS = 3;
const RESEARCH_FINAL_SYNTHESIS_SYSTEM_PROMPT = `検索ツールの実行段階は終了しました。追加のツールは呼び出せません。
これまでに取得したツール結果だけを使い、ユーザーの質問への最終回答を今すぐ完成させてください。検索するという宣言や作業予定は書かず、根拠番号を引用し、不明点は不明と明示してください。`;
const DEEP_RESEARCH_FINAL_SYNTHESIS_SYSTEM_PROMPT = `Deep調査の検索ツール実行段階は終了しました。追加のツールは呼び出せません。
取得した一次資料・本文・複数の独立情報源を優先し、論点ごとに証拠を突き合わせて最終回答を完成させてください。重要な主張には根拠番号を付け、情報源同士に不一致がある場合は隠さず示し、根拠が不足する点は不明と明示してください。検索予定や作業ログは書かないでください。`;
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

function latestUserQuestion(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as {
      role?: string;
      content?: unknown;
    };
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .flatMap((part) => {
          if (!part || typeof part !== "object") return [];
          const value = part as { type?: unknown; text?: unknown };
          return value.type === "text" && typeof value.text === "string"
            ? [value.text]
            : [];
        })
        .join("\n")
        .trim();
      if (text) return text;
    }
  }
  return "";
}

function parsedCallArguments(
  call: SpecialistToolCall,
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.arguments);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function bodyBlockCount(text: string): number {
  return (text.match(/(?:^|\n)\s*本文:\n/g) ?? []).length;
}

async function assessEvidenceMatrix(args: {
  client: OpenAI;
  provider: ModelProvider;
  modelId: string;
  question: string;
  requiredFacets: EvidenceFacetRequirement[];
  sources: FactualitySource[];
  evidenceParts: string[];
  signal: AbortSignal;
  clientGone: () => boolean;
  streamText: StreamModelTextFn;
  withTimeout: WithTimeoutFn;
  onUsage?: (usage: StreamModelUsage) => void;
}): Promise<EvidenceMatrixAssessment | undefined> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: EVIDENCE_MATRIX_SYSTEM_PROMPT },
    {
      role: "user",
      content: buildEvidenceMatrixUserMessage({
        question: args.question,
        requiredFacets: args.requiredFacets,
        sources: args.sources,
        evidenceParts: args.evidenceParts,
      }),
    },
  ];
  const raw = await args.withTimeout(
    (signal) =>
      args.streamText({
        client: args.client,
        provider: args.provider,
        modelId: args.modelId,
        reasoningLevel: "off",
        maxOutputTokens: 700,
        messages,
        onDelta: () => undefined,
        onUsage: args.onUsage,
        shouldStop: () => args.clientGone() || signal.aborted,
        signal,
      }),
    EVIDENCE_MATRIX_TIMEOUT_MS,
    "Evidence matrix assessment",
    args.signal,
  );
  return parseEvidenceMatrixAssessment({
    raw,
    requiredFacets: args.requiredFacets,
    sourceCount: args.sources.length,
  });
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
  onUsage?: (usage: StreamModelUsage) => void;
}): Promise<ResearchLoopResult> {
  const sources: FactualitySource[] = [];
  const evidenceParts: string[] = [];
  const deferredCalls: SpecialistToolCall[] = [];
  const question = latestUserQuestion(args.messages);
  const policy = researchDepthPolicy(question);
  const requiredEvidenceFacets =
    policy.depth === "deep" ? inferRequiredEvidenceFacets(question) : [];
  const seenQueries = new Set<string>();
  const fetchedUrls = new Set<string>();
  let executedToolCount = 0;
  let successfulSearches = 0;
  let fetchedPages = 0;
  let forcedGapRounds = 0;
  let evidenceMatrixAssessments = 0;
  let lastEvidenceMatrixPartCount = -1;
  let evidenceMatrixGateFailedOpen = false;
  let evidenceMatrix: EvidenceMatrixAssessment | undefined;
  let continuationText = "";
  let responseText = "";
  let hitStepLimitWithPendingResearch = false;
  let researchStep = 0;
  let currentResearchCalls = args.initialCalls;

  while (
    currentResearchCalls.length > 0 &&
    researchStep < policy.maxSteps &&
    executedToolCount < policy.maxToolCalls &&
    !args.signal.aborted
  ) {
    researchStep += 1;
    const remainingAtStart = policy.maxToolCalls - executedToolCount;
    const waveCalls = currentResearchCalls.slice(0, remainingAtStart);
    if (waveCalls.length === 0) break;
    if (!args.clientGone()) {
      const currentCoverage = researchCoverage({
        sources,
        successfulSearches,
        fetchedPages,
      });
      args.emit({
        status: "researching",
        step: researchStep,
        maxSteps: policy.maxSteps,
        toolCount: waveCalls.length,
        researchDepth: policy.depth,
        coverage: currentCoverage,
      });
    }

    const toolResults: {
      call: SpecialistToolCall;
      result: Awaited<ReturnType<typeof executeSpecialistTool>>;
    }[] = [];
    for (const toolCall of waveCalls) {
      if (args.clientGone() || args.signal.aborted) break;
      const parsedArgs = parsedCallArguments(toolCall);
      if (
        toolCall.name === "web_search" &&
        typeof parsedArgs.query === "string"
      ) {
        seenQueries.add(parsedArgs.query);
      }
      if (
        toolCall.name === "fetch_page" &&
        typeof parsedArgs.url === "string"
      ) {
        fetchedUrls.add(parsedArgs.url);
      }
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
      if (result.ok && result.text?.trim()) {
        if (toolCall.name === "web_search") {
          successfulSearches += 1;
          if (parsedArgs.fetchContent === true) {
            fetchedPages += bodyBlockCount(result.text);
            for (const source of result.sources ?? []) {
              fetchedUrls.add(source.url);
            }
          }
        } else if (toolCall.name === "fetch_page") {
          fetchedPages += 1;
        }
      }
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
          capability: result.capability,
          summary: result.summary,
          text: result.text,
        }),
      });
    }

    if (sources.length > 0 && !args.clientGone()) args.emit({ sources });

    const coverage = researchCoverage({
      sources,
      successfulSearches,
      fetchedPages,
    });
    const remainingToolCalls = policy.maxToolCalls - executedToolCount;

    // Deep research proactively reads page bodies from the best distinct
    // domains instead of allowing a snippet-only answer to terminate early.
    if (
      policy.depth === "deep" &&
      fetchedPages < policy.minFetchedPages &&
      remainingToolCalls > 0 &&
      researchStep < policy.maxSteps
    ) {
      const fetchCalls = selectDeepPageFetches({
        sources,
        fetchedUrls,
        remainingToolCalls,
        limit: policy.minFetchedPages - fetchedPages,
      }).map((call, index) => ({
        ...call,
        id: `research-depth-fetch-${researchStep}-${index + 1}`,
      }));
      if (fetchCalls.length > 0) {
        currentResearchCalls = fetchCalls;
        continue;
      }
    }

    const coverageSufficient = hasSufficientResearchCoverage(policy, coverage);
    if (
      policy.depth === "deep" &&
      coverageSufficient &&
      requiredEvidenceFacets.length > 0 &&
      evidenceMatrixAssessments < MAX_EVIDENCE_MATRIX_ASSESSMENTS &&
      evidenceParts.length !== lastEvidenceMatrixPartCount &&
      !args.signal.aborted &&
      !args.clientGone()
    ) {
      lastEvidenceMatrixPartCount = evidenceParts.length;
      evidenceMatrixAssessments += 1;
      try {
        const assessed = await assessEvidenceMatrix({
          client: args.client,
          provider: args.provider,
          modelId: args.modelId,
          question,
          requiredFacets: requiredEvidenceFacets,
          sources,
          evidenceParts,
          signal: args.signal,
          clientGone: args.clientGone,
          streamText: args.streamText,
          withTimeout: args.withTimeout,
          onUsage: args.onUsage,
        });
        if (assessed) {
          evidenceMatrix = assessed;
          evidenceMatrixGateFailedOpen = false;
          if (!args.clientGone()) {
            args.emit({
              status: "researching",
              researchDepth: "deep",
              evidenceMatrix: {
                complete: assessed.complete,
                facets: assessed.facets,
                assessment: evidenceMatrixAssessments,
                maxAssessments: MAX_EVIDENCE_MATRIX_ASSESSMENTS,
              },
            });
          }
        } else {
          evidenceMatrixGateFailedOpen = true;
        }
      } catch (error) {
        if (args.signal.aborted) throw error;
        evidenceMatrixGateFailedOpen = true;
        logger.warn(
          safeFailureFields(
            error,
            "chat-stream",
            "RESEARCH_EVIDENCE_MATRIX_FAILED",
          ),
          "Evidence matrix assessment failed; falling back to numeric coverage",
        );
      }
    }

    const matrixSufficient =
      evidenceMatrixGateFailedOpen ||
      !evidenceMatrix ||
      evidenceMatrix.complete;
    const deepNeedsMore =
      policy.depth === "deep" &&
      (!coverageSufficient || !matrixSufficient) &&
      remainingToolCalls > 0 &&
      researchStep < policy.maxSteps;
    const nextRoundCalls: SpecialistToolCall[] = [];
    const activeMatrix =
      evidenceMatrixGateFailedOpen || !evidenceMatrix || evidenceMatrix.complete
        ? undefined
        : evidenceMatrix;
    const gapInstruction = activeMatrix
      ? buildEvidenceMatrixGapInstruction(activeMatrix)
      : buildResearchGapInstruction(policy, coverage);
    const decisionMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
      deepNeedsMore
        ? [
            ...args.messages,
            {
              role: "system",
              content: gapInstruction,
            },
          ]
        : args.messages;
    const continuation = await args.streamText({
      client: args.client,
      provider: args.provider,
      modelId: args.modelId,
      reasoningLevel: args.reasoningLevel,
      messages: decisionMessages,
      tools: args.tools,
      onToolCalls: (calls) => nextRoundCalls.push(...calls),
      onDelta: (text, kind) => {
        if (deepNeedsMore && kind === "content") return;
        emitModelDelta(args.emit, args.clientGone, args.signal, text, kind);
      },
      onUsage: args.onUsage,
      shouldStop: () => args.clientGone() || args.signal.aborted,
      signal: args.signal,
    });
    if (!deepNeedsMore) {
      responseText += continuation;
      continuationText += continuation;
    }

    const nextResearchCalls = nextRoundCalls.filter(isEvidenceTool);
    const remainingAfterDecision = policy.maxToolCalls - executedToolCount;
    if (
      nextResearchCalls.length > 0 &&
      researchStep < policy.maxSteps &&
      remainingAfterDecision > 0
    ) {
      currentResearchCalls = nextResearchCalls.slice(0, remainingAfterDecision);
      appendDeferredCalls(deferredCalls, nextRoundCalls);
      continue;
    }

    if (nextRoundCalls.some((call) => !isEvidenceTool(call))) {
      appendDeferredCalls(deferredCalls, nextRoundCalls);
    }

    if (
      deepNeedsMore &&
      forcedGapRounds < policy.maxForcedGapRounds &&
      remainingAfterDecision > 0 &&
      researchStep < policy.maxSteps
    ) {
      const semanticGap = activeMatrix
        ? buildEvidenceFacetGapSearch({
            question,
            assessment: activeMatrix,
            seenQueries,
            forcedRound: forcedGapRounds,
          })
        : undefined;
      const forced =
        semanticGap?.call ??
        buildForcedGapSearch({
          question,
          coverage,
          forcedRound: forcedGapRounds,
          seenQueries,
        });
      if (forced) {
        forcedGapRounds += 1;
        currentResearchCalls = [forced];
        continue;
      }
    }

    if (
      (nextResearchCalls.length > 0 || deepNeedsMore) &&
      (researchStep >= policy.maxSteps || remainingAfterDecision <= 0)
    ) {
      hitStepLimitWithPendingResearch = true;
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
    const matrixFinalInstruction =
      policy.depth === "deep"
        ? buildEvidenceMatrixFinalInstruction(evidenceMatrix)
        : undefined;
    if (matrixFinalInstruction) {
      args.messages.push({
        role: "system",
        content: matrixFinalInstruction,
      });
    }
    args.messages.push({
      role: "system",
      content:
        policy.depth === "deep"
          ? DEEP_RESEARCH_FINAL_SYNTHESIS_SYSTEM_PROMPT
          : RESEARCH_FINAL_SYNTHESIS_SYSTEM_PROMPT,
    });
    const finalAnswer = await args.streamText({
      client: args.client,
      provider: args.provider,
      modelId: args.modelId,
      reasoningLevel: args.reasoningLevel,
      messages: args.messages,
      onDelta: (text, kind) =>
        emitModelDelta(args.emit, args.clientGone, args.signal, text, kind),
      onUsage: args.onUsage,
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
