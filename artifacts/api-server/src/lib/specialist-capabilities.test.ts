import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeSpecialistTool,
  getCapabilityRegistry,
  getSpecialistTools,
} from "./specialist-capabilities";

describe("specialist capability registry", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
  });

  it("only exposes image editing and speech tools when matching attachments exist", () => {
    const tools = getSpecialistTools({
      imageAttachments: [{ name: "reference.png", content: "data:image/png;base64,AA==" }],
      audioAttachments: [{ name: "memo.mp3", buffer: Buffer.from("audio"), mime: "audio/mpeg" }],
    });
    const names = tools.map((tool) => tool.function.name);
    expect(names).toContain("generate_image");
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
  });

  it("uses the dedicated Token Plan image endpoint and downloads the expiring result", async () => {
    if (getSpecialistTools({}).length === 0) return;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          output: {
            results: [{ url: "https://dashscope.oss-cn-beijing.aliyuncs.com/result.png" }],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => Buffer.from("png"),
      });
    vi.stubGlobal("fetch", fetchMock);

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
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      "/api/v1/services/aigc/image-generation/generation",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: "qwen-image-plus",
      input: { prompt: "a small blue bird" },
    });
  });
});