import type OpenAI from "openai";
import { xiaomiClient } from "./ai-clients";
import {
  containerFromFilename,
  containerFromMime,
  detectAudioContainer,
  isFfmpegAvailable,
  probeAudioDurationSeconds,
  transcodeToWav,
  type AudioContainer,
} from "./audio-format";
import type { GeneratedAsset } from "./generated-assets";
import { logger } from "./logger";
import { isProviderFrozen } from "./provider-policy";

/**
 * Xiaomi MiMo audio transports. Both directions ride the same
 * OpenAI-compatible chat-completions endpoint used for MiMo chat: synthesis
 * sends an `audio` block and reads base64 PCM/MP3 back off the assistant
 * message, recognition sends an `input_audio` content part and reads text.
 */

const MAX_TTS_TEXT_CHARS = 10_000;
const MAX_TTS_INSTRUCTION_CHARS = 1_000;
const MAX_TTS_AUDIO_BYTES = 32 * 1024 * 1024;
const MAX_ENCODED_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_ASR_DURATION_SECONDS = 5 * 60;
const REQUEST_TIMEOUT_MS = 90_000;

export const MIMO_TTS_MODEL_IDS = [
  "mimo-v2.5-tts",
  "mimo-v2.5-tts-voicedesign",
] as const;

export type XiaomiTtsModelId = (typeof MIMO_TTS_MODEL_IDS)[number];

export const MIMO_TTS_DEFAULT_MODEL_ID: XiaomiTtsModelId = "mimo-v2.5-tts";
export const MIMO_TTS_VOICE_DESIGN_MODEL_ID: XiaomiTtsModelId =
  "mimo-v2.5-tts-voicedesign";

/** Built-in voices accepted by mimo-v2.5-tts. voicedesign takes none. */
export const MIMO_TTS_VOICES = [
  "mimo_default",
  "冰糖",
  "茉莉",
  "苏打",
  "白桦",
  "Mia",
  "Chloe",
  "Milo",
  "Dean",
] as const;

export type XiaomiTtsVoice = (typeof MIMO_TTS_VOICES)[number];

export const MIMO_TTS_DEFAULT_VOICE: XiaomiTtsVoice = "mimo_default";

export const MIMO_TTS_FORMATS = ["mp3", "wav"] as const;
export type XiaomiTtsFormat = (typeof MIMO_TTS_FORMATS)[number];

export const MIMO_ASR_MODEL_ID = "mimo-v2.5-asr";

/** The gateway rejects every other container, so others are transcoded first. */
export const MIMO_ASR_FORMATS = ["wav", "mp3"] as const;

export const MIMO_DEFAULT_VOICE_DESIGN_INSTRUCTION =
  "自然で明瞭な話し声。落ち着いたペースで、内容に合ったイントネーションで読んでください。";

export class XiaomiAudioError extends Error {
  readonly publicMessage: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    publicMessage = "Xiaomi MiMo で音声を処理できませんでした。",
    retryable = true,
  ) {
    super(message);
    this.name = "XiaomiAudioError";
    this.publicMessage = publicMessage;
    this.retryable = retryable;
  }
}

export function isXiaomiAudioConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(xiaomiClient) && !isProviderFrozen("xiaomi", env);
}

export interface XiaomiTtsRequest {
  text: string;
  modelId?: XiaomiTtsModelId;
  voice?: XiaomiTtsVoice;
  /** Voice description; required in spirit by the voicedesign model. */
  instruction?: string;
  format?: XiaomiTtsFormat;
  signal?: AbortSignal;
}

export type XiaomiGeneratedSpeech = GeneratedAsset & {
  provider: "xiaomi";
  modelId: XiaomiTtsModelId;
  voice?: XiaomiTtsVoice;
};

function withTimeout(
  signal: AbortSignal | undefined,
  reason: string,
): { controller: AbortController; dispose: () => void } {
  const controller = new AbortController();
  const onAbort = () =>
    controller.abort(
      signal?.reason ?? new Error("Xiaomi audio request aborted"),
    );
  const timeout = setTimeout(
    () => controller.abort(new Error(reason)),
    REQUEST_TIMEOUT_MS,
  );
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return {
    controller,
    dispose: () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function isXiaomiTtsModelId(value: string): value is XiaomiTtsModelId {
  return (MIMO_TTS_MODEL_IDS as readonly string[]).includes(value);
}

function normalizeTtsRequest(request: XiaomiTtsRequest): {
  text: string;
  modelId: XiaomiTtsModelId;
  voice?: XiaomiTtsVoice;
  instruction?: string;
  format: XiaomiTtsFormat;
} {
  const text = request.text.trim();
  if (!text) {
    throw new XiaomiAudioError(
      "TTS text is empty",
      "読み上げるテキストを指定してください。",
      false,
    );
  }
  if (text.length > MAX_TTS_TEXT_CHARS) {
    throw new XiaomiAudioError(
      "TTS text exceeds application limit",
      "音声合成するテキストが長すぎます。1万文字以内にしてください。",
      false,
    );
  }
  const requestedModel = request.modelId?.trim() || MIMO_TTS_DEFAULT_MODEL_ID;
  if (!isXiaomiTtsModelId(requestedModel)) {
    throw new XiaomiAudioError(
      `Model ${requestedModel} is not a MiMo TTS model`,
      "指定された音声合成モデルには対応していません。",
      false,
    );
  }
  const modelId = requestedModel;
  const instruction = request.instruction?.trim();
  if (instruction && instruction.length > MAX_TTS_INSTRUCTION_CHARS) {
    throw new XiaomiAudioError(
      "TTS instruction exceeds application limit",
      "音声スタイルの指示が長すぎます。",
      false,
    );
  }
  const voice = request.voice ?? undefined;
  if (voice && !(MIMO_TTS_VOICES as readonly string[]).includes(voice)) {
    throw new XiaomiAudioError(
      `Unsupported MiMo TTS voice ${voice}`,
      "指定された声色には対応していません。",
      false,
    );
  }
  if (voice && modelId === MIMO_TTS_VOICE_DESIGN_MODEL_ID) {
    throw new XiaomiAudioError(
      "voicedesign does not accept a built-in voice",
      "声のデザイン指定と既製の声色は同時に指定できません。",
      false,
    );
  }
  if (!voice && modelId === MIMO_TTS_DEFAULT_MODEL_ID) {
    return {
      text,
      modelId,
      voice: MIMO_TTS_DEFAULT_VOICE,
      ...(instruction ? { instruction } : {}),
      format: request.format ?? "mp3",
    };
  }
  return {
    text,
    modelId,
    ...(voice ? { voice } : {}),
    ...(instruction ? { instruction } : {}),
    format: request.format ?? "mp3",
  };
}

function ttsMessages(
  normalized: ReturnType<typeof normalizeTtsRequest>,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  if (normalized.modelId === MIMO_TTS_VOICE_DESIGN_MODEL_ID) {
    return [
      {
        role: "user",
        content:
          normalized.instruction ?? MIMO_DEFAULT_VOICE_DESIGN_INSTRUCTION,
      },
      { role: "assistant", content: normalized.text },
    ];
  }
  return [{ role: "assistant", content: normalized.text }];
}

function decodeSpeechAudio(payload: unknown): Buffer {
  const choices = (payload as { choices?: unknown })?.choices;
  const message = Array.isArray(choices)
    ? (choices[0] as { message?: { audio?: { data?: unknown } } })?.message
    : undefined;
  const data = message?.audio?.data;
  if (typeof data !== "string" || !data.trim()) {
    throw new XiaomiAudioError(
      "MiMo TTS returned no audio payload",
      "音声合成の結果が返されませんでした。もう一度お試しください。",
    );
  }
  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) {
    throw new XiaomiAudioError("MiMo TTS returned empty audio bytes");
  }
  if (buffer.length > MAX_TTS_AUDIO_BYTES) {
    throw new XiaomiAudioError(
      "Generated speech exceeds size limit",
      "生成された音声が大きすぎます。",
      false,
    );
  }
  return buffer;
}

export async function synthesizeXiaomiSpeech(
  request: XiaomiTtsRequest,
): Promise<XiaomiGeneratedSpeech> {
  if (!isXiaomiAudioConfigured()) {
    throw new XiaomiAudioError(
      "Xiaomi MiMo credentials are not configured",
      "Xiaomi MiMo のAPI資格情報が設定されていないため音声を生成できません。",
      false,
    );
  }
  const normalized = normalizeTtsRequest(request);
  const client = xiaomiClient as OpenAI;
  const { controller, dispose } = withTimeout(
    request.signal,
    "MiMo TTS request timed out",
  );

  try {
    const body = {
      model: normalized.modelId,
      messages: ttsMessages(normalized),
      stream: false,
      audio: {
        format: normalized.format,
        ...(normalized.voice ? { voice: normalized.voice } : {}),
      },
    };
    const completion = await client.chat.completions.create(
      body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { signal: controller.signal },
    );
    const buffer = decodeSpeechAudio(completion);
    const extension = normalized.format === "wav" ? "wav" : "mp3";
    logger.info(
      {
        component: "xiaomi-audio",
        provider: "xiaomi",
        modelId: normalized.modelId,
        voice: normalized.voice ?? null,
        bytes: buffer.length,
        eventCode: "SPEECH_SYNTHESIS_COMPLETED",
      },
      "Xiaomi MiMo speech synthesis completed",
    );
    return {
      buffer,
      filename: `xiaomi-${normalized.modelId}-${Date.now()}.${extension}`,
      mimeType: normalized.format === "wav" ? "audio/wav" : "audio/mpeg",
      size: buffer.length,
      provider: "xiaomi",
      modelId: normalized.modelId,
      ...(normalized.voice ? { voice: normalized.voice } : {}),
    };
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason ?? error;
    if (error instanceof XiaomiAudioError) throw error;
    if (controller.signal.aborted) {
      throw new XiaomiAudioError(
        "MiMo TTS request timed out",
        "音声合成がタイムアウトしました。",
      );
    }
    throw new XiaomiAudioError(`MiMo TTS transport failed: ${String(error)}`);
  } finally {
    dispose();
  }
}

function resolveContainer(
  filename: string,
  mime: string,
  buffer: Buffer,
): AudioContainer {
  const container =
    detectAudioContainer(buffer) ??
    containerFromMime(mime) ??
    containerFromFilename(filename);
  if (!container) {
    throw new XiaomiAudioError(
      `Unsupported audio format for ${filename}`,
      "対応していない音声形式です。MP3、WAV、M4A、OGG、FLAC、WebMなどを使用してください。",
      false,
    );
  }
  return container;
}

async function toGatewayFormat(
  buffer: Buffer,
  container: AudioContainer,
  signal?: AbortSignal,
): Promise<{ buffer: Buffer; format: (typeof MIMO_ASR_FORMATS)[number] }> {
  if (container === "mp3" || container === "wav") {
    return { buffer, format: container };
  }
  if (!(await isFfmpegAvailable())) {
    throw new XiaomiAudioError(
      `MiMo ASR accepts wav/mp3 only and ffmpeg is unavailable to convert ${container}`,
      "Xiaomi MiMo の音声認識はMP3とWAVのみ対応しています。ほかの形式はMP3またはWAVに変換して添付してください。",
      false,
    );
  }
  const wav = await transcodeToWav(buffer, signal);
  return { buffer: wav, format: "wav" };
}

function extractTranscript(payload: unknown): string {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const message = (choices[0] as { message?: { content?: unknown } })?.message;
  return typeof message?.content === "string" ? message.content.trim() : "";
}

export async function transcribeXiaomiAudio(args: {
  buffer: Buffer;
  filename: string;
  mime: string;
  signal?: AbortSignal;
  /** Used by deterministic tests; production callers let ffprobe inspect the bytes. */
  durationSeconds?: number;
}): Promise<string> {
  if (!isXiaomiAudioConfigured()) {
    throw new XiaomiAudioError(
      "Xiaomi MiMo credentials are not configured",
      "Xiaomi MiMo のAPI資格情報が設定されていないため音声を文字起こしできません。",
      false,
    );
  }
  if (!Buffer.isBuffer(args.buffer) || args.buffer.length === 0) {
    throw new XiaomiAudioError(
      "Audio buffer is empty",
      "音声ファイルが空です。",
      false,
    );
  }

  const container = resolveContainer(args.filename, args.mime, args.buffer);
  const duration =
    args.durationSeconds ?? (await probeAudioDurationSeconds(args.buffer));
  if (duration !== undefined && duration > MAX_ASR_DURATION_SECONDS) {
    throw new XiaomiAudioError(
      `Audio duration ${duration}s exceeds five-minute limit`,
      "音声は5分以内にしてください。",
      false,
    );
  }

  const { buffer, format } = await toGatewayFormat(
    args.buffer,
    container,
    args.signal,
  );
  const encoded = buffer.toString("base64");
  if (Math.ceil(encoded.length / 4) * 3 > MAX_ENCODED_AUDIO_BYTES) {
    throw new XiaomiAudioError(
      "Base64 audio data exceeds 10 MB",
      "音声データが大きすぎます。Base64変換後10MB以内にしてください。",
      false,
    );
  }

  const client = xiaomiClient as OpenAI;
  const { controller, dispose } = withTimeout(
    args.signal,
    "MiMo ASR request timed out",
  );

  try {
    const completion = await client.chat.completions.create(
      {
        model: MIMO_ASR_MODEL_ID,
        stream: false,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: encoded, format },
              },
            ],
          },
        ],
      } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { signal: controller.signal },
    );
    const text = extractTranscript(completion);
    if (!text) {
      throw new XiaomiAudioError("MiMo ASR returned no transcript");
    }
    logger.info(
      {
        component: "xiaomi-audio",
        provider: "xiaomi",
        modelId: MIMO_ASR_MODEL_ID,
        eventCode: "TRANSCRIPTION_COMPLETED",
      },
      "Audio transcription completed via Xiaomi MiMo ASR",
    );
    return text;
  } catch (error) {
    if (args.signal?.aborted) throw args.signal.reason ?? error;
    if (error instanceof XiaomiAudioError) throw error;
    if (controller.signal.aborted) {
      throw new XiaomiAudioError(
        "MiMo ASR request timed out",
        "音声認識がタイムアウトしました。",
      );
    }
    throw new XiaomiAudioError(`MiMo ASR transport failed: ${String(error)}`);
  } finally {
    dispose();
  }
}

export const MIMO_AUDIO_LIMITS = {
  maxTtsTextChars: MAX_TTS_TEXT_CHARS,
  maxTtsInstructionChars: MAX_TTS_INSTRUCTION_CHARS,
  maxTtsAudioBytes: MAX_TTS_AUDIO_BYTES,
  maxEncodedAudioBytes: MAX_ENCODED_AUDIO_BYTES,
  maxAsrDurationSeconds: MAX_ASR_DURATION_SECONDS,
} as const;
