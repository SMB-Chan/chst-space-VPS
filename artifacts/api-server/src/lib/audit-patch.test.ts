import { describe, expect, it } from "vitest";
import { applyValidatedAuditPatch } from "./audit-patch";

describe("applyValidatedAuditPatch", () => {
  it("applies bounded non-overlapping edits atomically", () => {
    expect(applyValidatedAuditPatch("abcdef", JSON.stringify({
      note: "fix",
      operations: [{ start: 1, end: 3, replacement: "XY" }],
    }))).toMatchObject({ content: "aXYdef", applied: true });
  });
  it("keeps the draft for malformed, overlapping, and oversized patches", () => {
    for (const raw of [
      "not-json",
      JSON.stringify({ operations: [{ start: 0, end: 4, replacement: "x".repeat(4001) }] }),
      JSON.stringify({ operations: [{ start: 0, end: 3, replacement: "x" }, { start: 2, end: 4, replacement: "y" }] }),
    ]) {
      expect(applyValidatedAuditPatch("abcdef", raw).content).toBe("abcdef");
      expect(applyValidatedAuditPatch("abcdef", raw).applied).toBe(false);
    }
  });
});