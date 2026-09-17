import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeCodingTool, isCodingTool } from "./coding-tools";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "coding-tools-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("coding tools", () => {
  it("writes, reads, and edits through the tool facade", () => {
    const root = tempRoot();
    const created = executeCodingTool(
      {
        id: "1",
        name: "code_write",
        arguments: JSON.stringify({
          path: "src/app.ts",
          content: "export const n = 1;\n",
        }),
      },
      root,
    );
    expect(created.ok).toBe(true);
    expect(created.touch).toMatchObject({ path: "src/app.ts", kind: "create" });
    expect(readFileSync(path.join(root, "src/app.ts"), "utf8")).toBe(
      "export const n = 1;\n",
    );

    const edited = executeCodingTool(
      {
        id: "2",
        name: "code_edit",
        arguments: JSON.stringify({
          path: "src/app.ts",
          old_string: "n = 1",
          new_string: "n = 2",
        }),
      },
      root,
    );
    expect(edited.ok).toBe(true);
    expect(readFileSync(path.join(root, "src/app.ts"), "utf8")).toContain(
      "n = 2",
    );

    const listed = executeCodingTool(
      { id: "3", name: "code_list", arguments: "{}" },
      root,
    );
    expect(listed.ok).toBe(true);
    expect(listed.text).toContain("src");
  });

  it("does not treat unknown tools as coding tools", () => {
    expect(isCodingTool({ name: "web_search" })).toBe(false);
    expect(isCodingTool({ name: "code_read" })).toBe(true);
  });

  it("returns a tool error instead of throwing on bad paths", () => {
    const root = tempRoot();
    const result = executeCodingTool(
      {
        id: "4",
        name: "code_read",
        arguments: JSON.stringify({ path: "../etc/passwd" }),
      },
      root,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/不正|プロジェクト外/);
  });
});
