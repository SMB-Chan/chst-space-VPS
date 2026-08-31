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

const MAX_PROMPT_CHARS = 16_000;
const MAX_REFERENCE_IMAGES = 3;
const MAX_REFERENCE_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_REFERENCE_DATA_URL_CHARS = Math.ceil(MAX_REFERENCE_IMAGE_BYTES * 4 / 3) + 128;
const MAX_GENERATED_IMAGE_BYTES = 32 * 1024 * 1024;

export interface AlibabaImageRequest {
  prompt: string;
  modelId?: string;
  referenceImages?: string[];
  size?: string;
  negativePrompt?: string;
  n?: number;
  seed?: number;
  promptExtend?: boolean;
  signal?: AbortSignal;
}

export interface AlibabaGeneratedImage {
  buffer: Buffer;
  filename: string;
  mimeType: "image/png";
  size: number;
  modelId: string;
  requestId?: string;
}

interface AlibabaImageApiResponse {
  output?: {
    choices?: Array<{
      message?: {
        content?: Array<{ image?: string }>;
      };
    }>;
    results?: Array<{ url?: string }>;
    result_url?: string;
  };
  data?: Array<{ url?: string; b64_json?: string }>;
  request_id?: string;
  code?: string;
  message?: string;
}

export class AlibabaImageError extends Error {
  readonly publicMessage: string;

  constructor(
    message: string,
    publicMessage = "画像生成に失敗しました。もう一度お試しください。",
  ) {
    super(message);
    this.name = "AlibabaImageError";
    this.publicMessage = publicMessage;
  }
}

function normalizeImageModel(modelId: string | undefined, editing: boolean): string {
  const capability = editing ? "image.edit" : "image.generate";
  const candidate = modelId?.trim() || ALIBABA_CAPABILITY_DEFAULTS[capability];
  if (!modelHasAlibabaCapability(candidate, capability)) {
    throw new AlibabaImageError(
      `Model ${candidate} does not support ${capability}`,
      "指定された画像モデルはこの処理に対応していません。",
    );
  }
  return candidate;
}

function validateReferenceImage(value: string): void {
  if (value.length > MAX_REFERENCE_DATA_URL_CHARS) {
    throw new AlibabaImageError("Reference image is too large", "参照画像が大きすぎます。");
  }

  const dataMatch = value.match(
    /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/i,
  );
  if (dataMatch) {
    const encoded = dataMatch[1];
    if (encoded.length % 4 !== 0) {
      throw new AlibabaImageError(
        "Reference image has invalid base64 padding",
        "参照画像の形式に対応していません。",
      );
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length === 0 || decoded.length > MAX_REFERENCE_IMAGE_BYTES) {
      throw new AlibabaImageError("Reference image is too large", "参照画像が大きすぎます。");
    }
    if (decoded.toString("base64") !== encoded) {
      throw new AlibabaImageError(
        "Reference image has invalid base64 encoding",
        "参照画像の形式に対応していません。",
      );
    }
    return;
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AlibabaImageError("Invalid reference image URL", "参照画像の形式に対応していません。");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const ipHostname =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    isIP(ipHostname) !== 0
  ) {
    throw new AlibabaImageError(
      "Reference image must use a public HTTPS hostname",
      "参照画像の形式に対応していません。",
    );
  }
}

function validateSize(value: string | undefined): void {
  if (!value) return;
  const match = /^(\d{3,4})\*(\d{3,4})$/.exec(value);
  if (!match) throw new AlibabaImageError("Invalid image size", "画像サイズの指定が不正です。");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 512 || height < 512 || width > 4096 || height > 4096) {
    throw new AlibabaImageError(
      "Image size outside supported safety bounds",
      "画像サイズは 512〜4096px の範囲で指定してください。",
    );
  }
}

function dataUrlToBuffer(value: string): Buffer | null {
  const match = value.match(
    /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/]*={0,2})$/i,
  );
  return match ? Buffer.from(match[1], "base64") : null;
}

function trustedGeneratedImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AlibabaImageError("Provider returned an invalid image URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    !(hostname === "aliyuncs.com" || hostname.endsWith(".aliyuncs.com"))
  ) {
    throw new AlibabaImageError("Provider returned an untrusted image URL");
  }
  return url;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers?.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AlibabaImageError("Generated image exceeds size limit");
  }
  if (!response.body) {
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length > maxBytes) throw new AlibabaImageError("Generated image exceeds size limit");
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
      if (total > maxBytes) {
        await reader.cancel();
        throw new AlibabaImageError("Generated image exceeds size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function downloadGeneratedImage(urlString: string, signal?: AbortSignal): Promise<Buffer> {
  const url = trustedGeneratedImageUrl(urlString);
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) {
    throw new AlibabaImageError(`Failed to download generated image: HTTP ${response.status}`);
  }
  const contentType = response.headers?.get("content-type")?.toLowerCase() ?? "";
  if (contentType && !contentType.startsWith("image/")) {
    throw new AlibabaImageError(`Unexpected generated image content-type: ${contentType}`);
  }
  return readBoundedResponse(response, MAX_GENERATED_IMAGE_BYTES);
}

function extractImageUrls(payload: AlibabaImageApiResponse): string[] {
  const multimodalUrls =
    payload.output?.choices
      ?.flatMap((choice) => choice.message?.content ?? [])
      .map((item) => item.image)
      .filter((value): value is string => typeof value === "string" && value.length > 0) ?? [];
  if (multimodalUrls.length > 0) return multimodalUrls;

  const compatibleUrls = [
    ...(payload.output?.results ?? []).map((item) => item.url),
    payload.output?.result_url,
    ...(payload.data ?? []).map((item) => item.url),
  ];
  return compatibleUrls.filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function extractInlineImage(payload: AlibabaImageApiResponse): Buffer | null {
  for (const item of payload.data ?? []) {
    if (typeof item.b64_json === "string") return Buffer.from(item.b64_json, "base64");
    if (typeof item.url === "string") {
      const buffer = dataUrlToBuffer(item.url);
      if (buffer) return buffer;
    }
  }
  return null;
}

export async function generateAlibabaImage(
  request: AlibabaImageRequest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AlibabaGeneratedImage[]> {
  const specialist = getAlibabaSpecialistConfig(env);
  if (!specialist) {
    throw new AlibabaImageError(
      "Regular Model Studio specialist credentials are not configured",
      "サーバー用の通常の Alibaba Model Studio API 資格情報が設定されていないため画像を生成できません。",
    );
  }

  const prompt = request.prompt.trim();
  if (!prompt) throw new AlibabaImageError("Image prompt is empty", "画像の内容を指定してください。");
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new AlibabaImageError("Image prompt is too long", "画像生成の指示が長すぎます。");
  }

  const referenceImages = request.referenceImages ?? [];
  if (referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw new AlibabaImageError("Too many reference images", "参照画像は3枚までです。");
  }
  referenceImages.forEach(validateReferenceImage);
  validateSize(request.size);

  const n = request.n ?? 1;
  if (!Number.isSafeInteger(n) || n < 1 || n > 6) {
    throw new AlibabaImageError("Invalid output image count", "生成枚数は1〜6枚で指定してください。");
  }
  if (
    request.seed !== undefined &&
    (!Number.isSafeInteger(request.seed) || request.seed < 0 || request.seed > 2_147_483_647)
  ) {
    throw new AlibabaImageError("Invalid image seed", "seed の指定が不正です。");
  }

  const editing = referenceImages.length > 0;
  const modelId = normalizeImageModel(request.modelId, editing);
  const content = [
    ...referenceImages.map((image) => ({ image })),
    { text: prompt },
  ];
  const parameters: Record<string, unknown> = {
    prompt_extend: request.promptExtend ?? true,
    watermark: false,
    n,
  };
  if (request.size) parameters.size = request.size;
  if (request.negativePrompt?.trim()) {
    parameters.negative_prompt = request.negativePrompt.trim().slice(0, MAX_PROMPT_CHARS);
  }
  if (request.seed !== undefined) parameters.seed = request.seed;

  const endpoint = resolveAlibabaSpecialistHttpUrl(
    editing
      ? "services/aigc/multimodal-generation/generation"
      : "services/aigc/image-generation/generation",
    env,
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${specialist.apiKey}`,
      "Content-Type": "application/json",
      ...(specialist.workspaceId ? { "X-DashScope-WorkSpace": specialist.workspaceId } : {}),
    },
    body: JSON.stringify({
      model: modelId,
      input: { messages: [{ role: "user", content }] },
      parameters,
    }),
    signal: request.signal,
  });

  let payload: AlibabaImageApiResponse;
  try {
    payload = (await response.json()) as AlibabaImageApiResponse;
  } catch (error) {
    throw new AlibabaImageError(`Alibaba image API returned invalid JSON: ${String(error)}`);
  }
  if (!response.ok || payload.code) {
    const providerMessage = payload.message || `HTTP ${response.status}`;
    logger.warn(
      { modelId, status: response.status, code: payload.code, providerMessage },
      "Alibaba image generation failed",
    );
    throw new AlibabaImageError(`Alibaba image generation failed: ${providerMessage}`);
  }

  const inline = extractInlineImage(payload);
  const urls = extractImageUrls(payload);
  if (!inline && urls.length === 0) {
    throw new AlibabaImageError("Alibaba image API returned no image URL");
  }

  const generated: AlibabaGeneratedImage[] = [];
  if (inline) {
    if (inline.length === 0 || inline.length > MAX_GENERATED_IMAGE_BYTES) {
      throw new AlibabaImageError("Generated image exceeds size limit");
    }
    generated.push({
      buffer: inline,
      filename: `alibaba-${modelId}-${Date.now()}-1.png`,
      mimeType: "image/png",
      size: inline.length,
      modelId,
      requestId: payload.request_id,
    });
  }
  const remainingUrlCount = Math.max(0, n - generated.length);
  for (const [index, url] of urls.slice(0, remainingUrlCount).entries()) {
    const buffer = await downloadGeneratedImage(url, request.signal);
    generated.push({
      buffer,
      filename: `alibaba-${modelId}-${Date.now()}-${generated.length + index + 1}.png`,
      mimeType: "image/png",
      size: buffer.length,
      modelId,
      requestId: payload.request_id,
    });
  }

  logger.info(
    { modelId, requestId: payload.request_id, imageCount: generated.length, editing },
    "Alibaba image generation completed",
  );
  return generated.slice(0, n);
}
