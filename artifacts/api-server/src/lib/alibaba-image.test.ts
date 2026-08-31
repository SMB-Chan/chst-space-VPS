import { afterEach, describe, expect, it, vi } from "vitest";
import { AlibabaImageError, generateAlibabaImage } from "./alibaba-image";

afterEach(() => {
  vi.unstubAllGlobals();
});

const specialistEnv = { ALIBABA_SPECIALIST_API_KEY: "test-credential" } as NodeJS.ProcessEnv;

async function expectReferenceImageRejectedBeforeNetwork(referenceImage: string): Promise<void> {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(generateAlibabaImage({
    prompt: "make the sky blue",
    modelId: "wan2.7-image-pro",
    referenceImages: [referenceImage],
  }, specialistEnv)).rejects.toThrow(AlibabaImageError);
  expect(fetchMock).not.toHaveBeenCalled();
}

describe("generateAlibabaImage", () => {
  it("calls the regular Model Studio image endpoint and downloads the expiring result", async () => {
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
      specialistEnv,
    );

    expect(result).toHaveLength(1);
    expect(result[0].modelId).toBe("qwen-image-3.0-pro");
    expect(result[0].buffer.equals(png)).toBe(true);
    expect(result[0].requestId).toBe("req-1");
    const [endpoint, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(endpoint.toString()).toContain("dashscope-intl.aliyuncs.com/api/v1/services/aigc/image-generation/generation");
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
    }, specialistEnv);

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.model).toBe("wan2.7-image-pro");
    expect(body.input.messages[0].content).toEqual([
      { image: "data:image/png;base64,aGVsbG8=" },
      { text: "make the sky blue" },
    ]);
  });

  it("keeps accepting a public HTTPS reference image URL", async () => {
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
      referenceImages: ["https://assets.example.com/reference.png"],
    }, specialistEnv);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("downloads only one URL when n is one and the provider returns multiple URLs", async () => {
    const urls = [
      "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/one.png",
      "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/two.png",
      "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/three.png",
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        output: { results: urls.map((url) => ({ url })) },
      }), { status: 200 }))
      .mockResolvedValue(new Response(Buffer.from("png"), {
        status: 200, headers: { "content-type": "image/png" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateAlibabaImage({ prompt: "draw a cat", n: 1 }, specialistEnv);

    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not download URLs when n is one and an inline image is present", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("inline").toString("base64") }],
      output: {
        results: [
          { url: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/one.png" },
          { url: "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/two.png" },
        ],
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateAlibabaImage({ prompt: "draw a cat", n: 1 }, specialistEnv);

    expect(result).toHaveLength(1);
    expect(result[0].buffer.equals(Buffer.from("inline"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads only the remaining URLs when n is greater than one and an inline image is present", async () => {
    const urls = [
      "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/one.png",
      "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/two.png",
      "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/three.png",
      "https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/four.png",
    ];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from("inline").toString("base64") }],
        output: { results: urls.map((url) => ({ url })) },
      }), { status: 200 }))
      .mockResolvedValue(new Response(Buffer.from("png"), {
        status: 200, headers: { "content-type": "image/png" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateAlibabaImage({ prompt: "draw a cat", n: 3 }, specialistEnv);

    expect(result).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["a data URL prefix without payload", "data:image/"],
    ["an empty data URL", "data:image/png;base64,"],
    ["an unsupported image MIME type", "data:image/gif;base64,R0lGODlh"],
    ["malformed base64 characters", "data:image/png;base64,not-base64!"],
    ["incomplete base64 padding", "data:image/png;base64,AAA"],
    ["a credential-bearing HTTPS URL", "https://user:password@assets.example.com/image.png"],
    ["localhost", "https://localhost/image.png"],
    ["a .local hostname", "https://assets.local/image.png"],
    ["an IPv4 literal", "https://127.0.0.1/image.png"],
    ["an IPv6 literal", "https://[::1]/image.png"],
  ])("rejects %s before making a network call", async (_name, referenceImage) => {
    await expectReferenceImageRejectedBeforeNetwork(referenceImage);
  });

  it("rejects a reference image whose decoded data exceeds the limit before networking", async () => {
    const oversized = `data:image/png;base64,${Buffer.alloc(12 * 1024 * 1024 + 1).toString("base64")}`;
    await expectReferenceImageRejectedBeforeNetwork(oversized);
  });

  it("rejects specialist model mismatches before making a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAlibabaImage(
      { prompt: "draw a cat", modelId: "happyhorse-1.1-t2v" },
      specialistEnv,
    )).rejects.toThrow(AlibabaImageError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Token Plan credentials for application-backend specialist calls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAlibabaImage(
      { prompt: "draw a cat" },
      { DASHSCOPE_API_KEY: ["sk", "sp", "test"].join("-") } as NodeJS.ProcessEnv,
    )).rejects.toThrow(/Regular Model Studio specialist credentials/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects untrusted provider download URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      output: { choices: [{ message: { content: [{ image: "https://example.com/not-alibaba.png" }] } }] },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateAlibabaImage(
      { prompt: "draw a cat" },
      specialistEnv,
    )).rejects.toThrow(/untrusted image URL/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
