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

  it("also resets when entering a fresh private thread", () => {
    expect(
      shouldResetTranslationOnNavigation("/conversations/42", "/private"),
    ).toBe(true);
  });
});
