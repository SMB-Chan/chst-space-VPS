import { randomUUID } from "node:crypto";
import { WebSocket } from "undici";
import {
  ALIBABA_CAPABILITY_DEFAULTS,
  modelHasAlibabaCapability,
} from "./alibaba-capabilities";
import {
  getAlibabaSpecialistConfig,
  resolveAlibabaTtsWebSocketUrl,
} from "./alibaba-specialist-config";
import type { GeneratedAsset } from "./generated-assets";
import { logger } from "./logger";

const MAX_TTS_TEXT_CHARS = 10_000;
const MAX_TTS_INSTRUCTION_CHARS = 1_000;
const MAX_TTS_AUDIO_BYTES = 32 * 1024 * 1024;
const TTS_TIMEOUT_MS = 90_000;
const DEFAULT_SAMPLE_RATE = 22_050;

export const QWEN_AUDIO_TTS_PLUS_VOICES = [
  "longanlingxin",
  "longanlufeng",
] as const;

export type QwenAudioTtsPlusVoice = (typeof QWEN_AUDIO_TTS_PLUS_VOICES)[number];
export type AlibabaTtsLanguageHint = "zh" | "en";

export interface AlibabaTtsRequest {
  text: string;
  modelId?: string;
  voice?: QwenAudioTtsPlusVoice;
  instruction?: string;
  languageHint?: AlibabaTtsLanguageHint;
  rate?: number;
  pitch?: number;
  volume?: number;
  signal?: AbortSignal;
}

export type AlibabaGeneratedSpeech = GeneratedAsset & {
  modelId: string;
  requestId?: string;
  voice: QwenAudioTtsPlusVoice;
};

export class AlibabaTtsError extends Error {
  readonly publicMessage: string;

  constructor(
    message: string,
    publicMessage = "音声合成に失敗しました。もう一度お試しください。",
  ) {
    super(message);
    this.name = "AlibabaTtsError";
    this.publicMessage = publicMessage;
  }
}

type SocketFactory = (url: URL, headers: Record<string, string>) => WebSocket;

function defaultSocketFactory(url: URL, headers: Record<string, string>): WebSocket {
  return new WebSocket(url, { headers });
}

function normalizeModel(modelId: string | undefined): string {
  const candidate = modelId?.trim() || ALIBABA_CAPABILITY_DEFAULTS["audio.tts"];
  if (!modelHasAlibabaCapability(candidate, "audio.tts") || candidate !== "qwen-audio-3.0-tts-plus") {
    throw new AlibabaTtsError(
      `Model ${candidate} is not allowed for this TTS transport`,
      "指定された音声合成モデルには対応していません。",
    );
  }
  return candidate;
}

function normalizeFiniteNumber(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new AlibabaTtsError(`${label} is outside the allowed range`);
  }
  return value;
}

function validateRequest(request: AlibabaTtsRequest): {
  text: string;
  modelId: string;
  voice: QwenAudioTtsPlusVoice;
  instruction?: string;
  languageHint?: AlibabaTtsLanguageHint;
  rate: number;
  pitch: number;
  volume: number;
} {
  const text = request.text.trim();
  if (!text) throw new AlibabaTtsError("TTS text is empty", "読み上げるテキストを指定してください。");
  if (text.length > MAX_TTS_TEXT_CHARS) {
    throw new AlibabaTtsError("TTS text exceeds application limit", "音声合成するテキストが長すぎます。1万文字以内にしてください。");
  }
  const instruction = request.instruction?.trim();
  if (instruction && instruction.length > MAX_TTS_INSTRUCTION_CHARS) {
    throw new AlibabaTtsError("TTS instruction exceeds application limit", "音声スタイルの指示が長すぎます。");
  }
  if (
    request.languageHint !== undefined &&
    request.languageHint !== "zh" &&
    request.languageHint !== "en"
  ) {
    throw new AlibabaTtsError(
      "Unsupported TTS language hint",
      "この音声合成モデルは中国語または英語に対応しています。",
    );
  }
  const voice = request.voice ?? "longanlingxin";
  if (!QWEN_AUDIO_TTS_PLUS_VOICES.includes(voice)) {
    throw new AlibabaTtsError("Unsupported Qwen Audio TTS Plus voice");
  }
  return {
    text,
    modelId: normalizeModel(request.modelId),
    voice,
    ...(instruction ? { instruction } : {}),
    ...(request.languageHint ? { languageHint: request.languageHint } : {}),
    rate: normalizeFiniteNumber(request.rate, 1, 0.5, 2, "rate"),
    pitch: normalizeFiniteNumber(request.pitch, 1, 0.5, 2, "pitch"),
    volume: normalizeFiniteNumber(request.volume, 50, 0, 100, "volume"),
  };
}

function jsonEvent(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "string") return null;
  try {
    const value = JSON.parse(data) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function binaryChunk(data: unknown): Promise<Buffer | null> {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return Buffer.from(await data.arrayBuffer());
  }
  return null;
}

export async function synthesizeAlibabaSpeech(
  request: AlibabaTtsRequest,
  env: NodeJS.ProcessEnv = process.env,
  socketFactory: SocketFactory = defaultSocketFactory,
): Promise<AlibabaGeneratedSpeech> {
  const specialist = getAlibabaSpecialistConfig(env);
  if (!specialist) {
    throw new AlibabaTtsError(
      "Regular Model Studio specialist credentials are not configured",
      "サーバー用の通常の Alibaba Model Studio API 資格情報が設定されていないため音声を生成できません。",
    );
  }
  const normalized = validateRequest(request);
  const url = resolveAlibabaTtsWebSocketUrl(env);
  const taskId = randomUUID();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${specialist.apiKey}`,
    "user-agent": "Chat-Space/Alibaba-TTS",
    ...(specialist.workspaceId ? { "X-DashScope-WorkSpace": specialist.workspaceId } : {}),
  };

  return new Promise<AlibabaGeneratedSpeech>((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = socketFactory(url, headers);
    } catch (error) {
      reject(new AlibabaTtsError(`Failed to create TTS WebSocket: ${String(error)}`));
      return;
    }
    socket.binaryType = "arraybuffer";
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let taskFinished = false;
    let finishRequested = false;
    let pendingMessages = 0;
    let settled = false;
    let requestId: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      request.signal?.removeEventListener("abort", onAbort);
      if (timeout) clearTimeout(timeout);
    };
    const closeSocket = () => {
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, "done");
        }
      } catch {
        // Best-effort close only.
      }
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      closeSocket();
      reject(error instanceof AlibabaTtsError ? error : new AlibabaTtsError(String(error)));
    };
    const finish = () => {
      if (settled) return;
      if (totalBytes <= 0) {
        fail(new AlibabaTtsError("TTS task finished without audio"));
        return;
      }
      taskFinished = true;
      settled = true;
      cleanup();
      closeSocket();
      const buffer = Buffer.concat(chunks, totalBytes);
      const filename = `alibaba-${normalized.modelId}-${Date.now()}.mp3`;
      logger.info(
        { modelId: normalized.modelId, voice: normalized.voice, bytes: buffer.length, requestId },
        "Alibaba speech synthesis completed",
      );
      resolve({
        buffer,
        filename,
        mimeType: "audio/mpeg",
        size: buffer.length,
        modelId: normalized.modelId,
        requestId,
        voice: normalized.voice,
      });
    };
    const finishWhenReady = () => {
      if (finishRequested && pendingMessages === 0) finish();
    };
    const onAbort = () => {
      fail(request.signal?.reason ?? new AlibabaTtsError("TTS request aborted"));
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) {
      onAbort();
      return;
    }
    timeout = setTimeout(() => {
      fail(new AlibabaTtsError("Alibaba TTS request timed out", "音声合成がタイムアウトしました。"));
    }, TTS_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      if (settled) return;
      socket.send(JSON.stringify({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: normalized.modelId,
          parameters: {
            text_type: "PlainText",
            voice: normalized.voice,
            format: "mp3",
            sample_rate: DEFAULT_SAMPLE_RATE,
            volume: normalized.volume,
            rate: normalized.rate,
            pitch: normalized.pitch,
            enable_ssml: false,
            enable_aigc_tag: true,
            ...(normalized.languageHint ? { language_hints: [normalized.languageHint] } : {}),
            ...(normalized.instruction ? { instruction: normalized.instruction } : {}),
          },
          input: {},
        },
      }));
    });

    socket.addEventListener("message", (event) => {
      pendingMessages += 1;
      void (async () => {
        if (settled) return;
        const control = jsonEvent(event.data);
        if (control) {
          const header = control.header && typeof control.header === "object"
            ? control.header as Record<string, unknown>
            : {};
          const eventName = typeof header.event === "string" ? header.event : "";
          const eventTaskId = typeof header.task_id === "string" ? header.task_id : "";
          if (eventTaskId && eventTaskId !== taskId) {
            fail(new AlibabaTtsError("TTS server returned a mismatched task id"));
            return;
          }
          if (typeof header.request_id === "string") requestId = header.request_id;
          const attributes = header.attributes && typeof header.attributes === "object"
            ? header.attributes as Record<string, unknown>
            : undefined;
          if (attributes && typeof attributes.request_uuid === "string") {
            requestId = attributes.request_uuid;
          }
          if (eventName === "task-started") {
            socket.send(JSON.stringify({
              header: { action: "continue-task", task_id: taskId, streaming: "duplex" },
              payload: { input: { text: normalized.text } },
            }));
            socket.send(JSON.stringify({
              header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
              payload: { input: {} },
            }));
            return;
          }
          if (eventName === "task-failed") {
            const detail = typeof header.error_message === "string"
              ? header.error_message.slice(0, 500)
              : "provider task failed";
            fail(new AlibabaTtsError(`Alibaba TTS task failed: ${detail}`));
            return;
          }
          if (eventName === "task-finished") {
            finishRequested = true;
            finishWhenReady();
          }
          return;
        }

        const chunk = await binaryChunk(event.data);
        if (!chunk || chunk.length === 0) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_TTS_AUDIO_BYTES) {
          fail(new AlibabaTtsError("Generated speech exceeds size limit", "生成された音声が大きすぎます。"));
          return;
        }
        chunks.push(chunk);
      })()
        .catch(fail)
        .finally(() => {
          pendingMessages -= 1;
          finishWhenReady();
        });
    });

    socket.addEventListener("error", (event) => {
      const detail = "message" in event && typeof event.message === "string"
        ? event.message
        : "WebSocket error";
      fail(new AlibabaTtsError(`Alibaba TTS WebSocket error: ${detail}`));
    });

    socket.addEventListener("close", () => {
      if (!settled && !taskFinished) {
        fail(new AlibabaTtsError("Alibaba TTS WebSocket closed before task completion"));
      }
    });
  });
}
