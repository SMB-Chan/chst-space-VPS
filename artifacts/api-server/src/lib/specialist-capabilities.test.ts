import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  generateAlibabaImageMock,
  transcribeDashScopeAudioMock,
  dashscopeClientMock,
  openaiClientMock,
} = vi.hoisted(() => {
  const dashscopeClientMock = {
    models: { list: vi.fn().mockResolvedValue({ data: [] }) },
  };
  const openaiClientMock = {
    models: { list: vi.fn().mockResolvedValue({ data: [] }) },
  };
  return {
    generateAlibabaImageMock: vi.fn(),
    transcribeDashScopeAudioMock: vi.fn(),
    dashscopeClientMock,
    openaiClientMock,
  };
});

vi.mock("./ai-clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-clients")>();
  return {
    ...actual,
    dashscopeClient: dashscopeClientMock as never,
    openaiClient: openaiClientMock as never,
  };
});

vi.mock("./alibaba-image", () => ({
  generateAlibabaImage: generateAlibabaImageMock,
}));

vi.mock("./audio-transcription", () => ({
  transcribeDashScopeAudio: transcribeDashScopeAudioMock,
}));

import {
  executeSpecialistTool,
  getAvailableChatModels,
  getCapabilityRegistry,
  getSpecialistTools,
  resetModelDiscoveryCache,
} from "./specialist-capabilities";

describe("specialist capability registry", () => {
  beforeEach(() => {
    vi.stubEnv("ALIBABA_SPECIALIST_API_KEY", "test-credential");
    vi.stubEnv("DASHSCOPE_API_KEY", "test-regular-chat-credential");
    generateAlibabaImageMock.mockReset();
    transcribeDashScopeAudioMock.mockReset();
    generateAlibabaImageMock.mockResolvedValue([
      {
        buffer: Buffer.from("png"),
        filename: "generated.png",
        mimeType: "image/png",
        size: 3,
        modelId: "qwen-image-3.0-pro",
      },
    ]);
    transcribeDashScopeAudioMock.mockResolvedValue("hello from audio");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps chat and multimodal capabilities in one discoverable registry", () => {
    const registry = getCapabilityRegistry();
    expect(registry.capabilities.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "chat",
        "reasoning",
        "vision",
        "image-generate",
        "image-edit",
        "speech-to-text",
        "audio-synthesis",
        "realtime",
        "video",
      ]),
    );
    expect(
      registry.models.some((model) => model.capabilities.includes("chat")),
    ).toBe(true);
    expect(
      registry.models.some((model) =>
        model.capabilities.includes("image-generate"),
      ),
    ).toBe(true);
    expect(
      registry.capabilities.find((item) => item.id === "audio-synthesis")
        ?.status,
    ).toBe("available");
    expect(
      registry.capabilities.find((item) => item.id === "video")?.status,
    ).toBe("catalog-only");
  });

  it("only exposes attachment-dependent tools when matching attachments exist", () => {
    const withoutAttachments = getSpecialistTools({});
    const baseNames = withoutAttachments.map((tool) => tool.function.name);
    expect(baseNames).toContain("generate_image");
    expect(baseNames).toContain("synthesize_speech");
    expect(baseNames).not.toContain("edit_image");
    expect(baseNames).not.toContain("transcribe_audio");

    const tools = getSpecialistTools({
      imageAttachments: [
        { name: "reference.png", content: "data:image/png;base64,AA==" },
      ],
      audioAttachments: [
        { name: "memo.mp3", buffer: Buffer.from("audio"), mime: "audio/mpeg" },
      ],
    });
    const names = tools.map((tool) => tool.function.name);
    expect(names).toContain("generate_image");
    expect(names).toContain("synthesize_speech");
    expect(names).toContain("edit_image");
    expect(names).toContain("transcribe_audio");
  });

  it("rejects malformed and unauthorized tool arguments without network access", async () => {
    const malformed = await executeSpecialistTool(
      { id: "call-1", name: "generate_image", arguments: "not-json" },
      {},
    );
    expect(malformed.ok).toBe(false);
    expect(malformed.summary).toContain("引数JSON");

    const unauthorized = await executeSpecialistTool(
      { id: "call-2", name: "run_shell", arguments: "{}" },
      {},
    );
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.summary).toContain("許可されていない");
    expect(generateAlibabaImageMock).not.toHaveBeenCalled();
  });

  it("returns a bounded generated image as a specialist asset", async () => {
    const result = await executeSpecialistTool(
      {
        id: "call-image",
        name: "generate_image",
        arguments: JSON.stringify({
          prompt: "a small blue bird",
          size: "1024x1024",
        }),
      },
      {},
    );

    expect(result.ok).toBe(true);
    expect(result.asset?.mimeType).toBe("image/png");
    expect(generateAlibabaImageMock).toHaveBeenCalledTimes(1);
    expect(generateAlibabaImageMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "a small blue bird",
      size: "1024*1024",
    });
  });

  it("transcribes only an attached audio file selected by name", async () => {
    const context = {
      audioAttachments: [
        { name: "memo.mp3", buffer: Buffer.from("audio"), mime: "audio/mpeg" },
      ],
    };
    const result = await executeSpecialistTool(
      {
        id: "call-audio",
        name: "transcribe_audio",
        arguments: JSON.stringify({ attachmentName: "memo.mp3" }),
      },
      context,
    );
    expect(result.ok).toBe(true);
    expect(result.text).toBe("hello from audio");
    expect(transcribeDashScopeAudioMock).toHaveBeenCalledTimes(1);
  });
});

describe("dynamic model discovery", () => {
  beforeEach(() => {
    vi.stubEnv("DASHSCOPE_API_KEY", "sk-test-dashscope");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "sk-test-openai");
    dashscopeClientMock.models.list.mockReset().mockResolvedValue({ data: [] });
    openaiClientMock.models.list.mockReset().mockResolvedValue({ data: [] });
    resetModelDiscoveryCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("preserves provider attribution from API source — DashScope models stay dashscope", async () => {
    dashscopeClientMock.models.list.mockResolvedValue({
      data: [{ id: "deepseek-v4-pro-0813" }, { id: "qwen3.8-max" }],
    });

    const models = await getAvailableChatModels();
    const discovered = models.filter((m) => m.id === "deepseek-v4-pro-0813");
    expect(discovered).toHaveLength(1);
    expect(discovered[0].provider).toBe("dashscope");
  });

  it("preserves provider attribution from API source — OpenAI models stay openai", async () => {
    openaiClientMock.models.list.mockResolvedValue({
      data: [{ id: "gpt-5.6-terra" }, { id: "gpt-new-model" }],
    });

    const models = await getAvailableChatModels();
    const discovered = models.filter((m) => m.id === "gpt-new-model");
    expect(discovered).toHaveLength(1);
    expect(discovered[0].provider).toBe("openai");
  });

  it("does not misclassify a DashScope model as OpenAI even if both APIs return it", async () => {
    dashscopeClientMock.models.list.mockResolvedValue({
      data: [{ id: "deepseek-v4-pro-0813" }],
    });
    openaiClientMock.models.list.mockResolvedValue({
      data: [{ id: "deepseek-v4-pro-0813" }],
    });

    const models = await getAvailableChatModels();
    const matching = models.filter((m) => m.id === "deepseek-v4-pro-0813");
    expect(matching.length).toBeGreaterThanOrEqual(1);
    for (const model of matching) {
      expect(model.provider).not.toBe("openai");
    }
  });

  it("filters out non-chat model IDs from dynamic discovery", async () => {
    dashscopeClientMock.models.list.mockResolvedValue({
      data: [
        { id: "qwen-image-3.0-pro" },
        { id: "qwen-audio-3.0-asr-flash" },
        { id: "happyhorse-1.1-t2v" },
        { id: "text-embedding-v3" },
      ],
    });
    openaiClientMock.models.list.mockResolvedValue({
      data: [
        { id: "dall-e-3" },
        { id: "whisper-1" },
        { id: "text-embedding-3-small" },
      ],
    });

    const models = await getAvailableChatModels();
    const discoveredIds = models
      .filter((m) => m.description === "動的に検出されたモデル")
      .map((m) => m.id);
    expect(discoveredIds).not.toContain("text-embedding-v3");
    expect(discoveredIds).not.toContain("text-embedding-3-small");
    expect(discoveredIds).not.toContain("dall-e-3");
    expect(discoveredIds).not.toContain("whisper-1");
    expect(discoveredIds).not.toContain("happyhorse-1.1-t2v");
  });

  it("falls back to full catalog when both provider APIs are unreachable", async () => {
    dashscopeClientMock.models.list.mockRejectedValue(
      new Error("network error"),
    );
    openaiClientMock.models.list.mockRejectedValue(new Error("network error"));

    const models = await getAvailableChatModels();
    expect(models.length).toBeGreaterThanOrEqual(12);
    const catalogIds = models.map((m) => m.id);
    expect(catalogIds).toContain("gpt-5.6-terra");
    expect(catalogIds).toContain("qwen3.8-max");
    expect(catalogIds).toContain("deepseek-v4-pro-0813");
  });
});
