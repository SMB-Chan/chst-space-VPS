import { describe, expect, it } from "vitest";
import { mergeStreamDelta, splitThinkTags } from "./stream-delta";

describe("mergeStreamDelta", () => {
  it("appends incremental tokens", () => {
    expect(mergeStreamDelta("", "Hello")).toBe("Hello");
    expect(mergeStreamDelta("Hello", " world")).toBe("Hello world");
  });

  it("replaces when the provider sends the full text so far", () => {
    expect(mergeStreamDelta("Hello", "Hello world")).toBe("Hello world");
    expect(mergeStreamDelta("Hello world", "Hello world")).toBe("Hello world");
  });

  it("keeps the longer prefix when a stale shorter snapshot arrives", () => {
    expect(mergeStreamDelta("Hello world", "Hello")).toBe("Hello world");
  });
});

describe("splitThinkTags", () => {
  it("moves completed think blocks out of the visible answer", () => {
    expect(splitThinkTags("<think>plan</think>\n\nAnswer here")).toEqual({
      reasoning: "plan",
      content: "Answer here",
    });
  });
});
