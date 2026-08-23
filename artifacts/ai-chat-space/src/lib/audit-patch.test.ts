import { describe, expect, it } from "vitest";
import { applyClientPatch } from "./audit-patch";

describe("applyClientPatch", () => {
  it("applies the complete patch in one state update", () => {
    expect(applyClientPatch("abcdef", [{ start: 1, end: 3, replacement: "XY" }])).toBe("aXYdef");
  });
  it("rejects malformed and overlapping patches without changing the draft", () => {
    expect(applyClientPatch("abcdef", [{ start: 0, end: 3, replacement: "x" }, { start: 2, end: 4, replacement: "y" }])).toBeNull();
    expect(applyClientPatch("abcdef", [{ start: -1, end: 2, replacement: "x" }])).toBeNull();
  });
});