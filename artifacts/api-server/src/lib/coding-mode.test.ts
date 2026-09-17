import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCodingEdit,
  applyCodingWrite,
  applyCompletedCodingWrites,
  diffLines,
  formatCodingTree,
  listCodingDir,
  normalizeCodingPath,
  persistableCodingTouch,
  readCodingFile,
  scanCodingFileBlocks,
  searchCodingFiles,
  stripCodingFileBlocks,
} from "./coding-mode";

const tempDirs: string[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "coding-mode-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("normalizeCodingPath", () => {
  it("rejects escapes, empties, and parent segments", () => {
    expect(normalizeCodingPath("../secret")).toBeNull();
    expect(normalizeCodingPath("foo/../bar")).toBeNull();
    expect(normalizeCodingPath("")).toBeNull();
    expect(normalizeCodingPath("foo//bar")).toBeNull();
  });

  it("accepts nested relative paths", () => {
    expect(normalizeCodingPath("./src/app.ts")).toBe("src/app.ts");
    expect(normalizeCodingPath("src\\lib\\x.ts")).toBe("src/lib/x.ts");
  });
});

describe("scanCodingFileBlocks", () => {
  it("ignores earlier prose fences and reads the file block", () => {
    const text = [
      "see:",
      "```",
      "foo",
      "```",
      "",
      "```file:a.ts",
      "export const a = 1;",
      "```",
      "done",
    ].join("\n");
    const { blocks, cursor } = scanCodingFileBlocks(text, 0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.path).toBe("a.ts");
    expect(blocks[0]?.content).toBe("export const a = 1;\n");
    expect(text.slice(cursor)).toBe("\ndone");
  });

  it("leaves an incomplete fence for a later pass", () => {
    const text = "```file:b.ts\nexport const b = 2;";
    const { blocks, cursor } = scanCodingFileBlocks(text, 0);
    expect(blocks).toEqual([]);
    expect(cursor).toBe(0);
  });
});

describe("stripCodingFileBlocks", () => {
  it("keeps prose around file fences", () => {
    const text = [
      "src/app.ts を更新しました。",
      "```file:src/app.ts",
      "export {}",
      "```",
      "次はテストです。",
    ].join("\n");
    expect(stripCodingFileBlocks(text)).toBe(
      "src/app.ts を更新しました。\n\n次はテストです。",
    );
  });
});

describe("applyCompletedCodingWrites", () => {
  it("creates and edits files inside the project root", () => {
    const root = tempRoot();
    const created = applyCompletedCodingWrites(
      root,
      ["```file:src/hello.ts", "export const n = 1;", "```"].join("\n"),
    );
    expect(created.touches[0]).toMatchObject({
      path: "src/hello.ts",
      kind: "create",
      removed: 0,
    });
    expect(created.touches[0]?.added).toBeGreaterThan(0);
    expect(readFileSync(path.join(root, "src/hello.ts"), "utf8")).toBe(
      "export const n = 1;\n",
    );

    const edited = applyCompletedCodingWrites(
      root,
      ["```file:src/hello.ts", "export const n = 2;", "```"].join("\n"),
    );
    expect(edited.touches[0]).toMatchObject({
      path: "src/hello.ts",
      kind: "edit",
      added: 1,
      removed: 1,
    });
    expect(readFileSync(path.join(root, "src/hello.ts"), "utf8")).toBe(
      "export const n = 2;\n",
    );
  });

  it("refuses to write outside the project root", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "inside.ts"), "ok", "utf8");
    expect(() => applyCodingWrite(root, "../escape.ts", "nope")).toThrow(
      /プロジェクト外/,
    );
  });

  it("omits patch from the persisted touch", () => {
    const touch = persistableCodingTouch({
      path: "a.ts",
      kind: "create",
      added: 1,
      removed: 0,
      patch: "@@ new file @@\n+a",
    });
    expect(touch).toEqual({
      path: "a.ts",
      kind: "create",
      added: 1,
      removed: 0,
    });
    expect("patch" in touch).toBe(false);
  });
});

describe("workspace inspect/edit", () => {
  it("lists, reads, searches, and partially edits files", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n", "utf8");
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/b.ts"), "export const b = 2;\n", "utf8");

    expect(listCodingDir(root).map((entry) => entry.path)).toEqual([
      "src",
      "a.ts",
    ]);
    expect(formatCodingTree(root)).toContain("src/");
    expect(readCodingFile(root, "a.ts").content).toContain(
      "export const a = 1;",
    );
    expect(searchCodingFiles(root, "export const b")).toEqual([
      expect.objectContaining({ path: "src/b.ts", line: 1 }),
    ]);

    const touch = applyCodingEdit(
      root,
      "a.ts",
      "export const a = 1;",
      "export const a = 3;",
    );
    expect(touch.kind).toBe("edit");
    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toContain(
      "export const a = 3;",
    );
  });

  it("rejects ambiguous edits and escaped search paths", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "dup.ts"), "foo\nfoo\n", "utf8");
    expect(() => applyCodingEdit(root, "dup.ts", "foo", "bar")).toThrow(
      /2 箇所/,
    );
    expect(() => listCodingDir(root, "../secret")).toThrow(/不正/);
  });
});

describe("diffLines", () => {
  it("counts a new file as additions only", () => {
    expect(diffLines(null, "a\nb")).toEqual({
      added: 2,
      removed: 0,
      patch: expect.stringContaining("+a"),
    });
  });
});
