import { describe, expect, it } from "vitest";
import { applyClientPatch } from "./audit-patch";

describe("applyClientPatch", () => {
  it("applies the complete patch in one state update", () => {
    expect(applyClientPatch("abcdef", [{ target: "bc", replacement: "XY" }])).toBe("aXYdef");
    expect(applyClientPatch("日本語😀", [{ target: "語😀", replacement: "文" }])).toBe("日本文");
  });
  it("rejects malformed and overlapping patches without changing the draft", () => {
    expect(applyClientPatch("abcdef", [{ target: "bc", replacement: "x" }, { target: "b", replacement: "y" }])).toBeNull();
    expect(applyClientPatch("abcdef", [{ target: "missing", replacement: "x" }])).toBeNull();
  });
});