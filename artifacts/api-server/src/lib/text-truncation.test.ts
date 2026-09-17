import { describe, expect, it } from "vitest";
import {
  clipHeadTailUtf8Safe,
  clipHeadUtf8Safe,
} from "./text-truncation";

describe("clipHeadUtf8Safe", () => {
  it("returns short text unchanged", () => {
    expect(clipHeadUtf8Safe("短い", 100)).toBe("短い");
  });

  it("never splits surrogate pairs", () => {
    const text = "🌸".repeat(100);
    const clipped = clipHeadUtf8Safe(text, 20);
    expect(clipped).not.toContain("�");
    expect([...clipped].length).toBeLessThanOrEqual(20);
    expect(clipped).toContain("省略");
  });

  it("snaps to a line boundary near the budget", () => {
    const text = `line1 abcdefghij\nline2 klmnopqrst\nline3 uvwxyz 0123456789`;
    const clipped = clipHeadUtf8Safe(text, 40);
    expect(clipped).toContain("line1");
    expect(clipped).toContain("省略");
    expect([...clipped].length).toBeLessThanOrEqual(40);
  });
});

describe("clipHeadTailUtf8Safe", () => {
  it("keeps the head and tail with a marker in between", () => {
    const text = `HEAD\n${"あ".repeat(500)}\nTAIL`;
    const clipped = clipHeadTailUtf8Safe(text, 100);
    expect(clipped).toContain("HEAD");
    expect(clipped).toContain("TAIL");
    expect(clipped).toContain("省略");
    expect([...clipped].length).toBeLessThanOrEqual(100);
  });

  it("never splits surrogate pairs", () => {
    const text = `start ${"🌸".repeat(200)} end`;
    const clipped = clipHeadTailUtf8Safe(text, 60);
    expect(clipped).not.toContain("�");
    expect(clipped).toContain("start");
    expect(clipped).toContain("end");
  });
});
