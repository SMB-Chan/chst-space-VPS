import { describe, expect, it } from "vitest";
import {
  prepareInitialChatMessages,
  specialistCallFromPlan,
} from "./chat-stream-policy";

describe("prepareInitialChatMessages", () => {
  it("clones history and adds file-generation policy for an explicit format", () => {
    const history = [{ role: "user" as const, content: "月次報告をまとめて" }];

    const result = prepareInitialChatMessages({
      chatMessages: history,
      userText: "月次報告をまとめて",
      requestedFileFormat: "pdf",
    });

    expect(result.messages).not.toBe(history);
    expect(history).toHaveLength(1);
    expect(result.messages).toHaveLength(2);
    expect(String(result.messages[1]?.content)).toContain(
      "システムが自動的にファイルを生成",
    );
  });

  it("keeps translation mode isolated from artifact and specialist policies", () => {
    const result = prepareInitialChatMessages({
      chatMessages: [{ role: "user", content: "PDFで保存して" }],
      userText: "PDFで保存して",
      translationMode: "ja-en",
      requestedFileFormat: "pdf",
    });

    expect(result.skills).toEqual([]);
    expect(result.messages).toHaveLength(2);
    expect(String(result.messages[1]?.content)).toContain("プロの翻訳者");
    expect(String(result.messages[1]?.content)).not.toContain("ファイルを生成");
  });
});

describe("specialistCallFromPlan", () => {
  it("maps image parameters to the execution contract", () => {
    const call = specialistCallFromPlan({
      tool: "image.edit",
      prompt: "背景を青にする",
      imageName: "source.png",
      size: "1024*768",
      n: 2,
    });

    expect(call?.name).toBe("edit_image");
    expect(JSON.parse(call?.arguments ?? "{}")).toEqual({
      prompt: "背景を青にする",
      imageName: "source.png",
      size: "1024x768",
      n: 2,
    });
  });

  it("does not execute an async video plan in the chat stream", () => {
    expect(
      specialistCallFromPlan({
        tool: "video.generate",
        mode: "t2v",
        prompt: "sunrise",
      }),
    ).toBeUndefined();
  });
});
