import { describe, expect, it } from "vitest";
import {
  buildRecentSearchConversation,
  buildSearchFallbackQuery,
  needsConversationAwareSearchPlan,
} from "./search-conversation";

describe("buildRecentSearchConversation", () => {
  it("keeps recent text turns and removes the duplicated current message", () => {
    const context = buildRecentSearchConversation(
      [
        { role: "user", content: "今日と明日、広島で映画を見るならどちら？" },
        { role: "assistant", content: "天気も含めて比較できます。" },
        { role: "user", content: "天候情報を比較してくれるか？" },
      ],
      "天候情報を比較してくれるか？",
    );

    expect(context).toContain(
      "ユーザー: 今日と明日、広島で映画を見るならどちら？",
    );
    expect(context).toContain("アシスタント: 天気も含めて比較できます。");
    expect(context).not.toContain("天候情報を比較してくれるか？");
  });

  it("keeps only text parts from multimodal messages", () => {
    const context = buildRecentSearchConversation(
      [
        {
          role: "user",
          content: [
            { type: "text", text: "札幌について" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAAA" },
            },
          ],
        },
      ],
      "続けて",
    );

    expect(context).toBe("ユーザー: 札幌について");
    expect(context).not.toContain("base64");
  });
});

describe("needsConversationAwareSearchPlan", () => {
  it("routes natural-language and follow-up questions through the planner", () => {
    expect(
      needsConversationAwareSearchPlan(
        "天候情報を比較してくれるか？",
        "ユーザー: 今日と明日、広島で映画を見るならどちら？",
      ),
    ).toBe(true);
    expect(needsConversationAwareSearchPlan("広島 天気", "")).toBe(false);
  });
});

describe("buildSearchFallbackQuery", () => {
  it("inherits the last user question when a follow-up planner fails", () => {
    expect(
      buildSearchFallbackQuery(
        "天候情報を比較してくれるか？",
        "ユーザー: 今日と明日、広島で映画を見るならどちら？\nアシスタント: 比較します。",
      ),
    ).toContain("今日と明日、広島");
  });
});
