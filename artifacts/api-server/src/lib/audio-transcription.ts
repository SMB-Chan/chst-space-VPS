import { isProviderFrozen } from "./provider-policy";
import type OpenAI from "openai";
import { dashscopeClient, openaiClient } from "./ai-clients";
import { AlibabaAsrError, transcribeQwenAudio } from "./alibaba-asr";
import {
  isAlibabaSpecialistConfigured,
  isAlibabaTokenPlanKey,
} from "./alibaba-specialist-config";
import { logger, safeFailureFields } from "./logger";
import {
  getAsrModel,
  isSpeechProviderAvailable,
  type SpeechProvider,
} from "./speech-capabilities";
import {
  XiaomiAudioError,
  isXiaomiAudioConfigured,
  transcribeXiaomiAudio,
} from "./xiaomi-audio";

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

const ASR_PROVIDER_LABEL: Record<SpeechProvider, string> = {
  alibaba: "Alibaba Model Studio",
  xiaomi: "Xiaomi MiMo",
};

const OPENAI_FALLBACK_MODELS = ["gpt-4o-mini-transcribe", "whisper-1"];
const QWEN_TRANSCRIBE_MODEL = "qwen-audio-3.0-asr-flash";
const PARAFormer_FALLBACK_MODEL = "paraformer-v2";

let cachedOpenAiModel: string | null = null;

function openAiCandidateModels(): string[] {
  const override = process.env.TRANSCRIBE_MODEL?.trim();
  const candidates = override
    ? [
        override,
        ...OPENAI_FALLBACK_MODELS.filter((model) => model !== override),
      ]
    : [...OPENAI_FALLBACK_MODELS];
  if (cachedOpenAiModel) {
    return [
      cachedOpenAiModel,
      ...candidates.filter((model) => model !== cachedOpenAiModel),
    ];
  }
  return candidates;
}

function isModelUnavailable(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  return (
    status === 404 ||
    /model[^\n]*(not found|does not exist)|invalid[^\n]*model|unknown model/i.test(
      message,
    )
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function callTranscription(
  client: OpenAI,
  model: string,
  args: {
    buffer: Buffer;
    filename: string;
    mime: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  const file = new File([new Uint8Array(args.buffer)], args.filename, {
    type: args.mime || "application/octet-stream",
  });
  const result = await client.audio.transcriptions.create(
    { file, model },
    { signal: args.signal },
  );
  const text =
    typeof result === "string"
      ? result
      : ((result as { text?: string } | null)?.text ?? "");
  return text.trim();
}

export async function transcribeDashScopeAudio(
  args: {
    buffer: Buffer;
    filename: string;
    mime: string;
    languageHints?: string[];
    signal?: AbortSignal;
  },
  model = QWEN_TRANSCRIBE_MODEL,
): Promise<string> {
  if (isProviderFrozen("dashscope")) {
    throw new TranscriptionError("Alibaba Cloudのモデルは一時凍結中です。");
  }
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
  if (
    !dashscopeClient ||
    !dashscopeKey ||
    isAlibabaTokenPlanKey(dashscopeKey)
  ) {
    throw new TranscriptionError("Alibaba Model Studioが設定されていません。");
  }
  try {
    const text = await callTranscription(
      dashscopeClient,
      model === QWEN_TRANSCRIBE_MODEL ? PARAFormer_FALLBACK_MODEL : model,
      args,
    );
    logger.info(
      {
        component: "audio-transcription",
        provider: "dashscope",
        eventCode: "TRANSCRIPTION_COMPLETED",
      },
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

export interface AudioTranscriptionArgs {
  buffer: Buffer;
  filename: string;
  mime: string;
  /** Honoured by the Alibaba transport; other providers infer the language. */
  languageHints?: string[];
  signal?: AbortSignal;
}

export async function transcribeAudio(
  args: AudioTranscriptionArgs,
): Promise<string> {
  const failures: string[] = [];

  for (const model of openaiClient && !isProviderFrozen("openai")
    ? openAiCandidateModels()
    : []) {
    try {
      const text = await callTranscription(openaiClient!, model, args);
      cachedOpenAiModel = model;
      logger.info(
        {
          component: "audio-transcription",
          provider: "openai",
          eventCode: "TRANSCRIPTION_COMPLETED",
        },
        "Audio transcription completed",
      );
      return text;
    } catch (err) {
      if (args.signal?.aborted)
        throw args.signal.reason ?? new Error("aborted");
      failures.push(`openai/${model}: ${errorMessage(err)}`);
      // Wrong model name → try the next candidate. Any other failure
      // (auth, quota, network) would repeat on sibling models.
      if (!isModelUnavailable(err)) break;
    }
  }

  if (
    !isProviderFrozen("dashscope") &&
    (dashscopeClient || isAlibabaSpecialistConfigured())
  ) {
    try {
      const text = await transcribeDashScopeAudio(args);
      return text;
    } catch (err) {
      if (args.signal?.aborted)
        throw args.signal.reason ?? new Error("aborted");
      failures.push(`dashscope/${QWEN_TRANSCRIBE_MODEL}: ${errorMessage(err)}`);
    }
  }

  if (isXiaomiAudioConfigured()) {
    try {
      return await transcribeXiaomiAudio(args);
    } catch (err) {
      if (args.signal?.aborted)
        throw args.signal.reason ?? new Error("aborted");
      if (err instanceof XiaomiAudioError && !err.retryable) {
        throw new TranscriptionError(err.publicMessage);
      }
      failures.push(`xiaomi/mimo-v2.5-asr: ${errorMessage(err)}`);
    }
  }

  logger.warn(
    {
      component: "audio-transcription",
      errorCode: "AUDIO_TRANSCRIPTION_FAILED",
      failures: failures.join("; ").slice(0, 2_000),
    },
    "Audio transcription failed on all providers",
  );
  throw new TranscriptionError(
    "音声の文字起こしに失敗しました。ファイルが破損しているか、文字起こし機能が一時的に利用できません。",
  );
}

/**
 * Transcribe with a specific specialist model, the path the capability broker
 * takes once it has already chosen one. Falls back to the provider chain when
 * no model was named.
 */
export async function transcribeAudioWithModel(
  args: AudioTranscriptionArgs,
  modelId?: string,
): Promise<string> {
  const requested = modelId?.trim();
  if (!requested) return transcribeAudio(args);

  const spec = getAsrModel(requested);
  if (!spec) {
    throw new TranscriptionError(
      "指定された音声認識モデルには対応していません。",
    );
  }
  if (!isSpeechProviderAvailable(spec.provider)) {
    throw new TranscriptionError(
      `${ASR_PROVIDER_LABEL[spec.provider]}の音声認識は現在利用できません。`,
    );
  }
  try {
    return spec.provider === "xiaomi"
      ? await transcribeXiaomiAudio(args)
      : await transcribeDashScopeAudio(args, requested);
  } catch (err) {
    if (args.signal?.aborted) throw args.signal.reason ?? new Error("aborted");
    if (err instanceof XiaomiAudioError) {
      throw new TranscriptionError(err.publicMessage);
    }
    if (err instanceof TranscriptionError) throw err;
    logger.warn(
      safeFailureFields(
        err,
        "audio-transcription",
        "AUDIO_TRANSCRIPTION_FAILED",
      ),
      "Model-directed audio transcription failed",
    );
    throw new TranscriptionError(
      `${ASR_PROVIDER_LABEL[spec.provider]}で音声を文字起こしできませんでした。`,
    );
  }
}
