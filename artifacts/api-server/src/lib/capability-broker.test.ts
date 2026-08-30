import { describe, expect, it, vi } from "vitest";
import { couldNeedCapabilityTool, planCapabilityTool } from "./capability-broker";

function fakeClient(content: string) {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { client: { chat: { completions: { create } } } as never, create };
}

describe("capability broker", () => {
  it("does not spend a router call on ordinary chat", async () => {
    const { client, create } = fakeClient('{"tool":"image.generate","prompt":"wrong"}');
    const result = await planCapabilityTool({
      client, provider: "dashscope", modelId: "qwen3.8-max",
      userText: "量子コンピュータの仕組みを説明して", hasReferenceImages: false,
    });
    expect(result).toEqual({ tool: "none" });
    expect(create).not.toHaveBeenCalled();
  });

  it("lets the selected chat model plan an explicit image generation call", async () => {
    const { client, create } = fakeClient(
      '{"tool":"image.generate","prompt":"夜の東京駅を水彩画で描く","modelId":"wan2.7-image-pro","size":"1024*1024","n":2}',
    );
    const result = await planCapabilityTool({
      client, provider: "dashscope", modelId: "deepseek-v4-pro",
      userText: "夜の東京駅を水彩画の画像として2枚生成して", hasReferenceImages: false,
    });
    expect(result).toEqual({
      tool: "image.generate", prompt: "夜の東京駅を水彩画で描く",
      modelId: "wan2.7-image-pro", size: "1024*1024", n: 2,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects edit plans without a current-turn reference image", async () => {
    const { client } = fakeClient('{"tool":"image.edit","prompt":"空を青くする"}');
    const result = await planCapabilityTool({
      client, provider: "openai", modelId: "gpt-5.6-terra",
      userText: "この画像を編集して空を青くして", hasReferenceImages: false,
    });
    expect(result).toEqual({ tool: "none" });
  });

  it("accepts edit plans with current-turn image attachments", async () => {
    const { client } = fakeClient('{"tool":"image.edit","prompt":"空を青くする","modelId":"qwen-image-3.0-pro","imageName":"sky.png"}');
    const result = await planCapabilityTool({
      client, provider: "openai", modelId: "gpt-5.6-terra",
      userText: "添付画像を編集して空を青くして", hasReferenceImages: true,
      referenceImageNames: ["sky.png"],
    });
    expect(result).toEqual({
      tool: "image.edit", prompt: "空を青くする",
      modelId: "qwen-image-3.0-pro", imageName: "sky.png",
    });
  });

  it("plans audio transcription only for attached audio", async () => {
    const { client } = fakeClient('{"tool":"audio.transcribe","attachmentName":"meeting.m4a","modelId":"qwen-audio-3.0-asr-flash","languageHints":["en","ja"]}');
    const result = await planCapabilityTool({
      client, provider: "dashscope", modelId: "qwen3.8-flash",
      userText: "この録音を文字起こしして", hasReferenceImages: false,
      audioAttachmentNames: ["meeting.m4a"],
    });
    expect(result).toEqual({
      tool: "audio.transcribe", attachmentName: "meeting.m4a", modelId: "qwen-audio-3.0-asr-flash",
      languageHints: ["en", "ja"],
    });
  });

  it("plans bounded English speech synthesis for an explicit request", async () => {
    const { client, create } = fakeClient(
      '{"tool":"audio.synthesize","text":"Welcome to Chat Space.","modelId":"qwen-audio-3.0-tts-plus","voice":"longanlufeng","languageHint":"en","rate":1.1,"pitch":0.95,"volume":60}',
    );
    const result = await planCapabilityTool({
      client, provider: "openai", modelId: "gpt-5.6-terra",
      userText: "Read this aloud as an English voice: Welcome to Chat Space.",
      hasReferenceImages: false,
    });
    expect(result).toEqual({
      tool: "audio.synthesize",
      text: "Welcome to Chat Space.",
      modelId: "qwen-audio-3.0-tts-plus",
      voice: "longanlufeng",
      languageHint: "en",
      rate: 1.1,
      pitch: 0.95,
      volume: 60,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported language hints for the built-in English/Chinese voices", async () => {
    const { client, create } = fakeClient(
      '{"tool":"audio.synthesize","text":"こんにちは、Chat Spaceです。","languageHint":"ja"}',
    );
    const result = await planCapabilityTool({
      client, provider: "openai", modelId: "gpt-5.6-terra",
      userText: "この文章を日本語で読み上げて", hasReferenceImages: false,
    });
    expect(result).toEqual({ tool: "none" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("detects Japanese and English image/audio intent", () => {
    expect(couldNeedCapabilityTool("画像を生成して")).toBe(true);
    expect(couldNeedCapabilityTool("Please create an illustration of a fox")).toBe(true);
    expect(couldNeedCapabilityTool("この画像の内容を説明して")).toBe(false);
    expect(couldNeedCapabilityTool("transcribe this audio")).toBe(true);
    expect(couldNeedCapabilityTool("Please synthesize this text to speech")).toBe(true);
    expect(couldNeedCapabilityTool("動画の作り方を教えて")).toBe(false);
    expect(couldNeedCapabilityTool("この街の夜景を動画として生成して")).toBe(true);
  });

  it("plans explicit HappyHorse video generation without treating it as image generation", async () => {
    const { client, create } = fakeClient(
      '{"tool":"video.generate","mode":"r2v","prompt":"参照画像の街を夜の雨にする","modelId":"happyhorse-1.1-r2v","referenceImageNames":["city.png","street.png"],"resolution":"1080P","ratio":"9:16","duration":8}',
    );
    const result = await planCapabilityTool({
      client,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      userText: "この2枚の画像を参照して、街の動画を生成して",
      hasReferenceImages: true,
      referenceImageNames: ["city.png", "street.png"],
    });
    expect(result).toEqual({
      tool: "video.generate",
      mode: "r2v",
      prompt: "参照画像の街を夜の雨にする",
      modelId: "happyhorse-1.1-r2v",
      referenceImageNames: ["city.png", "street.png"],
      resolution: "1080P",
      ratio: "9:16",
      duration: 8,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("rejects video plans whose image cardinality does not match the selected mode", async () => {
    const { client } = fakeClient(
      '{"tool":"video.generate","mode":"i2v","prompt":"move","referenceImageNames":["one.png","two.png"]}',
    );
    const result = await planCapabilityTool({
      client,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      userText: "この画像から動画を生成して",
      hasReferenceImages: true,
      referenceImageNames: ["one.png", "two.png"],
    });
    expect(result).toEqual({ tool: "none" });
  });
});