import { describe, expect, it } from "vitest";
import {
  isResearchAnnouncementOnly,
  shouldSynthesizeResearchAnswer,
} from "./chat-stream";

describe("research completion guards", () => {
  it("detects a search promise that contains neither a tool result nor an answer", () => {
    expect(
      isResearchAnnouncementOnly(
        "最新情報が必要なので、Web検索を行って確認します。",
      ),
    ).toBe(true);
    expect(
      isResearchAnnouncementOnly("調べてから回答します。少々お待ちください。"),
    ).toBe(true);
  });

  it("does not intercept an actual sourced answer or a discussion about search", () => {
    expect(
      isResearchAnnouncementOnly(
        "検索結果によると、対象サービスは2026年8月に更新されました。[1]",
      ),
    ).toBe(false);
    expect(
      isResearchAnnouncementOnly(
        "この設計では検索を使うことができますが、キャッシュがある場合は省略できます。",
      ),
    ).toBe(false);
  });

  it("forces a final synthesis after tool-only or empty continuation", () => {
    expect(
      shouldSynthesizeResearchAnswer({
        executedToolCount: 2,
        continuationText: "さらに検索して確認します。",
        hitStepLimitWithPendingResearch: true,
      }),
    ).toBe(true);
    expect(
      shouldSynthesizeResearchAnswer({
        executedToolCount: 1,
        continuationText: "",
        hitStepLimitWithPendingResearch: false,
      }),
    ).toBe(true);
  });

  it("keeps a completed research answer and ignores turns without tool execution", () => {
    expect(
      shouldSynthesizeResearchAnswer({
        executedToolCount: 1,
        continuationText: "取得した資料では、Aが確認できます。[1]",
        hitStepLimitWithPendingResearch: false,
      }),
    ).toBe(false);
    expect(
      shouldSynthesizeResearchAnswer({
        executedToolCount: 0,
        continuationText: "",
        hitStepLimitWithPendingResearch: true,
      }),
    ).toBe(false);
  });
});
