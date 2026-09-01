import { describe, expect, it } from "vitest";
import { applyValidatedAuditPatch } from "./audit-patch";

function patch(draft: string, operations: unknown, note = "fix") {
  return applyValidatedAuditPatch(draft, JSON.stringify({ note, operations }));
}

describe("applyValidatedAuditPatch", () => {
  it("applies bounded unique exact replacements atomically", () => {
    expect(
      patch("概要: 古い\n結論: 保持", [
        { find: "概要: 古い", replacement: "概要: 新しい" },
        { find: "結論: 保持", replacement: "結論: 維持" },
      ]),
    ).toMatchObject({
      content: "概要: 新しい\n結論: 維持",
      applied: true,
      operations: [
        { find: "概要: 古い", replacement: "概要: 新しい" },
        { find: "結論: 保持", replacement: "結論: 維持" },
      ],
    });
  });

  it("handles Japanese, emoji, and surrogate pairs without numeric offsets", () => {
    expect(
      patch("前🙂日本語🚀後", [
        { find: "🙂日本語🚀", replacement: "✅修正済み" },
      ]),
    ).toMatchObject({ content: "前✅修正済み後", applied: true });
  });

  it("accepts a single JSON code fence", () => {
    const raw = `\`\`\`json
{"note":"ok","operations":[{"find":"旧","replacement":"新"}]}
\`\`\``;
    expect(applyValidatedAuditPatch("旧", raw)).toMatchObject({
      content: "新",
      applied: true,
    });
  });

  it.each([
    ["malformed JSON", "not-json"],
    [
      "empty find",
      JSON.stringify({ operations: [{ find: "", replacement: "x" }] }),
    ],
    [
      "missing find",
      JSON.stringify({ operations: [{ find: "missing", replacement: "x" }] }),
    ],
    [
      "ambiguous find",
      JSON.stringify({ operations: [{ find: "same", replacement: "x" }] }),
    ],
    [
      "overlapping ranges",
      JSON.stringify({
        operations: [
          { find: "abc", replacement: "x" },
          { find: "bc", replacement: "y" },
        ],
      }),
    ],
    [
      "duplicate operation",
      JSON.stringify({
        operations: [
          { find: "abc", replacement: "x" },
          { find: "abc", replacement: "y" },
        ],
      }),
    ],
    [
      "oversized replacement",
      JSON.stringify({
        operations: [{ find: "abc", replacement: "x".repeat(4001) }],
      }),
    ],
    [
      "too many operations",
      JSON.stringify({
        operations: Array.from({ length: 9 }, (_, index) => ({
          find: String(index),
          replacement: "x",
        })),
      }),
    ],
  ])("keeps the complete draft for %s", (_name, raw) => {
    const draft = raw.includes("same") ? "same same" : "abcdef012345678";
    const result = applyValidatedAuditPatch(draft, raw);
    expect(result.content).toBe(draft);
    expect(result.applied).toBe(false);
  });

  it("rejects excessive aggregate growth and final length", () => {
    const aggregate = patch(
      "abcdefgh",
      Array.from({ length: 3 }, (_, index) => ({
        find: "abcdefgh"[index],
        replacement: "x".repeat(3000),
      })),
    );
    expect(aggregate.applied).toBe(false);
    expect(aggregate.content).toBe("abcdefgh");

    const finalLength = patch("a".repeat(19_999) + "z", [
      { find: "z", replacement: "zz" },
    ]);
    expect(finalLength.applied).toBe(false);
  });

  it("never lets an audit patch erase the visible answer", () => {
    const draft = "短い初稿ですが、ユーザーに見せる有効な回答です。";
    const result = patch(draft, [{ find: draft, replacement: "" }]);
    expect(result).toMatchObject({
      content: draft,
      applied: false,
      reason: expect.stringContaining("実質的に空"),
    });

    const longDraft = "a".repeat(1_000);
    expect(
      patch(longDraft, [{ find: longDraft, replacement: "short" }]),
    ).toMatchObject({ content: longDraft, applied: false });
  });
});
