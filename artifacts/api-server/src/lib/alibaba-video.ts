import {
  ALIBABA_CAPABILITY_DEFAULTS,
  modelHasAlibabaCapability,
  type AlibabaCapability,
} from "./alibaba-capabilities";
import {
  getAlibabaSpecialistConfig,
  resolveAlibabaSpecialistHttpUrl,
} from "./alibaba-specialist-config";

export const HAPPYHORSE_VIDEO_POLL_INTERVAL_MS = 15_000;
export const HAPPYHORSE_DEFAULT_RESOLUTION = "720P" as const;
export const HAPPYHORSE_DEFAULT_DURATION_SECONDS = 5 as const;
export const HAPPYHORSE_ALLOWED_RESOLUTIONS = ["720P", "1080P"] as const;
export const HAPPYHORSE_ALLOWED_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export const HAPPYHORSE_MAX_PROMPT_CHARS = 16_000;
export const HAPPYHORSE_MAX_INPUT_IMAGE_URL_CHARS = 16 * 1024 * 1024;
export const HAPPYHORSE_MAX_INPUT_IMAGE_BYTES = 12 * 1024 * 1024;
export const HAPPYHORSE_MAX_RESULT_VIDEO_BYTES = 64 * 1024 * 1024;
export const HAPPYHORSE_MAX_SEED = 2_147_483_647;

export type HappyHorseVideoMode = "t2v" | "i2v" | "r2v";
export type HappyHorseVideoResolution = (typeof HAPPYHORSE_ALLOWED_RESOLUTIONS)[number];
export type HappyHorseVideoAspectRatio = (typeof HAPPYHORSE_ALLOWED_ASPECT_RATIOS)[number];
export type HappyHorseVideoStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "UNKNOWN";

export interface HappyHorseVideoSettings {
  resolution?: HappyHorseVideoResolution;
  durationSeconds?: number;
  aspectRatio?: HappyHorseVideoAspectRatio;
  watermark?: boolean;
  seed?: number;
}

export interface HappyHorseVideoRequest extends HappyHorseVideoSettings {
  mode: HappyHorseVideoMode;
  prompt: string;
  images?: readonly string[];
  modelId?: string;
  signal?: AbortSignal;
}

export interface NormalizedHappyHorseVideoRequest {
  mode: HappyHorseVideoMode;
  prompt: string;
  images: string[];
  modelId: string;
  resolution: HappyHorseVideoResolution;
  durationSeconds: number;
  aspectRatio: HappyHorseVideoAspectRatio;
  watermark: boolean;
  seed?: number;
  signal?: AbortSignal;
}

export interface HappyHorseVideoTask {
  taskId: string;
  status: HappyHorseVideoStatus;
  resultUrl?: string;
  message?: string;
}

export interface HappyHorseVideoAsset {
  buffer: Buffer;
  filename: string;
  mimeType: "video/mp4";
  size: number;
  modelId: string;
  taskId: string;
}

export class AlibabaVideoError extends Error {
  readonly publicMessage: string;

  constructor(
    message: string,
    publicMessage = "動画生成に失敗しました。もう一度お試しください。",
  ) {
    super(message);
    this.name = "AlibabaVideoError";
    this.publicMessage = publicMessage;
  }
}

const VIDEO_CAPABILITY_BY_MODE: Record<HappyHorseVideoMode, AlibabaCapability> = {
  t2v: "video.t2v",
  i2v: "video.i2v",
  r2v: "video.r2v",
};

const DEFAULT_MODEL_BY_MODE: Record<HappyHorseVideoMode, string> = {
  t2v: ALIBABA_CAPABILITY_DEFAULTS["video.t2v"],
  i2v: ALIBABA_CAPABILITY_DEFAULTS["video.i2v"],
  r2v: ALIBABA_CAPABILITY_DEFAULTS["video.r2v"],
};

function isHappyHorseMode(value: unknown): value is HappyHorseVideoMode {
  return value === "t2v" || value === "i2v" || value === "r2v";
}

function trustedAlibabaMediaUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AlibabaVideoError(`Invalid ${label} URL`, `${label}のURLが不正です。`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    !(hostname === "aliyuncs.com" || hostname.endsWith(".aliyuncs.com")) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new AlibabaVideoError(`Untrusted ${label} URL`, `${label}の取得先が許可されていません。`);
  }
  return url;
}

function decodeImageDataUrl(value: string): Buffer | null {
  const match = /^data:image\/(?:png|jpeg|jpg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
  if (!match) return null;
  const encoded = match[1];
  const decoded = Buffer.from(encoded, "base64");
  const canonical = decoded.toString("base64").replace(/=+$/, "");
  if (canonical !== encoded.replace(/=+$/, "")) {
    throw new AlibabaVideoError("Image Data URL is not canonical", "入力画像のBase64形式が不正です。");
  }
  if (decoded.length === 0 || decoded.length > HAPPYHORSE_MAX_INPUT_IMAGE_BYTES) {
    throw new AlibabaVideoError("Input image exceeds size limit", "入力画像が大きすぎます。");
  }
  const isPng = decoded.length >= 4 && decoded.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const isJpeg = decoded.length >= 3 && decoded.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  const isWebp =
    decoded.length >= 12 &&
    decoded.subarray(0, 4).toString("ascii") === "RIFF" &&
    decoded.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isPng && !isJpeg && !isWebp) {
    throw new AlibabaVideoError("Input image magic bytes do not match its MIME type", "入力画像の内容を確認できません。");
  }
  return decoded;
}

function validateInputImage(value: string): void {
  if (!value || value.length > HAPPYHORSE_MAX_INPUT_IMAGE_URL_CHARS) {
    throw new AlibabaVideoError("Input image exceeds size limit", "入力画像が大きすぎます。");
  }
  if (decodeImageDataUrl(value)) return;
  if (/^data:/i.test(value)) {
    throw new AlibabaVideoError("Input image must be a supported base64 image", "入力画像の形式に対応していません。");
  }
  trustedAlibabaMediaUrl(value, "入力画像");
}

function normalizeSettings(request: HappyHorseVideoRequest): Omit<
  NormalizedHappyHorseVideoRequest,
  "mode" | "prompt" | "images" | "modelId" | "signal"
> {
  const resolution = request.resolution ?? HAPPYHORSE_DEFAULT_RESOLUTION;
  if (!(HAPPYHORSE_ALLOWED_RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new AlibabaVideoError("Invalid video resolution", "動画解像度は720Pまたは1080Pにしてください。");
  }

  const durationSeconds = request.durationSeconds ?? HAPPYHORSE_DEFAULT_DURATION_SECONDS;
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 3 || durationSeconds > 15) {
    throw new AlibabaVideoError("Invalid video duration", "動画の長さは3〜15秒にしてください。");
  }

  const aspectRatio = request.aspectRatio ?? "16:9";
  if (!(HAPPYHORSE_ALLOWED_ASPECT_RATIOS as readonly string[]).includes(aspectRatio)) {
    throw new AlibabaVideoError("Invalid video aspect ratio", "動画の縦横比が対応していません。");
  }

  const watermark = request.watermark ?? false;
  if (typeof watermark !== "boolean") {
    throw new AlibabaVideoError("Invalid watermark option", "透かし設定が不正です。");
  }

  if (
    request.seed !== undefined &&
    (!Number.isSafeInteger(request.seed) || request.seed < 0 || request.seed > HAPPYHORSE_MAX_SEED)
  ) {
    throw new AlibabaVideoError("Invalid video seed", "seed の指定が不正です。");
  }

  return { resolution, durationSeconds, aspectRatio, watermark, ...(request.seed !== undefined ? { seed: request.seed } : {}) };
}

export function normalizeHappyHorseVideoRequest(
  request: HappyHorseVideoRequest,
): NormalizedHappyHorseVideoRequest {
  if (!isHappyHorseMode(request.mode)) {
    throw new AlibabaVideoError("Invalid video mode", "動画生成方式が不正です。");
  }
  const prompt = request.prompt.trim();
  if (!prompt) throw new AlibabaVideoError("Video prompt is empty", "動画の内容を指定してください。");
  if (prompt.length > HAPPYHORSE_MAX_PROMPT_CHARS) {
    throw new AlibabaVideoError("Video prompt is too long", "動画生成の指示が長すぎます。");
  }

  const images = [...(request.images ?? [])];
  const expectedImages = request.mode === "t2v" ? 0 : request.mode === "i2v" ? 1 : undefined;
  if (expectedImages !== undefined && images.length !== expectedImages) {
    throw new AlibabaVideoError(
      request.mode === "i2v"
        ? "I2V requires exactly one image"
        : "T2V does not accept input images",
      request.mode === "i2v" ? "I2Vは先頭画像を1枚だけ指定してください。" : "T2Vでは画像を添付しないでください。",
    );
  }
  if (request.mode === "r2v" && (images.length < 1 || images.length > 9)) {
    throw new AlibabaVideoError("R2V requires 1-9 ordered images", "R2Vの参照画像は順序付きで1〜9枚にしてください。");
  }
  images.forEach(validateInputImage);

  const capability = VIDEO_CAPABILITY_BY_MODE[request.mode];
  const modelId = request.modelId?.trim() || DEFAULT_MODEL_BY_MODE[request.mode];
  if (!modelHasAlibabaCapability(modelId, capability)) {
    throw new AlibabaVideoError(
      `Model ${modelId} does not support ${capability}`,
      "指定されたHappyHorseモデルはこの動画生成方式に対応していません。",
    );
  }

  return {
    mode: request.mode,
    prompt,
    images,
    modelId,
    ...normalizeSettings(request),
    ...(request.signal ? { signal: request.signal } : {}),
  };
}

export interface HappyHorseSubmitPayload {
  model: string;
  input: {
    prompt: string;
    image_url?: string;
    reference_images?: string[];
  };
  parameters: {
    resolution: HappyHorseVideoResolution;
    duration: number;
    aspect_ratio: HappyHorseVideoAspectRatio;
    watermark: boolean;
    seed?: number;
  };
}

export function buildHappyHorseSubmitPayload(
  request: NormalizedHappyHorseVideoRequest | HappyHorseVideoRequest,
): HappyHorseSubmitPayload {
  const normalized = normalizeHappyHorseVideoRequest(request);
  const input: HappyHorseSubmitPayload["input"] = { prompt: normalized.prompt };
  if (normalized.mode === "i2v") input.image_url = normalized.images[0];
  if (normalized.mode === "r2v") input.reference_images = [...normalized.images];
  return {
    model: normalized.modelId,
    input,
    parameters: {
      resolution: normalized.resolution,
      duration: normalized.durationSeconds,
      aspect_ratio: normalized.aspectRatio,
      watermark: normalized.watermark,
      ...(normalized.seed !== undefined ? { seed: normalized.seed } : {}),
    },
  };
}

type FetchLike = typeof fetch;

interface AlibabaVideoApiResponse {
  output?: {
    task_id?: unknown;
    task_status?: unknown;
    status?: unknown;
    video_url?: unknown;
    result_url?: unknown;
    results?: Array<{ url?: unknown }>;
  };
  request_id?: unknown;
  code?: unknown;
  message?: unknown;
}

function taskIdFromPayload(payload: AlibabaVideoApiResponse): string {
  const taskId = payload.output?.task_id;
  if (typeof taskId !== "string" || !/^[A-Za-z0-9:_-]{1,256}$/.test(taskId)) {
    throw new AlibabaVideoError("Alibaba video API returned no valid task ID");
  }
  return taskId;
}

function normalizeStatus(value: unknown): HappyHorseVideoStatus {
  if (value === "PENDING" || value === "RUNNING" || value === "SUCCEEDED" || value === "FAILED" || value === "CANCELED") {
    return value;
  }
  if (value === "CANCELLED") return "CANCELED";
  return "UNKNOWN";
}

function resultUrlFromPayload(payload: AlibabaVideoApiResponse): string | undefined {
  const candidates = [
    payload.output?.video_url,
    payload.output?.result_url,
    ...(payload.output?.results ?? []).map((result) => result.url),
  ];
  return candidates.find((value): value is string => typeof value === "string" && value.length > 0);
}

async function readJson(response: Response): Promise<AlibabaVideoApiResponse> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new AlibabaVideoError(`Alibaba video API returned unreadable JSON: ${String(error)}`);
  }
  if (text.length > 1_000_000) throw new AlibabaVideoError("Alibaba video API response is too large");
  try {
    return JSON.parse(text) as AlibabaVideoApiResponse;
  } catch (error) {
    throw new AlibabaVideoError(`Alibaba video API returned invalid JSON: ${String(error)}`);
  }
}

function providerError(response: Response, payload: AlibabaVideoApiResponse): AlibabaVideoError {
  const providerMessage = typeof payload.message === "string" ? payload.message : `HTTP ${response.status}`;
  return new AlibabaVideoError(`Alibaba video API failed: ${providerMessage}`);
}

export class AlibabaVideoHttpTransport {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike;

  constructor(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl: FetchLike = fetch,
  ) {
    this.env = env;
    this.fetchImpl = fetchImpl;
  }

  private async request(
    endpoint: URL,
    init: RequestInit,
  ): Promise<AlibabaVideoApiResponse> {
    const specialist = getAlibabaSpecialistConfig(this.env);
    if (!specialist) {
      throw new AlibabaVideoError(
        "Regular Model Studio specialist credentials are not configured",
        "サーバー用の通常の Alibaba Model Studio API 資格情報が設定されていないため動画を生成できません。",
      );
    }
    const response = await this.fetchImpl(endpoint, {
      ...init,
      headers: {
        Authorization: `Bearer ${specialist.apiKey}`,
        "Content-Type": "application/json",
        ...(specialist.workspaceId ? { "X-DashScope-WorkSpace": specialist.workspaceId } : {}),
        ...(init.headers ?? {}),
      },
    });
    const payload = await readJson(response);
    if (!response.ok || payload.code) throw providerError(response, payload);
    return payload;
  }

  async submit(request: HappyHorseVideoRequest): Promise<{ taskId: string; modelId: string }> {
    const normalized = normalizeHappyHorseVideoRequest(request);
    const endpoint = resolveAlibabaSpecialistHttpUrl(
      "services/aigc/video-generation/video-synthesis",
      this.env,
    );
    const payload = await this.request(endpoint, {
      method: "POST",
      headers: { "X-DashScope-Async": "enable" },
      body: JSON.stringify(buildHappyHorseSubmitPayload(normalized)),
      signal: normalized.signal,
    });
    return { taskId: taskIdFromPayload(payload), modelId: normalized.modelId };
  }

  async status(taskId: string, signal?: AbortSignal): Promise<HappyHorseVideoTask> {
    if (!/^[A-Za-z0-9:_-]{1,256}$/.test(taskId)) {
      throw new AlibabaVideoError("Invalid remote video task ID");
    }
    const endpoint = resolveAlibabaSpecialistHttpUrl(`tasks/${encodeURIComponent(taskId)}`, this.env);
    const payload = await this.request(endpoint, { method: "GET", signal });
    const status = normalizeStatus(payload.output?.task_status ?? payload.output?.status);
    return {
      taskId,
      status,
      ...(resultUrlFromPayload(payload) ? { resultUrl: resultUrlFromPayload(payload) } : {}),
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    };
  }

  async cancel(taskId: string, signal?: AbortSignal): Promise<HappyHorseVideoTask> {
    if (!/^[A-Za-z0-9:_-]{1,256}$/.test(taskId)) {
      throw new AlibabaVideoError("Invalid remote video task ID");
    }
    const endpoint = resolveAlibabaSpecialistHttpUrl(
      `tasks/${encodeURIComponent(taskId)}/cancel`,
      this.env,
    );
    const payload = await this.request(endpoint, { method: "POST", signal });
    return {
      taskId,
      status: normalizeStatus(payload.output?.task_status ?? payload.output?.status ?? "CANCELED"),
      ...(typeof payload.message === "string" ? { message: payload.message } : {}),
    };
  }
}

export interface HappyHorseVideoTransport {
  submit(request: HappyHorseVideoRequest): Promise<{ taskId: string; modelId: string }>;
  status(taskId: string, signal?: AbortSignal): Promise<HappyHorseVideoTask>;
  cancel(taskId: string, signal?: AbortSignal): Promise<HappyHorseVideoTask>;
}

const TERMINAL_STATUSES = new Set<HappyHorseVideoStatus>([
  "SUCCEEDED",
  "FAILED",
  "CANCELED",
  "UNKNOWN",
]);

function waitForNextPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Video polling cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Video polling cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function pollHappyHorseVideoTask(
  transport: HappyHorseVideoTransport,
  taskId: string,
  options: { signal?: AbortSignal; pollIntervalMs?: number } = {},
): Promise<HappyHorseVideoTask> {
  const pollIntervalMs = options.pollIntervalMs ?? HAPPYHORSE_VIDEO_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new AlibabaVideoError("Invalid video polling interval");
  }
  while (true) {
    const task = await transport.status(taskId, options.signal);
    if (TERMINAL_STATUSES.has(task.status)) return task;
    await waitForNextPoll(pollIntervalMs, options.signal);
  }
}

async function readBoundedVideoResponse(response: Response): Promise<Buffer> {
  const declared = Number(response.headers?.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > HAPPYHORSE_MAX_RESULT_VIDEO_BYTES) {
    throw new AlibabaVideoError("Generated video exceeds size limit", "生成動画が大きすぎます。");
  }
  const contentType = response.headers?.get("content-type")?.toLowerCase() ?? "";
  if (contentType !== "video/mp4") {
    throw new AlibabaVideoError("Generated video is not MP4", "生成結果がMP4動画ではありません。");
  }
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0 || data.length > HAPPYHORSE_MAX_RESULT_VIDEO_BYTES) {
      throw new AlibabaVideoError("Generated video exceeds size limit", "生成動画が大きすぎます。");
    }
    return data;
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
      if (total > HAPPYHORSE_MAX_RESULT_VIDEO_BYTES) {
        await reader.cancel();
        throw new AlibabaVideoError("Generated video exceeds size limit", "生成動画が大きすぎます。");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new AlibabaVideoError("Generated video is empty");
  return Buffer.concat(chunks, total);
}

export async function downloadHappyHorseVideoResult(
  resultUrl: string,
  signal?: AbortSignal,
  fetchImpl: FetchLike = fetch,
): Promise<Buffer> {
  const url = trustedAlibabaMediaUrl(resultUrl, "生成動画");
  const response = await fetchImpl(url, { signal, redirect: "error" });
  if (!response.ok) throw new AlibabaVideoError(`Failed to download generated video: HTTP ${response.status}`);
  return readBoundedVideoResponse(response);
}

export async function runHappyHorseVideoJob(
  transport: HappyHorseVideoTransport,
  request: HappyHorseVideoRequest,
  options: { signal?: AbortSignal; pollIntervalMs?: number; fetchImpl?: FetchLike } = {},
): Promise<HappyHorseVideoTask & { asset: HappyHorseVideoAsset }> {
  const normalized = normalizeHappyHorseVideoRequest(request);
  const submitted = await transport.submit(normalized);
  const task = await pollHappyHorseVideoTask(transport, submitted.taskId, {
    signal: options.signal ?? normalized.signal,
    pollIntervalMs: options.pollIntervalMs,
  });
  if (task.status !== "SUCCEEDED") {
    throw new AlibabaVideoError(
      `HappyHorse task ${task.taskId} ended with ${task.status}`,
      task.status === "CANCELED"
        ? "動画生成をキャンセルしました。"
        : task.status === "UNKNOWN"
          ? "動画生成の状態を確認できませんでした。"
          : "動画生成に失敗しました。",
    );
  }
  if (!task.resultUrl) throw new AlibabaVideoError("Succeeded video task returned no result URL");
  const buffer = await downloadHappyHorseVideoResult(task.resultUrl, options.signal ?? normalized.signal, options.fetchImpl);
  return {
    ...task,
    asset: {
      buffer,
      filename: `happyhorse-${normalized.mode}-${task.taskId}.mp4`,
      mimeType: "video/mp4",
      size: buffer.length,
      modelId: submitted.modelId,
      taskId: task.taskId,
    },
  };
}