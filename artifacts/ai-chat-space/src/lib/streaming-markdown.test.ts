import { describe, expect, it } from "vitest";
import { splitStreamingMarkdown } from "./streaming-markdown";

describe("streaming Markdown block safety", () => {
  it("freezes completed safe blocks and keeps only the tail mutable", () => {
    const initial = [
      "# Heading",
      "",
      "A completed paragraph.",
      "",
      "- first item",
      "- second item",
      "",
      "Mutable tail",
    ].join("\n");

    const parts = splitStreamingMarkdown(initial);
    expect(parts.mode).toBe("incremental");
    expect(parts.stableBlocks).toEqual([
      "# Heading",
      "A completed paragraph.",
      "- first item\n- second item",
    ]);
    expect(parts.tail).toBe("Mutable tail");

    const updated = splitStreamingMarkdown(`${initial} with more text`);
    expect(updated.stableBlocks).toEqual(parts.stableBlocks);
    expect(updated.tail).toBe("Mutable tail with more text");
  });

  it.each([
    ["table", "| Name | Value |\n| --- | --- |\n| one | 1 |"],
    ["blockquote", "> A quoted paragraph\n> with continuation"],
    ["fenced code", "```ts\nconst answer = 42;\n```"],
  ])("freezes a completed %s block", (_name, block) => {
    const parts = splitStreamingMarkdown(`${block}\n\nTail`);

    expect(parts.mode).toBe("incremental");
    expect(parts.stableBlocks).toEqual([block]);
    expect(parts.tail).toBe("Tail");
  });

  it.each([
    ["reference definition", "before\n\n[docs]: https://example.com\n\nTail"],
    ["reference-style link", "before\n\n[docs][ref]\n\nTail"],
    ["HTML block", "before\n\n<div>unsafe structure</div>\n\nTail"],
  ])("falls back to full rendering for %s", (_name, content) => {
    const parts = splitStreamingMarkdown(content);

    expect(parts.mode).toBe("full");
    expect(parts.stableBlocks).toEqual([]);
    expect(parts.tail).toBe(content);
  });

  it("keeps an unfinished fence in the mutable tail", () => {
    const content = "Stable paragraph.\n\n```ts\nconst value = 1";
    const parts = splitStreamingMarkdown(content);

    expect(parts.mode).toBe("incremental");
    expect(parts.stableBlocks).toEqual(["Stable paragraph."]);
    expect(parts.tail).toBe("```ts\nconst value = 1");
  });
});
