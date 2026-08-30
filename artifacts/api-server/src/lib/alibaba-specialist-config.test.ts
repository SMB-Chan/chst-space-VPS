import { describe, expect, it } from "vitest";
import {
  getAlibabaSpecialistConfig,
  isAlibabaSpecialistConfigured,
  isAlibabaTokenPlanKey,
  resolveAlibabaRealtimeWebSocketUrl,
  resolveAlibabaSpecialistHttpUrl,
  resolveAlibabaTtsWebSocketUrl,
} from "./alibaba-specialist-config";

describe("Alibaba specialist backend configuration", () => {
  it("rejects Token Plan keys for custom backend specialist traffic", () => {
    expect(isAlibabaTokenPlanKey("sk-sp-example")).toBe(true);
    expect(getAlibabaSpecialistConfig({ DASHSCOPE_API_KEY: "sk-sp-example" } as NodeJS.ProcessEnv)).toBeNull();
    expect(isAlibabaSpecialistConfigured({ ALIBABA_SPECIALIST_API_KEY: "sk-sp-example" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("accepts an explicit regular Model Studio credential", () => {
    expect(getAlibabaSpecialistConfig({
      ALIBABA_SPECIALIST_API_KEY: "sk-regular",
      ALIBABA_SPECIALIST_WORKSPACE_ID: "ws-123",
    } as NodeJS.ProcessEnv)).toEqual({ apiKey: "sk-regular", workspaceId: "ws-123" });
  });

  it("prefers workspace-specific Singapore specialist endpoints", () => {
    const env = {
      ALIBABA_SPECIALIST_API_KEY: "sk-regular",
      ALIBABA_SPECIALIST_WORKSPACE_ID: "ws-123",
    } as NodeJS.ProcessEnv;
    expect(resolveAlibabaTtsWebSocketUrl(env).toString()).toBe(
      "wss://ws-123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference",
    );
    expect(resolveAlibabaSpecialistHttpUrl(
      "services/aigc/multimodal-generation/generation",
      env,
    ).toString()).toBe(
      "https://ws-123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    );
    expect(resolveAlibabaRealtimeWebSocketUrl(env).toString()).toBe(
      "wss://ws-123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus",
    );
  });

  it("keeps the trusted legacy Singapore HTTP endpoint as a fallback", () => {
    expect(resolveAlibabaSpecialistHttpUrl(
      "services/aigc/image-generation/generation",
      { ALIBABA_SPECIALIST_API_KEY: "sk-regular" } as NodeJS.ProcessEnv,
    ).toString()).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/image-generation/generation",
    );
  });

  it("rejects untrusted specialist endpoint hosts", () => {
    expect(() => resolveAlibabaTtsWebSocketUrl({
      ALIBABA_SPECIALIST_TTS_WS_URL: "wss://example.com/api-ws/v1/inference",
    } as NodeJS.ProcessEnv)).toThrow(/not trusted/);
    expect(() => resolveAlibabaRealtimeWebSocketUrl({
      ALIBABA_SPECIALIST_REALTIME_WS_URL:
        "wss://example.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus",
    } as NodeJS.ProcessEnv)).toThrow(/not trusted/);
    expect(() => resolveAlibabaSpecialistHttpUrl(
      "services/aigc/image-generation/generation",
      { ALIBABA_SPECIALIST_HTTP_BASE_URL: "https://example.com/api/v1/" } as NodeJS.ProcessEnv,
    )).toThrow(/not trusted/);
  });

  it("rejects realtime endpoint overrides with another model or query", () => {
    expect(() => resolveAlibabaRealtimeWebSocketUrl({
      ALIBABA_SPECIALIST_REALTIME_WS_URL:
        "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=other",
    } as NodeJS.ProcessEnv)).toThrow(/supported realtime model/);
    expect(() => resolveAlibabaRealtimeWebSocketUrl({
      ALIBABA_SPECIALIST_REALTIME_WS_URL:
        "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus&x=1",
    } as NodeJS.ProcessEnv)).toThrow(/supported realtime model/);
  });
});