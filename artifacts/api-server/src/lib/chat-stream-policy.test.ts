import { describe, expect, it } from "vitest";
import {
  isResearchAnnouncementOnly,
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
    expect(result.messages).toHaveLength(3);
    expect(String(result.messages[1]?.content)).toContain("日本語で回答");
    expect(String(result.messages[2]?.content)).toContain(
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

describe("research recovery detection", () => {
  it("recovers from a false Web capability denial for current news", () => {
    expect(
      isResearchAnnouncementOnly(
        "今日のニュースについては、リアルタイムの情報を取得するWeb検索機能がこの環境にはないため、具体的なニュースをお伝えできません。最新ニュースはニュースサイトや検索エンジンでご確認ください。",
      ),
    ).toBe(true);
  });

  it("keeps a normal answer out of the recovery path", () => {
    expect(
      isResearchAnnouncementOnly(
        "一般にニュース記事では、公開日時と一次情報を確認すると情報の鮮度を判断しやすくなります。",
      ),
    ).toBe(false);
  });

  it("does not reinterpret an already sourced answer as a capability denial", () => {
    expect(
      isResearchAnnouncementOnly(
        "検索結果の一部は取得できませんでしたが、確認できた情報では新しい発表がありました[1]。",
      ),
    ).toBe(false);
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
