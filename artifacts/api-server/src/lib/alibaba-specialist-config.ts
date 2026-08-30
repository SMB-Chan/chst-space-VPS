const TOKEN_PLAN_KEY_PREFIX = /^sk-sp-/i;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9-]{3,128}$/;

export interface AlibabaSpecialistConfig {
  apiKey: string;
  workspaceId?: string;
}

export function isAlibabaTokenPlanKey(value: string | undefined): boolean {
  return TOKEN_PLAN_KEY_PREFIX.test(value?.trim() ?? "");
}

/**
 * Resolve credentials for server-side specialist media APIs.
 *
 * Token Plan Personal/Team keys (sk-sp-*) are intentionally rejected here:
 * Alibaba documents those plans for interactive coding/agent tools rather
 * than custom application backends. Chat model configuration remains separate
 * in ai-clients.ts so existing installations can migrate specialist traffic to
 * a regular Model Studio workspace credential without changing chat settings.
 */
export function getAlibabaSpecialistConfig(
  env: NodeJS.ProcessEnv = process.env,
): AlibabaSpecialistConfig | null {
  const explicit = env.ALIBABA_SPECIALIST_API_KEY?.trim();
  const fallback = env.DASHSCOPE_API_KEY?.trim();
  const apiKey = explicit || fallback;
  if (!apiKey || isAlibabaTokenPlanKey(apiKey)) return null;

  const workspaceId = env.ALIBABA_SPECIALIST_WORKSPACE_ID?.trim();
  if (workspaceId && !WORKSPACE_ID_PATTERN.test(workspaceId)) return null;
  return { apiKey, ...(workspaceId ? { workspaceId } : {}) };
}

export function isAlibabaSpecialistConfigured(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return getAlibabaSpecialistConfig(env) !== null;
}

function assertTrustedAlibabaHost(url: URL): void {
  const host = url.hostname.toLowerCase();
  const trusted =
    host === "dashscope-intl.aliyuncs.com" ||
    host === "dashscope.aliyuncs.com" ||
    host.endsWith(".ap-southeast-1.maas.aliyuncs.com") ||
    host.endsWith(".cn-beijing.maas.aliyuncs.com");
  if (!trusted) throw new Error("Alibaba specialist endpoint host is not trusted");
}

function defaultSpecialistHttpBase(env: NodeJS.ProcessEnv): string {
  const workspaceId = env.ALIBABA_SPECIALIST_WORKSPACE_ID?.trim();
  if (workspaceId && WORKSPACE_ID_PATTERN.test(workspaceId)) {
    return `https://${workspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/`;
  }
  // Alibaba keeps the legacy Singapore public domain functional, but recommends
  // workspace-specific domains for higher stability. It remains a safe fallback
  // for installations that have not yet configured their workspace ID.
  return "https://dashscope-intl.aliyuncs.com/api/v1/";
}

export function resolveAlibabaSpecialistHttpUrl(
  servicePath: string,
  env: NodeJS.ProcessEnv = process.env,
): URL {
  const configured = env.ALIBABA_SPECIALIST_HTTP_BASE_URL?.trim();
  const base = new URL(configured || defaultSpecialistHttpBase(env));
  if (base.protocol !== "https:") throw new Error("Alibaba specialist HTTP endpoint must use HTTPS");
  assertTrustedAlibabaHost(base);

  const normalizedBase = base.pathname.endsWith("/") ? base : new URL(`${base.toString().replace(/\/+$/, "")}/`);
  const normalizedPath = servicePath.replace(/^\/+/, "");
  const resolved = new URL(normalizedPath, normalizedBase);
  if (resolved.origin !== base.origin) throw new Error("Alibaba specialist endpoint escaped configured origin");
  assertTrustedAlibabaHost(resolved);
  return resolved;
}

export function resolveAlibabaTtsWebSocketUrl(
  env: NodeJS.ProcessEnv = process.env,
): URL {
  const explicit = env.ALIBABA_SPECIALIST_TTS_WS_URL?.trim();
  const workspaceId = env.ALIBABA_SPECIALIST_WORKSPACE_ID?.trim();
  const raw = explicit || (workspaceId && WORKSPACE_ID_PATTERN.test(workspaceId)
    ? `wss://${workspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference`
    : "wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference");
  const url = new URL(raw);
  if (url.protocol !== "wss:") throw new Error("Alibaba TTS endpoint must use WSS");
  assertTrustedAlibabaHost(url);
  if (url.pathname !== "/api-ws/v1/inference") {
    throw new Error("Alibaba TTS endpoint path is not allowed");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Alibaba TTS endpoint must not contain credentials, query, or fragment");
  }
  return url;
}

export const ALIBABA_REALTIME_MODEL_ID = "qwen-audio-3.0-realtime-plus";

export function resolveAlibabaRealtimeWebSocketUrl(
  env: NodeJS.ProcessEnv = process.env,
): URL {
  const explicit = env.ALIBABA_SPECIALIST_REALTIME_WS_URL?.trim();
  const workspaceId = env.ALIBABA_SPECIALIST_WORKSPACE_ID?.trim();
  const raw = explicit || (workspaceId && WORKSPACE_ID_PATTERN.test(workspaceId)
    ? `wss://${workspaceId}.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=${ALIBABA_REALTIME_MODEL_ID}`
    : `wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=${ALIBABA_REALTIME_MODEL_ID}`);
  const url = new URL(raw);
  if (url.protocol !== "wss:") throw new Error("Alibaba realtime endpoint must use WSS");
  assertTrustedAlibabaHost(url);
  if (url.pathname !== "/api-ws/v1/realtime") {
    throw new Error("Alibaba realtime endpoint path is not allowed");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("Alibaba realtime endpoint must not contain credentials or fragment");
  }
  if (url.searchParams.get("model") !== ALIBABA_REALTIME_MODEL_ID || [...url.searchParams.keys()].length !== 1) {
    throw new Error("Alibaba realtime endpoint must select the supported realtime model");
  }
  return url;
}
