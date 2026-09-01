import type OpenAI from "openai";
import {
  getClientForModel,
  type ChatModel,
  type ModelProvider,
} from "./ai-clients";
import { applyValidatedAuditPatch } from "./audit-patch";
import {
  FACTUALITY_SYSTEM_PROMPT,
  buildFactualityUserMessage,
  parseFactualityVerification,
  unavailableFactualityReport,
  type FactualityReport,
} from "./factuality";
import { logger, safeFailureFields } from "./logger";
import type {
  StreamEventEmitter,
  StreamModelTextFn,
  WithTimeoutFn,
} from "./chat-stream-stage-types";

const FACTUALITY_TIMEOUT_MS = 120_000;
const FACTUALITY_MAX_OUTPUT_TOKENS = 1_600;
const UNSUPPORTED_CLAIM_NOTICE =
  "\n\n> **根拠上の注意:** 上記には、取得した資料だけでは確認できない主張が含まれます。根拠チェックの詳細を確認してください。";

export function shouldVerifySearchBackedAnswer(args: {
  translationMode: boolean;
  sourceCount: number;
  sourceText: string;
  generatesFile: boolean;
}): boolean {
  return (
    !args.translationMode &&
    args.sourceCount > 0 &&
    Boolean(args.sourceText.trim()) &&
    !args.generatesFile
  );
}

export async function verifySearchBackedAnswer(args: {
  client: OpenAI;
  provider: ModelProvider;
  modelId: string;
  auditModel?: Pick<ChatModel, "id" | "provider">;
  question: string;
  answer: string;
  sourceText: string;
  sourceCount: number;
  signal: AbortSignal;
  clientGone: () => boolean;
  emit: StreamEventEmitter;
  streamText: StreamModelTextFn;
  withTimeout: WithTimeoutFn;
}): Promise<{ content: string; factuality: FactualityReport }> {
  const verifierModel =
    args.auditModel && args.auditModel.id !== args.modelId
      ? args.auditModel
      : { id: args.modelId, provider: args.provider };
  let content = args.answer;
  let factuality: FactualityReport;

  try {
    const verifier =
      verifierModel.id === args.modelId
        ? { client: args.client, provider: args.provider }
        : getClientForModel(verifierModel.id, verifierModel.provider);
    if (!args.clientGone()) {
      args.emit({ status: "verifying", model: verifierModel.id });
    }
    const raw = await args.withTimeout(
      (signal) =>
        args.streamText({
          client: verifier.client,
          provider: verifier.provider,
          modelId: verifierModel.id,
          reasoningLevel: "off",
          maxOutputTokens: FACTUALITY_MAX_OUTPUT_TOKENS,
          messages: [
            { role: "system", content: FACTUALITY_SYSTEM_PROMPT },
            {
              role: "user",
              content: buildFactualityUserMessage({
                question: args.question,
                answer: content,
                sourceText: args.sourceText,
              }),
            },
          ],
          onDelta: () => {
            // Verification JSON stays server-side until it is validated.
          },
          shouldStop: () => args.clientGone() || args.signal.aborted,
          signal,
        }),
      FACTUALITY_TIMEOUT_MS,
      "Factuality verification",
      args.signal,
    );
    const parsed = parseFactualityVerification({
      raw,
      modelId: verifierModel.id,
      sourceCount: args.sourceCount,
    });
    if (!parsed) {
      factuality = unavailableFactualityReport(verifierModel.id);
    } else {
      const patched = applyValidatedAuditPatch(
        content,
        JSON.stringify({
          note: parsed.report.summary,
          operations: parsed.operations,
        }),
      );
      if (patched.applied) {
        content = patched.content;
        if (!args.clientGone()) {
          args.emit({ status: "revising", patch: patched.operations });
        }
      } else if (
        parsed.operations.length > 0 &&
        patched.reason &&
        !args.clientGone()
      ) {
        args.emit({
          status: "search_warning",
          message: `${patched.reason} 検証結果のみ表示します。`,
        });
      }
      factuality = { ...parsed.report, corrected: patched.applied };
      if (
        parsed.report.status !== "verified" &&
        parsed.report.claims.length > 0 &&
        !patched.applied
      ) {
        content += UNSUPPORTED_CLAIM_NOTICE;
        if (!args.clientGone()) {
          args.emit({
            content: UNSUPPORTED_CLAIM_NOTICE,
            status: "revising",
          });
        }
      }
    }
  } catch (error) {
    if (args.signal.aborted) throw error;
    logger.warn(
      safeFailureFields(error, "chat-stream", "FACTUALITY_VERIFICATION_FAILED"),
      "Factuality verification failed; preserving the sourced answer",
    );
    factuality = unavailableFactualityReport(verifierModel.id);
  }

  if (!args.clientGone()) args.emit({ factuality });
  return { content, factuality };
}
