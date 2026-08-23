import { describe, expect, it } from "vitest";
import { applyValidatedAuditPatch } from "./audit-patch";

describe("applyValidatedAuditPatch", () => {
  it("applies bounded find/replacement edits atomically", () => {
    expect(applyValidatedAuditPatch("abcdef", JSON.stringify({
      note: "fix",
      operations: [{ find: "bc", replacement: "XY" }],
    }))).toMatchObject({ content: "aXYdef", applied: true });
  });

  it("handles Japanese, emoji, and surrogate pairs without numeric offsets", () => {
    expect(applyValidatedAuditPatch("日本語😀です", JSON.stringify({
      operations: [{ find: "語😀", replacement: "文" }],
    })).content).toBe("日本文です");
  });

  it("rejects every invalid operation atomically", () => {
    const draft = "abcdef";
    const invalid = [
      "not-json",
      "```json\n{\"operations\":[]}\n```",
      JSON.stringify({ operations: [{ find: "", replacement: "x" }] }),
      JSON.stringify({ operations: [{ find: "missing", replacement: "x" }] }),
      JSON.stringify({ operations: [{ find: "a", replacement: "x" }, { find: "a", replacement: "y" }] }),
      JSON.stringify({ operations: [{ find: "bc", replacement: "x" }, { find: "b", replacement: "y" }] }),
      JSON.stringify({ operations: [{ find: "a", replacement: "x".repeat(4001) }] }),
      JSON.stringify({ operations: Array.from({ length: 9 }, () => ({ find: "a", replacement: "x" })) }),
      JSON.stringify({ operations: [{ find: "a", replacement: "x".repeat(8000) }] }),
    ];
    for (const raw of invalid) {
      expect(applyValidatedAuditPatch(draft, raw).content).toBe(draft);
      expect(applyValidatedAuditPatch(draft, raw).applied).toBe(false);
    }
  });

  it("rejects a find that occurs more than once", () => {
    const result = applyValidatedAuditPatch("同じ同じ", JSON.stringify({
      operations: [{ find: "同じ", replacement: "別" }],
    }));
    expect(result).toMatchObject({ content: "同じ同じ", applied: false });
  });

  it("rejects replacement total and final answer limits atomically", () => {
    const draft = "a".repeat(8);
    const total = applyValidatedAuditPatch(draft, JSON.stringify({
      operations: Array.from({ length: 8 }, (_, i) => ({ find: draft[i], replacement: "x".repeat(1501) })),
    }));
    expect(total.content).toBe(draft);
    const final = applyValidatedAuditPatch("a", JSON.stringify({
      operations: [{ find: "a", replacement: "x".repeat(20_001) }],
    }));
    expect(final.content).toBe("a");
  });
});