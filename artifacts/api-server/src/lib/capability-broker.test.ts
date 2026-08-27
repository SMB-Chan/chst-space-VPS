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
    const { client } = fakeClient('{"tool":"audio.transcribe","attachmentName":"meeting.m4a","modelId":"paraformer-v2"}');
    const result = await planCapabilityTool({
      client, provider: "dashscope", modelId: "qwen3.8-flash",
      userText: "この録音を文字起こしして", hasReferenceImages: false,
      audioAttachmentNames: ["meeting.m4a"],
    });
    expect(result).toEqual({
      tool: "audio.transcribe", attachmentName: "meeting.m4a", modelId: "paraformer-v2",
    });
  });

  it("detects Japanese and English image/audio intent", () => {
    expect(couldNeedCapabilityTool("画像を生成して")).toBe(true);
    expect(couldNeedCapabilityTool("Please create an illustration of a fox")).toBe(true);
    expect(couldNeedCapabilityTool("この画像の内容を説明して")).toBe(false);
    expect(couldNeedCapabilityTool("transcribe this audio")).toBe(true);
  });
});