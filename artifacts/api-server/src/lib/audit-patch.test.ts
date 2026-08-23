import { describe, expect, it } from "vitest";
import { applyValidatedAuditPatch } from "./audit-patch";

describe("applyValidatedAuditPatch", () => {
  it("applies bounded non-overlapping edits atomically", () => {
    expect(applyValidatedAuditPatch("abcdef", JSON.stringify({
      note: "fix",
       operations: [{ target: "bc", replacement: "XY" }],
     }))).toMatchObject({ content: "aXYdef", applied: true });
  });
  it("keeps the draft for malformed, overlapping, and oversized patches", () => {
    for (const raw of [
      "not-json",
       JSON.stringify({ operations: [{ target: "a", replacement: "x".repeat(4001) }] }),
       JSON.stringify({ operations: [{ target: "bc", replacement: "x" }, { target: "b", replacement: "y" }] }),
       JSON.stringify({ operations: [{ target: "missing", replacement: "x" }] }),
       JSON.stringify({ operations: [{ target: "a", replacement: "x" }, { target: "a", replacement: "y" }] }),
    ]) {
      expect(applyValidatedAuditPatch("abcdef", raw).content).toBe("abcdef");
      expect(applyValidatedAuditPatch("abcdef", raw).applied).toBe(false);
    }
  });
});