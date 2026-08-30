import { spawn } from "node:child_process";
import {
  getAlibabaSpecialistConfig,
  resolveAlibabaSpecialistHttpUrl,
} from "./alibaba-specialist-config";
import { logger } from "./logger";

const MAX_ENCODED_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_AUDIO_DURATION_SECONDS = 5 * 60;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_LANGUAGE_HINTS = 4;
const MAX_LANGUAGE_HINT_LENGTH = 16;

export type QwenAudioFormat = "mp3" | "wav" | "m4a" | "ogg" | "flac" | "webm" | "aac" | "amr";

export class AlibabaAsrError extends Error {
  readonly publicMessage: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    publicMessage = "音声を文字起こしできませんでした。",
    retryable = true,
  ) {
    super(message);
    this.name = "AlibabaAsrError";
    this.publicMessage = publicMessage;
    this.retryable = retryable;
  }
}

const FORMAT_MIME: Record<QwenAudioFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  aac: "audio/aac",
  amr: "audio/amr",
};

const MIME_FORMAT: Record<string, QwenAudioFormat> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "application/ogg": "ogg",
  "audio/flac": "flac",
  "audio/webm": "webm",
  "audio/aac": "aac",
  "audio/amr": "amr",
};

const EXTENSION_FORMAT: Record<string, QwenAudioFormat> = {
  mp3: "mp3",
  wav: "wav",
  wave: "wav",
  m4a: "m4a",
  m4b: "m4a",
  mp4: "m4a",
  ogg: "ogg",
  oga: "ogg",
  opus: "ogg",
  flac: "flac",
  webm: "webm",
  aac: "aac",
  amr: "amr",
};

function extensionFormat(filename: string): QwenAudioFormat | undefined {
  const extension = filename.trim().toLowerCase().split(".").pop() ?? "";
  return EXTENSION_FORMAT[extension];
}

function detectedFormat(buffer: Buffer): QwenAudioFormat | undefined {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
    return "wav";
  }
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "fLaC") return "flac";
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS") return "ogg";
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3) return "webm";
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") return "m4a";
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 6) === "#!AMR\n") return "amr";
  if (
    (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3") ||
    (buffer.length >= 2 && (buffer[0] & 0xe0) === 0xe0 && (buffer[1] & 0x06) !== 0)
  ) {
    return "mp3";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0) return "aac";
  return undefined;
}

function resolveAudioFormat(
  filename: string,
  mime: string,
  buffer: Buffer,
): QwenAudioFormat {
  const byMime = MIME_FORMAT[mime.trim().toLowerCase().split(";")[0]];
  const byExtension = extensionFormat(filename);
  const byContent = detectedFormat(buffer);
  const format = byContent ?? byMime ?? byExtension;
  if (!format) {
    throw new AlibabaAsrError(
      `Unsupported audio format for ${filename}`,
      "対応していない音声形式です。MP3、WAV、M4A、OGG、FLAC、WebMなどを使用してください。",
      false,
    );
  }
  if (byContent && byMime && byContent !== byMime) {
    throw new AlibabaAsrError(
      `Audio MIME type ${mime} does not match detected ${byContent}`,
      "音声ファイルの実形式とMIMEタイプが一致しません。",
      false,
    );
  }
  if (byContent && byExtension && byContent !== byExtension) {
    throw new AlibabaAsrError(
      `Audio filename extension does not match detected ${byContent}`,
      "音声ファイルの拡張子と実形式が一致しません。",
      false,
    );
  }
  return format;
}

function wavSampleRate(buffer: Buffer): number | undefined {
  if (detectedFormat(buffer) !== "wav" || buffer.length < 28) return undefined;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt " && offset + 16 <= buffer.length) {
      const sampleRate = buffer.readUInt32LE(offset + 12);
      return sampleRate >= 8_000 && sampleRate <= 192_000 ? sampleRate : undefined;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return undefined;
}

async function probeDuration(buffer: Buffer): Promise<number | undefined> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        "-",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const finish = (value: number | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 128) child.kill();
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (code !== 0) return finish(undefined);
      const duration = Number.parseFloat(output.trim());
      finish(Number.isFinite(duration) && duration >= 0 ? duration : undefined);
    });
    child.stdin.on("error", () => finish(undefined));
    child.stdin.end(buffer);
  });
}

async function readBoundedResponse(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new AlibabaAsrError("Qwen ASR response exceeds size limit");
  }
  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_RESPONSE_BYTES) throw new AlibabaAsrError("Qwen ASR response exceeds size limit");
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AlibabaAsrError("Qwen ASR response exceeds size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function normalizeLanguageHints(languageHints: string[] | undefined): string[] {
  if (!languageHints?.length) return [];
  if (languageHints.length > MAX_LANGUAGE_HINTS) {
    throw new AlibabaAsrError(
      "Too many ASR language hints",
      "音声認識の言語ヒントは4件まで指定できます。",
      false,
    );
  }
  const normalized = languageHints.map((hint) => hint.trim().toLowerCase());
  if (
    normalized.some(
      (hint) =>
        hint.length === 0 ||
        hint.length > MAX_LANGUAGE_HINT_LENGTH ||
        !/^[a-z]{2,8}(?:-[a-z0-9]{2,8})?$/.test(hint),
    )
  ) {
    throw new AlibabaAsrError("Invalid ASR language hint", "音声認識の言語ヒントが不正です。", false);
  }
  return [...new Set(normalized)];
}

function extractTranscript(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const root = payload as Record<string, unknown>;
  const output = root.output;
  if (!output || typeof output !== "object") return "";
  const outputRecord = output as Record<string, unknown>;
  const nested = outputRecord.output;
  if (nested && typeof nested === "object") {
    const sentence = (nested as Record<string, unknown>).sentence;
    if (sentence && typeof sentence === "object") {
      const text = (sentence as Record<string, unknown>).text;
      if (typeof text === "string") return text.trim();
    }
  }
  return typeof outputRecord.text === "string" ? outputRecord.text.trim() : "";
}

export async function transcribeQwenAudio(args: {
  buffer: Buffer;
  filename: string;
  mime: string;
  languageHints?: string[];
  signal?: AbortSignal;
  /** Used by deterministic tests; production callers let ffprobe inspect the bytes. */
  durationSeconds?: number;
}, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const specialist = getAlibabaSpecialistConfig(env);
  if (!specialist) {
    throw new AlibabaAsrError(
      "Regular Model Studio specialist credentials are not configured",
      "サーバー用の通常の Alibaba Model Studio API 資格情報が設定されていません。",
      false,
    );
  }
  if (!Buffer.isBuffer(args.buffer) || args.buffer.length === 0) {
    throw new AlibabaAsrError("Audio buffer is empty", "音声ファイルが空です。", false);
  }

  const format = resolveAudioFormat(args.filename, args.mime, args.buffer);
  const estimatedBase64Bytes = Math.ceil(args.buffer.length / 3) * 4;
  if (estimatedBase64Bytes + 64 > MAX_ENCODED_AUDIO_BYTES) {
    throw new AlibabaAsrError(
      "Base64 audio data URL exceeds 10 MB",
      "音声データが大きすぎます。Base64変換後10MB以内にしてください。",
      false,
    );
  }
  const encodedAudio = args.buffer.toString("base64");
  const dataUrl = `data:${FORMAT_MIME[format]};base64,${encodedAudio}`;
  if (Buffer.byteLength(dataUrl, "utf8") > MAX_ENCODED_AUDIO_BYTES) {
    throw new AlibabaAsrError(
      "Base64 audio data URL exceeds 10 MB",
      "音声データが大きすぎます。Base64変換後10MB以内にしてください。",
      false,
    );
  }

  const duration = args.durationSeconds ?? (await probeDuration(args.buffer));
  if (duration !== undefined && duration > MAX_AUDIO_DURATION_SECONDS) {
    throw new AlibabaAsrError(
      `Audio duration ${duration}s exceeds five-minute limit`,
      "音声は5分以内にしてください。",
      false,
    );
  }

  const languageHints = normalizeLanguageHints(args.languageHints);
  const controller = new AbortController();
  const onAbort = () => controller.abort(args.signal?.reason ?? new Error("Audio transcription aborted"));
  if (args.signal?.aborted) onAbort();
  else args.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Qwen ASR request timed out")),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const endpoint = resolveAlibabaSpecialistHttpUrl(
      "services/aigc/multimodal-generation/generation",
      env,
    );
    const parameters: Record<string, unknown> = { format };
    const sampleRate = wavSampleRate(args.buffer);
    if (sampleRate !== undefined) parameters.sample_rate = String(sampleRate);
    if (languageHints.length > 0) parameters.language_hints = languageHints;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${specialist.apiKey}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "disable",
        ...(specialist.workspaceId ? { "X-DashScope-WorkSpace": specialist.workspaceId } : {}),
      },
      body: JSON.stringify({
        model: "qwen-audio-3.0-asr-flash",
        input: {
          messages: [
            {
              role: "user",
              content: [{ type: "input_audio", input_audio: { data: dataUrl } }],
            },
          ],
        },
        parameters,
      }),
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readBoundedResponse(response);
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      throw new AlibabaAsrError("Qwen ASR returned invalid JSON");
    }
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    if (!response.ok || typeof record.code === "string") {
      const providerMessage =
        typeof record.message === "string"
          ? record.message.slice(0, 500)
          : `HTTP ${response.status}`;
      throw new AlibabaAsrError(`Qwen ASR failed: ${providerMessage}`);
    }
    const text = extractTranscript(payload);
    if (!text) throw new AlibabaAsrError("Qwen ASR returned no transcript");
    logger.info(
      { model: "qwen-audio-3.0-asr-flash", filename: args.filename, format, outputCharacters: text.length },
      "Audio transcription completed via Qwen ASR",
    );
    return text;
  } catch (error) {
    if (args.signal?.aborted) throw args.signal.reason ?? error;
    if (error instanceof AlibabaAsrError) throw error;
    if (controller.signal.aborted) {
      throw new AlibabaAsrError("Qwen ASR request timed out", "音声認識がタイムアウトしました。");
    }
    throw new AlibabaAsrError(`Qwen ASR transport failed: ${String(error)}`);
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener("abort", onAbort);
  }
}

export const QWEN_ASR_LIMITS = {
  maxEncodedAudioBytes: MAX_ENCODED_AUDIO_BYTES,
  maxDurationSeconds: MAX_AUDIO_DURATION_SECONDS,
  maxResponseBytes: MAX_RESPONSE_BYTES,
} as const;