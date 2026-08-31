import type OpenAI from "openai";
import { dashscopeClient, openaiClient } from "./ai-clients";
import { AlibabaAsrError, transcribeQwenAudio } from "./alibaba-asr";
import {
  isAlibabaSpecialistConfigured,
  isAlibabaTokenPlanKey,
} from "./alibaba-specialist-config";
import { logger, safeFailureFields } from "./logger";

/**
 * Speech-to-text for audio attachments. Runs on the providers already
 * configured for chat — no extra services, and the only pay-per-use step of
 * file analysis (roughly $0.006/min on the OpenAI models below).
 */

export class TranscriptionError extends Error {
  readonly publicMessage: string;

  constructor(publicMessage: string) {
    super(publicMessage);
    this.name = "TranscriptionError";
    this.publicMessage = publicMessage;
  }
}

const OPENAI_FALLBACK_MODELS = ["gpt-4o-mini-transcribe", "whisper-1"];
const QWEN_TRANSCRIBE_MODEL = "qwen-audio-3.0-asr-flash";
const PARAFormer_FALLBACK_MODEL = "paraformer-v2";

let cachedOpenAiModel: string | null = null;

function openAiCandidateModels(): string[] {
  const override = process.env.TRANSCRIBE_MODEL?.trim();
  const candidates = override
    ? [override, ...OPENAI_FALLBACK_MODELS.filter((model) => model !== override)]
    : [...OPENAI_FALLBACK_MODELS];
  if (cachedOpenAiModel) {
    return [cachedOpenAiModel, ...candidates.filter((model) => model !== cachedOpenAiModel)];
  }
  return candidates;
}

function isModelUnavailable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  return (
    status === 404 ||
    /model[^\n]*(not found|does not exist)|invalid[^\n]*model|unknown model/i.test(message)
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function callTranscription(
  client: OpenAI,
  model: string,
  args: { buffer: Buffer; filename: string; mime: string; signal?: AbortSignal },
): Promise<string> {
  const file = new File([new Uint8Array(args.buffer)], args.filename, {
    type: args.mime || "application/octet-stream",
  });
  const result = await client.audio.transcriptions.create(
    { file, model },
    { signal: args.signal },
  );
  const text = typeof result === "string" ? result : ((result as { text?: string } | null)?.text ?? "");
  return text.trim();
}

export async function transcribeDashScopeAudio(args: {
  buffer: Buffer;
  filename: string;
  mime: string;
  languageHints?: string[];
  signal?: AbortSignal;
}, model = QWEN_TRANSCRIBE_MODEL): Promise<string> {
  if (model === QWEN_TRANSCRIBE_MODEL) {
    try {
      const text = await transcribeQwenAudio(args);
      return text;
    } catch (error) {
      if (args.signal?.aborted) throw args.signal.reason ?? error;
      if (error instanceof AlibabaAsrError && !error.retryable) {
        throw new TranscriptionError(error.publicMessage);
      }
    logger.warn(
      safeFailureFields(error, "audio-transcription", "QWEN_ASR_FAILED"),
      "Qwen ASR failed; trying Paraformer fallback",
    );
    }
  }
  const dashscopeKey = process.env.DASHSCOPE_API_KEY?.trim();
  if (!dashscopeClient || !dashscopeKey || isAlibabaTokenPlanKey(dashscopeKey)) {
    throw new TranscriptionError("Alibaba Model Studioが設定されていません。");
  }
  try {
    const text = await callTranscription(dashscopeClient, model === QWEN_TRANSCRIBE_MODEL ? PARAFormer_FALLBACK_MODEL : model, args);
    logger.info(
      { component: "audio-transcription", provider: "dashscope", eventCode: "TRANSCRIPTION_COMPLETED" },
      "Audio transcription completed via DashScope",
    );
    return text;
  } catch (err) {
    if (args.signal?.aborted) throw args.signal.reason ?? new Error("aborted");
    throw new TranscriptionError(
      "Alibaba Model Studioで音声を文字起こしできませんでした。",
    );
  }
}

export async function transcribeAudio(args: {
  buffer: Buffer;
  filename: string;
  mime: string;
  signal?: AbortSignal;
}): Promise<string> {
  const failures: string[] = [];

  for (const model of openAiCandidateModels()) {
    try {
      const text = await callTranscription(openaiClient, model, args);
      cachedOpenAiModel = model;
      logger.info(
        { component: "audio-transcription", provider: "openai", eventCode: "TRANSCRIPTION_COMPLETED" },
        "Audio transcription completed",
      );
      return text;
    } catch (err) {
      if (args.signal?.aborted) throw args.signal.reason ?? new Error("aborted");
      failures.push(`openai/${model}: ${errorMessage(err)}`);
      // Wrong model name → try the next candidate. Any other failure
      // (auth, quota, network) would repeat on sibling models.
      if (!isModelUnavailable(err)) break;
    }
  }

  if (dashscopeClient || isAlibabaSpecialistConfigured()) {
    try {
      const text = await transcribeDashScopeAudio(args);
      return text;
    } catch (err) {
      if (args.signal?.aborted) throw args.signal.reason ?? new Error("aborted");
      failures.push(`dashscope/${QWEN_TRANSCRIBE_MODEL}: ${errorMessage(err)}`);
    }
  }

  logger.warn(
    { component: "audio-transcription", errorCode: "AUDIO_TRANSCRIPTION_FAILED" },
    "Audio transcription failed on all providers",
  );
  throw new TranscriptionError(
    "音声の文字起こしに失敗しました。ファイルが破損しているか、文字起こし機能が一時的に利用できません。",
  );
}
