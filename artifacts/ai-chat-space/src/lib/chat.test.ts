import { describe, expect, it } from "vitest";
import {
  CONVERSATION_TITLE_MAX,
  conversationTitle,
  normalizeConversationTitle,
  timeGreeting,
} from "./chat";

describe("conversationTitle", () => {
  it("uses character truncation so Japanese titles stay short", () => {
    const title = conversationTitle("これはスペースのないとても長い日本語のタイトルで二十四文字を超えます");
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(25);
  });

  it("falls back when empty", () => {
    expect(conversationTitle("   ")).toBe("新しい会話");
  });
});

describe("normalizeConversationTitle", () => {
  it("rejects blank input and caps length", () => {
    expect(normalizeConversationTitle("  ")).toBeNull();
    expect(normalizeConversationTitle("x".repeat(CONVERSATION_TITLE_MAX + 5))?.length).toBe(
      CONVERSATION_TITLE_MAX,
    );
  });
});

describe("timeGreeting", () => {
  it("returns morning copy before 11", () => {
    expect(timeGreeting(new Date(2026, 0, 1, 8)).title).toBe("おはようございます。");
  });
});
