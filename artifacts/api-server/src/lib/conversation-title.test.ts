import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TITLE_MAX,
  normalizeConversationTitle,
} from "./conversation-title";

describe("normalizeConversationTitle", () => {
  it("rejects blank titles", () => {
    expect(normalizeConversationTitle("")).toBeNull();
    expect(normalizeConversationTitle("   \n")).toBeNull();
  });

  it("collapses whitespace", () => {
    expect(normalizeConversationTitle("  今日の  予定  ")).toBe("今日の 予定");
  });

  it("caps length", () => {
    const long = "あ".repeat(CONVERSATION_TITLE_MAX + 10);
    expect(normalizeConversationTitle(long)?.length).toBe(
      CONVERSATION_TITLE_MAX,
    );
  });
});
