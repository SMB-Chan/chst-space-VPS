import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { generateAlibabaImageMock, transcribeDashScopeAudioMock } = vi.hoisted(() => ({
  generateAlibabaImageMock: vi.fn(),
  transcribeDashScopeAudioMock: vi.fn(),
}));

vi.mock("./ai-clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-clients")>();
  return {
    ...actual,
    // Tool-definition tests must not depend on whether CI happens to expose
    // real Alibaba credentials. Production still uses the real client value.
    dashscopeClient: {} as never,
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
  getCapabilityRegistry,
  getSpecialistTools,
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
    expect(registry.models.some((model) => model.capabilities.includes("chat"))).toBe(true);
    expect(registry.models.some((model) => model.capabilities.includes("image-generate"))).toBe(true);
    expect(registry.capabilities.find((item) => item.id === "audio-synthesis")?.status).toBe("available");
    expect(registry.capabilities.find((item) => item.id === "video")?.status).toBe("catalog-only");
  });

  it("only exposes attachment-dependent tools when matching attachments exist", () => {
    const withoutAttachments = getSpecialistTools({});
    const baseNames = withoutAttachments.map((tool) => tool.function.name);
    expect(baseNames).toContain("generate_image");
    expect(baseNames).toContain("synthesize_speech");
    expect(baseNames).not.toContain("edit_image");
    expect(baseNames).not.toContain("transcribe_audio");

    const tools = getSpecialistTools({
      imageAttachments: [{ name: "reference.png", content: "data:image/png;base64,AA==" }],
      audioAttachments: [{ name: "memo.mp3", buffer: Buffer.from("audio"), mime: "audio/mpeg" }],
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
        arguments: JSON.stringify({ prompt: "a small blue bird", size: "1024x1024" }),
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
      audioAttachments: [{ name: "memo.mp3", buffer: Buffer.from("audio"), mime: "audio/mpeg" }],
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
