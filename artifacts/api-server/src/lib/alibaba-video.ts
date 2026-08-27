import { isIP } from "node:net";
import {
  ALIBABA_CAPABILITY_DEFAULTS,
  modelHasAlibabaCapability,
} from "./alibaba-capabilities";
import {
  getAlibabaSpecialistConfig,
  resolveAlibabaSpecialistHttpUrl,
} from "./alibaba-specialist-config";
import { logger } from "./logger";

const MAX_PROMPT_CHARS = 5_000;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REFERENCE_DATA_URL_CHARS = Math.ceil(MAX_REFERENCE_IMAGE_BYTES * 4 / 3) + 128;
const MAX_GENERATED_VIDEO_BYTES = 256 * 1024 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export const ALIBABA_VIDEO_POLL_INTERVAL_MS = 15_000;

export type AlibabaVideoMode = "t2v" | "i2v" | "r2v";
export type AlibabaVideoResolution = "720P" | "1080P";
export type AlibabaVideoRatio =
  | "16:9"
  | "9:16"
  | "1:1"
  | "4:3"
  | "3:4"
  | "4:5"
  | "5:4"
  | "9:21"
  | "21:9";
export type AlibabaVideoTaskStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELED"
  | "UNKNOWN";

export interface AlibabaVideoRequest {
  mode: AlibabaVideoMode;
  prompt: string;
  modelId?: string;
  referenceImages?: string[];
  resolution?: AlibabaVideoResolution;
  ratio?: AlibabaVideoRatio;
  duration?: number;
  watermark?: boolean;
  seed?: number;
  signal?: AbortSignal;
}

export interface AlibabaVideoTask {
  taskId: string;
  status: AlibabaVideoTaskStatus;
  requestId?: string;
  videoUrl?: string;
  code?: string;
  message?: string;
}

export interface AlibabaGeneratedVideo {
  buffer: Buffer;
  filename: string;
  mimeType: "video/mp4";
  size: number;
  taskId: string;
  modelId: string;
  requestId?: string;
}

interface AlibabaVideoApiResponse {
  output?: {
    task_id?: string;
    task_status?: string;
    video_url?: string;
    code?: string;
    message?: string;
  };
  request_id?: string;
  code?: string;
  message?: string;
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

function capabilityForMode(
  mode: AlibabaVideoMode,
): "video.t2v" | "video.i2v" | "video.r2v" {
  return `video.${mode}`;
}

function normalizeVideoModel(mode: AlibabaVideoMode, modelId: string | undefined): string {
  const capability = capabilityForMode(mode);
  const candidate = modelId?.trim() || ALIBABA_CAPABILITY_DEFAULTS[capability];
  if (!candidate || !modelHasAlibabaCapability(candidate, capability)) {
    throw new AlibabaVideoError(
      `Model ${candidate || "(empty)"} does not support ${capability}`,
      "指定された動画モデルはこの処理に対応していません。",
    );
  }
  return candidate;
}

function validateReferenceImage(value: string): void {
  if (value.length > MAX_REFERENCE_DATA_URL_CHARS) {
    throw new AlibabaVideoError("Reference image is too large", "参照画像が大きすぎます。");
  }

  const dataMatch = value.match(
    /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/i,
  );
  if (dataMatch) {
    const encoded = dataMatch[1];
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    const decodedBytes = Math.floor(encoded.length * 3 / 4) - padding;
    if (decodedBytes <= 0 || decodedBytes > MAX_REFERENCE_IMAGE_BYTES) {
      throw new AlibabaVideoError("Reference image is too large", "参照画像が大きすぎます。");
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AlibabaVideoError("Invalid reference image URL", "参照画像の形式に対応していません。");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    isIP(hostname) !== 0 ||
    (hostname.startsWith("[") && hostname.endsWith("]"))
  ) {
    throw new AlibabaVideoError(
      "Reference image must use a public HTTPS hostname",
      "参照画像の形式に対応していません。",
    );
  }
}

function validateRequest(request: AlibabaVideoRequest): {
  modelId: string;
  prompt: string;
  referenceImages: string[];
  resolution: AlibabaVideoResolution;
  ratio?: AlibabaVideoRatio;
  duration: number;
  watermark: boolean;
} {
  const prompt = request.prompt.trim();
  if (!prompt) throw new AlibabaVideoError("Video prompt is empty", "動画の内容を指定してください。");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new AlibabaVideoError("Video prompt is too long", "動画生成の指示が長すぎます。");
  }

  const referenceImages = request.referenceImages ?? [];
  if (request.mode === "t2v" && referenceImages.length !== 0) {
    throw new AlibabaVideoError("T2V does not accept reference images");
  }
  if (request.mode === "i2v" && referenceImages.length !== 1) {
    throw new AlibabaVideoError("I2V requires exactly one first-frame image", "先頭フレーム画像を1枚指定してください。");
  }
  if (request.mode === "r2v" && (referenceImages.length < 1 || referenceImages.length > 9)) {
    throw new AlibabaVideoError("R2V requires 1 to 9 reference images", "参照画像は1〜9枚で指定してください。");
  }
  referenceImages.forEach(validateReferenceImage);

  if (request.mode === "i2v" && request.ratio !== undefined) {
    throw new AlibabaVideoError(
      "I2V does not accept a ratio parameter",
      "画像から動画を生成する場合、比率は先頭画像から自動決定されます。",
    );
  }

  const duration = request.duration ?? 5;
  if (!Number.isSafeInteger(duration) || duration < 3 || duration > 15) {
    throw new AlibabaVideoError("Invalid video duration", "動画の長さは3〜15秒で指定してください。");
  }
  if (
    request.seed !== undefined &&
    (!Number.isSafeInteger(request.seed) || request.seed < 0 || request.seed > 2_147_483_647)
  ) {
    throw new AlibabaVideoError("Invalid video seed", "seed の指定が不正です。");
  }

  return {
    modelId: normalizeVideoModel(request.mode, request.modelId),
    prompt,
    referenceImages,
    resolution: request.resolution ?? "720P",
    ...(request.mode !== "i2v" ? { ratio: request.ratio ?? "16:9" } : {}),
    duration,
    watermark: request.watermark ?? false,
  };
}

function assertValidTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new AlibabaVideoError("Invalid Alibaba video task ID", "動画タスクIDが不正です。");
  }
}

function specialistHeaders(
  apiKey: string,
  workspaceId: string | undefined,
  async = false,
): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    ...(workspaceId ? { "X-DashScope-WorkSpace": workspaceId } : {}),
    ...(async ? { "X-DashScope-Async": "enable" } : {}),
  };
}

function normalizeTaskPayload(payload: AlibabaVideoApiResponse): AlibabaVideoTask {
  const taskId = payload.output?.task_id;
  const status = payload.output?.task_status;
  if (!taskId || !TASK_ID_PATTERN.test(taskId)) {
    throw new AlibabaVideoError("Alibaba video API returned no valid task ID");
  }
  if (!status || !["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "UNKNOWN"].includes(status)) {
    throw new AlibabaVideoError("Alibaba video API returned an invalid task status");
  }
  return {
    taskId,
    status: status as AlibabaVideoTaskStatus,
    requestId: payload.request_id,
    videoUrl: payload.output?.video_url,
    code: payload.output?.code ?? payload.code,
    message: payload.output?.message ?? payload.message,
  };
}

async function parseApiResponse(response: Response, operation: string): Promise<AlibabaVideoApiResponse> {
  let payload: AlibabaVideoApiResponse;
  try {
    payload = (await response.json()) as AlibabaVideoApiResponse;
  } catch (error) {
    throw new AlibabaVideoError(`Alibaba video ${operation} returned invalid JSON: ${String(error)}`);
  }
  if (!response.ok || payload.code) {
    const providerMessage = payload.message || `HTTP ${response.status}`;
    logger.warn(
      { operation, status: response.status, code: payload.code, providerMessage },
      "Alibaba video API request failed",
    );
    throw new AlibabaVideoError(`Alibaba video ${operation} failed: ${providerMessage}`);
  }
  return payload;
}

function requireSpecialistConfig(env: NodeJS.ProcessEnv) {
  const specialist = getAlibabaSpecialistConfig(env);
  if (!specialist) {
    throw new AlibabaVideoError(
      "Regular Model Studio specialist credentials are not configured",
      "サーバー用の通常の Alibaba Model Studio API 資格情報が設定されていないため動画を生成できません。",
    );
  }
  return specialist;
}

export async function submitAlibabaVideoTask(
  request: AlibabaVideoRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AlibabaVideoTask & { modelId: string }> {
  const specialist = requireSpecialistConfig(env);
  const validated = validateRequest(request);
  const mediaType = request.mode === "i2v" ? "first_frame" : "reference_image";
  const input: Record<string, unknown> = { prompt: validated.prompt };
  if (validated.referenceImages.length > 0) {
    input.media = validated.referenceImages.map((url) => ({ type: mediaType, url }));
  }
  const parameters: Record<string, unknown> = {
    resolution: validated.resolution,
    duration: validated.duration,
    watermark: validated.watermark,
    ...(validated.ratio ? { ratio: validated.ratio } : {}),
    ...(request.seed !== undefined ? { seed: request.seed } : {}),
  };

  const endpoint = resolveAlibabaSpecialistHttpUrl(
    "services/aigc/video-generation/video-synthesis",
    env,
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: specialistHeaders(specialist.apiKey, specialist.workspaceId, true),
    body: JSON.stringify({ model: validated.modelId, input, parameters }),
    signal: request.signal,
  });
  const task = normalizeTaskPayload(await parseApiResponse(response, "submission"));
  logger.info(
    { modelId: validated.modelId, mode: request.mode, taskId: task.taskId, requestId: task.requestId },
    "Alibaba video task submitted",
  );
  return { ...task, modelId: validated.modelId };
}

export async function getAlibabaVideoTask(
  taskId: string,
  options: { signal?: AbortSignal } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AlibabaVideoTask> {
  assertValidTaskId(taskId);
  const specialist = requireSpecialistConfig(env);
  const endpoint = resolveAlibabaSpecialistHttpUrl(`tasks/${taskId}`, env);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: specialistHeaders(specialist.apiKey, specialist.workspaceId),
    signal: options.signal,
  });
  return normalizeTaskPayload(await parseApiResponse(response, "status query"));
}

export async function cancelAlibabaVideoTask(
  taskId: string,
  options: { signal?: AbortSignal } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<AlibabaVideoTask> {
  assertValidTaskId(taskId);
  const specialist = requireSpecialistConfig(env);
  const endpoint = resolveAlibabaSpecialistHttpUrl(`tasks/${taskId}/cancel`, env);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: specialistHeaders(specialist.apiKey, specialist.workspaceId),
    signal: options.signal,
  });
  return normalizeTaskPayload(await parseApiResponse(response, "cancellation"));
}

function trustedGeneratedVideoUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AlibabaVideoError("Provider returned an invalid video URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(hostname === "aliyuncs.com" || hostname.endsWith(".aliyuncs.com"))
  ) {
    throw new AlibabaVideoError("Provider returned an untrusted video URL");
  }
  return url;
}

async function readBoundedVideo(response: Response): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_GENERATED_VIDEO_BYTES) {
    throw new AlibabaVideoError("Generated video exceeds size limit");
  }
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > MAX_GENERATED_VIDEO_BYTES) {
      throw new AlibabaVideoError("Generated video exceeds size limit");
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
      if (total > MAX_GENERATED_VIDEO_BYTES) {
        await reader.cancel();
        throw new AlibabaVideoError("Generated video exceeds size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function looksLikeMp4(buffer: Buffer): boolean {
  return buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp";
}

export async function downloadAlibabaVideoResult(
  task: AlibabaVideoTask,
  modelId: string,
  options: { signal?: AbortSignal } = {},
): Promise<AlibabaGeneratedVideo> {
  if (task.status !== "SUCCEEDED" || !task.videoUrl) {
    throw new AlibabaVideoError("Alibaba video task has no completed result");
  }
  const url = trustedGeneratedVideoUrl(task.videoUrl);
  const response = await fetch(url, { signal: options.signal, redirect: "error" });
  if (!response.ok) {
    throw new AlibabaVideoError(`Failed to download generated video: HTTP ${response.status}`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
    throw new AlibabaVideoError(`Unexpected generated video content-type: ${contentType}`);
  }
  const buffer = await readBoundedVideo(response);
  if (!looksLikeMp4(buffer)) {
    throw new AlibabaVideoError("Generated video is not a valid MP4 payload");
  }
  return {
    buffer,
    filename: `alibaba-${modelId}-${task.taskId}.mp4`,
    mimeType: "video/mp4",
    size: buffer.length,
    taskId: task.taskId,
    modelId,
    requestId: task.requestId,
  };
}