import {
  AlibabaTtsError,
  synthesizeAlibabaSpeech,
  type QwenAudioTtsPlusVoice,
} from "./alibaba-tts";
import type { GeneratedAsset } from "./generated-assets";
import { logger } from "./logger";
import {
  getTtsModel,
  isSpeechProviderAvailable,
  isTtsVoice,
  selectDefaultTtsModel,
  type SpeechLanguage,
  type SpeechProvider,
  type TtsModelSpec,
} from "./speech-capabilities";
import {
  XiaomiAudioError,
  synthesizeXiaomiSpeech,
  type XiaomiTtsModelId,
  type XiaomiTtsVoice,
} from "./xiaomi-audio";

/**
 * Provider-neutral text-to-speech entry point. Mirrors audio-transcription.ts:
 * callers describe what they want spoken and this module decides which vendor
 * can actually do it, given credentials and the provider freeze flags.
 */

export class SpeechSynthesisError extends Error {
  readonly publicMessage: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    publicMessage = "音声合成に失敗しました。もう一度お試しください。",
    retryable = true,
  ) {
    super(message);
    this.name = "SpeechSynthesisError";
    this.publicMessage = publicMessage;
    this.retryable = retryable;
  }
}

export interface SpeechSynthesisRequest {
  text: string;
  modelId?: string;
  voice?: string;
  instruction?: string;
  languageHint?: SpeechLanguage;
  rate?: number;
  pitch?: number;
  volume?: number;
  signal?: AbortSignal;
}

export type SynthesizedSpeech = GeneratedAsset & {
  provider: SpeechProvider;
  modelId: string;
  voice?: string;
  requestId?: string;
};

const PROVIDER_LABEL: Record<SpeechProvider, string> = {
  alibaba: "Alibaba Model Studio",
  xiaomi: "Xiaomi MiMo",
};

function resolveModel(
  request: SpeechSynthesisRequest,
  env: NodeJS.ProcessEnv,
): TtsModelSpec {
  const requested = request.modelId?.trim();
  if (requested) {
    const spec = getTtsModel(requested);
    if (!spec) {
      throw new SpeechSynthesisError(
        `Unknown TTS model ${requested}`,
        "指定された音声合成モデルには対応していません。",
        false,
      );
    }
    return spec;
  }
  const selected = selectDefaultTtsModel(
    {
      ...(request.instruction ? { instruction: request.instruction } : {}),
      ...(request.languageHint ? { languageHint: request.languageHint } : {}),
    },
    env,
  );
  if (!selected) {
    throw new SpeechSynthesisError(
      "No TTS provider is configured",
      "音声合成を利用できるプロバイダが設定されていません。",
      false,
    );
  }
  return selected;
}

export async function synthesizeSpeech(
  request: SpeechSynthesisRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SynthesizedSpeech> {
  const spec = resolveModel(request, env);
  if (!isSpeechProviderAvailable(spec.provider, env)) {
    throw new SpeechSynthesisError(
      `Speech provider ${spec.provider} is not available`,
      `${PROVIDER_LABEL[spec.provider]}の音声合成は現在利用できません。`,
      false,
    );
  }
  if (request.languageHint && !spec.languages.includes(request.languageHint)) {
    throw new SpeechSynthesisError(
      `Model ${spec.id} does not support language ${request.languageHint}`,
      `${spec.label}は${spec.languages.join("・")}のみの対応です。`,
      false,
    );
  }
  const voice = request.voice?.trim() || undefined;
  if (voice && !isTtsVoice(spec.id, voice)) {
    throw new SpeechSynthesisError(
      `Voice ${voice} is not available on ${spec.id}`,
      `${spec.label}で指定された声色は利用できません。`,
      false,
    );
  }
  const instruction = request.instruction?.trim() || undefined;
  if (instruction && !spec.supportsInstruction) {
    logger.warn(
      { modelId: spec.id },
      "Ignoring voice instruction for a TTS model that does not accept one",
    );
  }

  if (spec.provider === "xiaomi") {
    try {
      const speech = await synthesizeXiaomiSpeech({
        text: request.text,
        modelId: spec.id as XiaomiTtsModelId,
        ...(voice ? { voice: voice as XiaomiTtsVoice } : {}),
        ...(instruction && spec.supportsInstruction ? { instruction } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      return {
        buffer: speech.buffer,
        filename: speech.filename,
        mimeType: speech.mimeType,
        size: speech.size,
        provider: "xiaomi",
        modelId: speech.modelId,
        ...(speech.voice ? { voice: speech.voice } : {}),
      };
    } catch (error) {
      if (error instanceof XiaomiAudioError) {
        throw new SpeechSynthesisError(
          error.message,
          error.publicMessage,
          error.retryable,
        );
      }
      throw error;
    }
  }

  try {
    const speech = await synthesizeAlibabaSpeech({
      text: request.text,
      modelId: spec.id,
      // Already validated against this model's voice list above.
      ...(voice ? { voice: voice as QwenAudioTtsPlusVoice } : {}),
      ...(instruction ? { instruction } : {}),
      ...(request.languageHint === "zh" || request.languageHint === "en"
        ? { languageHint: request.languageHint }
        : {}),
      ...(request.rate !== undefined ? { rate: request.rate } : {}),
      ...(request.pitch !== undefined ? { pitch: request.pitch } : {}),
      ...(request.volume !== undefined ? { volume: request.volume } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return {
      buffer: speech.buffer,
      filename: speech.filename,
      mimeType: speech.mimeType,
      size: speech.size,
      provider: "alibaba",
      modelId: speech.modelId,
      voice: speech.voice,
      ...(speech.requestId ? { requestId: speech.requestId } : {}),
    };
  } catch (error) {
    if (error instanceof AlibabaTtsError) {
      throw new SpeechSynthesisError(error.message, error.publicMessage, true);
    }
    throw error;
  }
}
