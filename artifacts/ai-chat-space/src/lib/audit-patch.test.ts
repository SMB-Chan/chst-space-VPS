import { describe, expect, it } from "vitest";
import { applyClientPatch } from "./audit-patch";

describe("applyClientPatch", () => {
  it("applies the complete exact-match patch in one state update", () => {
    expect(
      applyClientPatch("前🙂日本語🚀後", [
        { find: "🙂日本語🚀", replacement: "✅修正済み" },
      ]),
    ).toBe("前✅修正済み後");
  });

  it.each([
    [[{ find: "", replacement: "x" }]],
    [[{ find: "missing", replacement: "x" }]],
    [[{ find: "same", replacement: "x" }]],
    [
      [
        { find: "abc", replacement: "x" },
        { find: "bc", replacement: "y" },
      ],
    ],
    [
      [
        { find: "abc", replacement: "x" },
        { find: "abc", replacement: "y" },
      ],
    ],
    [[{ find: "abc", replacement: "x".repeat(4001) }]],
  ])("rejects invalid or ambiguous operations atomically", (operations) => {
    const draft = operations[0]?.find === "same" ? "same same" : "abcdef";
    expect(applyClientPatch(draft, operations)).toBeNull();
  });

  it("rejects excessive aggregate growth and final length", () => {
    expect(
      applyClientPatch(
        "abcdefgh",
        Array.from({ length: 3 }, (_, index) => ({
          find: "abcdefgh"[index],
          replacement: "x".repeat(3000),
        })),
      ),
    ).toBeNull();
    expect(
      applyClientPatch("a".repeat(19_999) + "z", [
        { find: "z", replacement: "zz" },
      ]),
    ).toBeNull();
  });
});
