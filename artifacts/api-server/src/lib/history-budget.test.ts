import { describe, expect, it } from "vitest";
import {
  budgetConversationHistory,
  resolveHistoryCharBudget,
  truncateTextMiddle,
} from "./history-budget";

function textTurns(texts: string[]): {
  role: "user" | "assistant";
  content: string;
}[] {
  return texts.map((text, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: text,
  }));
}

describe("budgetConversationHistory", () => {
  it("keeps short histories untouched", () => {
    const history = textTurns(["こんにちは", "こんにちは！"]);
    const result = budgetConversationHistory(history, { maxChars: 1000 });
    expect(result.messages).toEqual(history);
    expect(result.omittedTurnCount).toBe(0);
    expect(result.truncatedTurnCount).toBe(0);
  });

  it("omits the oldest turns first and prepends an explicit notice", () => {
    const history = textTurns([
      "A".repeat(500),
      "B".repeat(500),
      "C".repeat(500),
      "D".repeat(500),
      "E".repeat(500),
    ]);
    const result = budgetConversationHistory(history, {
      maxChars: 1400,
      recentFullTurns: 2,
    });

    expect(result.omittedTurnCount).toBe(2);
    expect(result.messages[0]?.role).toBe("system");
    expect(String(result.messages[0]?.content)).toContain(
      `${result.omittedTurnCount} ターン分`,
    );
    // Newest turns survive verbatim and stay in chronological order.
    expect(result.messages.at(-1)?.content).toBe("E".repeat(500));
    expect(result.messages.at(-2)?.content).toBe("D".repeat(500));
    // The oldest surviving turn is abbreviated when it no longer fits.
    expect(String(result.messages.at(-3)?.content)).toContain("中略");
  });

  it("abbreviates the turn that crosses the budget instead of dropping it", () => {
    const history = textTurns([
      `旧コンテキスト ${"昔".repeat(5000)}`,
      "新しい質問",
      "新しい回答",
    ]);
    const result = budgetConversationHistory(history, {
      maxChars: 4000,
      recentFullTurns: 2,
    });

    expect(result.truncatedTurnCount).toBe(1);
    expect(result.omittedTurnCount).toBe(0);
    const truncated = String(result.messages[0]?.content);
    expect(truncated).toContain("旧コンテキスト");
    expect(truncated).toContain("中略");
    expect(truncated.length).toBeLessThanOrEqual(3990);
  });

  it("abbreviates array content by shrinking text parts and keeping images", () => {
    const imagePart = { type: "image_url", image_url: { url: "data:..." } };
    const history = [
      {
        role: "user" as const,
        content: [
          { type: "text", text: "添付について ".repeat(2000) },
          imagePart,
        ],
      },
      { role: "assistant" as const, content: "回答" },
    ];
    const result = budgetConversationHistory(history, {
      maxChars: 1200,
      recentFullTurns: 1,
    });

    expect(result.truncatedTurnCount).toBe(1);
    const content = result.messages[0]?.content as {
      type: string;
      text: string;
    }[];
    expect(content.some((part) => part.type === "image_url")).toBe(true);
    const textPart = content.find((part) => part.type === "text");
    expect(textPart?.text).toContain("中略");
  });

  it("is deterministic and never returns a negative budget result", () => {
    const history = textTurns(["".repeat(0), "x", "y"]);
    const result = budgetConversationHistory(history, { maxChars: 8000 });
    expect(result.messages).toHaveLength(3);
  });
});

describe("truncateTextMiddle", () => {
  it("keeps the head and tail with a marker in between", () => {
    const text = "HEAD".repeat(100) + "TAIL".repeat(100);
    const truncated = truncateTextMiddle(text, 200);
    expect(truncated.startsWith("HEAD")).toBe(true);
    expect(truncated.endsWith("TAIL")).toBe(true);
    expect(truncated).toContain("中略");
    expect(truncated.length).toBeLessThanOrEqual(200);
  });

  it("returns short text unchanged", () => {
    expect(truncateTextMiddle("短い", 100)).toBe("短い");
  });
});

describe("resolveHistoryCharBudget", () => {
  it("falls back to the default without configuration", () => {
    expect(resolveHistoryCharBudget(undefined)).toBeGreaterThan(0);
    expect(resolveHistoryCharBudget("")).toBeGreaterThan(0);
  });

  it("clamps the configured budget to sane bounds", () => {
    expect(resolveHistoryCharBudget("1")).toBe(8000);
    expect(resolveHistoryCharBudget("99999999")).toBe(200000);
    expect(resolveHistoryCharBudget("12345")).toBe(12345);
    expect(resolveHistoryCharBudget("not-a-number")).toBeGreaterThan(0);
  });
});
