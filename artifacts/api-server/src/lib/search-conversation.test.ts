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
  it("keeps only location, dates, and weather intent when the planner fails", () => {
    const query = buildSearchFallbackQuery(
      "天候情報を比較してくれるか？",
      "ユーザー: 今日と明日、広島で映画を見るならどちら？\nアシスタント: 比較します。",
      new Date("2026-09-02T06:00:00.000Z"),
    );

    expect(query).toBe("広島 2026-09-02 2026-09-03 天気予報 比較");
    expect(query).not.toContain("映画");
  });

  it("does not invent a location when weather context has none", () => {
    expect(
      buildSearchFallbackQuery(
        "今日と明日の天気を比較してくれるか？",
        "ユーザー: 映画を見るならどちら？",
        new Date("2026-09-02T06:00:00.000Z"),
      ),
    ).toBe("");
  });

  it("compacts the non-weather fallback into keyword-shaped text", () => {
    const query = buildSearchFallbackQuery(
      "発売日を教えて",
      "ユーザー: 一番くじ ガンダム",
      new Date("2026-09-02T06:00:00.000Z"),
    );
    expect(query).toBe("一番くじ ガンダム 発売日");
    expect(query).not.toContain("教えて");
  });
});
