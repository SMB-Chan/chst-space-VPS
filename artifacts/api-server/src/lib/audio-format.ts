import { spawn } from "node:child_process";

/**
 * Container detection shared by every speech provider. Each provider accepts a
 * different subset of containers, so detection stays neutral here and the
 * transports decide what to do with the result.
 */

export type AudioContainer =
  "mp3" | "wav" | "m4a" | "ogg" | "flac" | "webm" | "aac" | "amr";

export const CONTAINER_MIME: Record<AudioContainer, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  webm: "audio/webm",
  aac: "audio/aac",
  amr: "audio/amr",
};

const MIME_CONTAINER: Record<string, AudioContainer> = {
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

const EXTENSION_CONTAINER: Record<string, AudioContainer> = {
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

export function containerFromMime(mime: string): AudioContainer | undefined {
  return MIME_CONTAINER[mime.trim().toLowerCase().split(";")[0]];
}

export function containerFromFilename(
  filename: string,
): AudioContainer | undefined {
  const extension = filename.trim().toLowerCase().split(".").pop() ?? "";
  return EXTENSION_CONTAINER[extension];
}

export function detectAudioContainer(
  buffer: Buffer,
): AudioContainer | undefined {
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  ) {
    return "wav";
  }
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "fLaC")
    return "flac";
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS")
    return "ogg";
  if (buffer.length >= 4 && buffer.readUInt32BE(0) === 0x1a45dfa3)
    return "webm";
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp")
    return "m4a";
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 6) === "#!AMR\n")
    return "amr";
  if (
    (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3") ||
    (buffer.length >= 2 &&
      buffer[0] === 0xff &&
      (buffer[1] & 0xe0) === 0xe0 &&
      (buffer[1] & 0x18) !== 0 &&
      (buffer[1] & 0x06) !== 0)
  ) {
    return "mp3";
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xf6) === 0xf0)
    return "aac";
  return undefined;
}

export function wavSampleRate(buffer: Buffer): number | undefined {
  if (detectAudioContainer(buffer) !== "wav" || buffer.length < 28)
    return undefined;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt " && offset + 16 <= buffer.length) {
      const sampleRate = buffer.readUInt32LE(offset + 12);
      return sampleRate >= 8_000 && sampleRate <= 192_000
        ? sampleRate
        : undefined;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return undefined;
}

/** Returns undefined when ffprobe is missing or cannot read the bytes. */
export function probeAudioDurationSeconds(
  buffer: Buffer,
): Promise<number | undefined> {
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

let cachedFfmpegAvailable: boolean | null = null;

function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("which", [command], { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

export async function isFfmpegAvailable(): Promise<boolean> {
  if (cachedFfmpegAvailable !== null) return cachedFfmpegAvailable;
  cachedFfmpegAvailable = await commandExists("ffmpeg");
  return cachedFfmpegAvailable;
}

export function resetFfmpegAvailabilityCache(): void {
  cachedFfmpegAvailable = null;
}

const TRANSCODE_TIMEOUT_MS = 60_000;

/**
 * Re-encode any container ffmpeg can read into 16 kHz mono PCM WAV, the lowest
 * common denominator for providers that only accept a couple of formats.
 */
export async function transcodeToWav(
  buffer: Buffer,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        "pipe:0",
        "-f",
        "wav",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const finish = (error: Error | null, value?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value as Buffer);
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(signal?.reason ?? new Error("Audio transcode aborted"));
    };
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new Error(`Audio transcode timed out after ${TRANSCODE_TIMEOUT_MS}ms`),
      );
    }, TRANSCODE_TIMEOUT_MS);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        const wav = Buffer.concat(chunks);
        if (wav.length === 0) {
          finish(new Error("Audio transcode produced no output"));
          return;
        }
        finish(null, wav);
        return;
      }
      finish(
        new Error(
          `Audio transcode failed (exit ${code}): ${stderr.slice(0, 500)}`,
        ),
      );
    });
    child.stdin.on("error", () => {
      // Reported through the close handler.
    });
    child.stdin.end(buffer);
  });
}
