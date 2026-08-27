import { afterEach, describe, expect, it, vi } from "vitest";
import { AlibabaImageError, generateAlibabaImage } from "./alibaba-image";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateAlibabaImage", () => {
  it("calls the Token Plan multimodal endpoint and downloads the expiring result", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/result.png" }] } }] },
        request_id: "req-1",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(png, {
        status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateAlibabaImage(
      { prompt: "a quiet station at night", size: "1024*1024" },
      { DASHSCOPE_API_KEY: "sk-sp-test" } as NodeJS.ProcessEnv,
    );

    expect(result).toHaveLength(1);
    expect(result[0].modelId).toBe("qwen-image-3.0-pro");
    expect(result[0].buffer.equals(png)).toBe(true);
    expect(result[0].requestId).toBe("req-1");
    const [endpoint, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toContain("token-plan.ap-southeast-1.maas.aliyuncs.com");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "qwen-image-3.0-pro",
      input: { messages: [{ content: [{ text: "a quiet station at night" }] }] },
      parameters: { watermark: false },
    });
  });

  it("uses edit capability when reference images are supplied", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { choices: [{ message: { content: [{ image: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/edited.png" }] } }] },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(Buffer.from("png"), {
        status: 200, headers: { "content-type": "image/png" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await generateAlibabaImage({
      prompt: "make the sky blue",
      modelId: "wan2.7-image-pro",
      referenceImages: ["data:image/png;base64,aGVsbG8="],
    }, { DASHSCOPE_API_KEY: "sk-sp-test" } as NodeJS.ProcessEnv);

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe("wan2.7-image-pro");
    expect(body.input.messages[0].content).toEqual([
      { image: "data:image/png;base64,aGVsbG8=" },
      { text: "make the sky blue" },
    ]);
  });

  it("rejects specialist model mismatches before making a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAlibabaImage(
      { prompt: "draw a cat", modelId: "happyhorse-1.1-t2v" },
      { DASHSCOPE_API_KEY: "sk-sp-test" } as NodeJS.ProcessEnv,
    )).rejects.toThrow(AlibabaImageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects untrusted provider download URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      output: { choices: [{ message: { content: [{ image: "https://example.com/not-alibaba.png" }] } }] },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAlibabaImage(
      { prompt: "draw a cat" },
      { DASHSCOPE_API_KEY: "sk-sp-test" } as NodeJS.ProcessEnv,
    )).rejects.toThrow(/untrusted image URL/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});