import { describe, expect, it } from "vitest";
import { shouldResetTranslationOnNavigation } from "./translation-route-policy";

describe("translation route policy", () => {
  it("resets when entering a fresh chat thread", () => {
    expect(
      shouldResetTranslationOnNavigation("/conversations/42", "/chat"),
    ).toBe(true);
  });

  it("does not repeatedly reset while staying on the blank thread", () => {
    expect(shouldResetTranslationOnNavigation("/chat", "/chat")).toBe(false);
  });

  it("does not reset when opening an existing conversation", () => {
    expect(
      shouldResetTranslationOnNavigation("/chat", "/conversations/42"),
    ).toBe(false);
  });

  it("resets when a blank thread replaces a conversation on the same route", () => {
    expect(shouldResetTranslationOnNavigation("/chat", "/chat", 42, null)).toBe(
      true,
    );
    expect(
      shouldResetTranslationOnNavigation("/chat", "/chat", null, null),
    ).toBe(false);
  });

  it("also resets when entering a fresh private thread", () => {
    expect(
      shouldResetTranslationOnNavigation("/conversations/42", "/private"),
    ).toBe(true);
  });
});
