import { describe, expect, it } from "vitest";
import { applyClientPatch } from "./audit-patch";

describe("applyClientPatch", () => {
  it("applies the complete find/replacement patch in one state update", () => {
    expect(applyClientPatch("abcdef", [{ find: "bc", replacement: "XY" }])).toBe("aXYdef");
    expect(applyClientPatch("日本語😀", [{ find: "語😀", replacement: "文" }])).toBe("日本文");
  });

  it("rejects malformed, fenced, duplicate, and empty-find patches", () => {
    expect(applyClientPatch("abcdef", [{ find: "bc", replacement: "x" }, { find: "b", replacement: "y" }])).toBeNull();
    expect(applyClientPatch("abcdef", [{ find: "missing", replacement: "x" }])).toBeNull();
    expect(applyClientPatch("abcdef", [{ find: "", replacement: "x" }])).toBeNull();
    expect(applyClientPatch("同じ同じ", [{ find: "同じ", replacement: "別" }])).toBeNull();
    expect(applyClientPatch("abcdef", "```json\n[]\n```")).toBeNull();
  });

  it("rejects operation count, individual, total, and final length limits", () => {
    expect(applyClientPatch("a", Array.from({ length: 9 }, () => ({ find: "a", replacement: "x" })))).toBeNull();
    expect(applyClientPatch("a", [{ find: "a", replacement: "x".repeat(4001) }])).toBeNull();
    expect(applyClientPatch("abcdefgh", Array.from({ length: 8 }, (_, i) => ({ find: "abcdefgh"[i], replacement: "x".repeat(1501) })))).toBeNull();
    expect(applyClientPatch("a", [{ find: "a", replacement: "x".repeat(20001) }])).toBeNull();
  });
});