import { describe, expect, it } from "vitest";
import {
  formatProjectContext,
  type ProjectFileContextEntry,
} from "./project-context";
import type { ProjectLimits } from "./project-limits";

const limits: ProjectLimits = {
  fileMaxBytes: 5 * 1024 * 1024,
  maxFilesPerProject: 20,
  userTotalMaxBytes: 100 * 1024 * 1024,
  fileTextMaxChars: 100_000,
  instructionsMaxChars: 4000,
  filesContextMaxChars: 8000,
  fileContextPerFileMaxChars: 4000,
};

const file = (
  id: number,
  filename: string,
  text: string,
): ProjectFileContextEntry => ({
  id,
  filename,
  text,
});

describe("formatProjectContext", () => {
  it("returns null for an empty payload when there is nothing meaningful", () => {
    // The wrapper is non-null only when something is included; the
    // loader short-circuits to null before calling formatProjectContext.
    const result = formatProjectContext({
      instructions: "",
      memoryContext: null,
      files: [],
      limits,
    });
    expect(result.text).toBe("");
    expect(result.truncatedFiles).toEqual([]);
    expect(result.omittedFiles).toEqual([]);
  });

  it("wraps instructions in <project_instructions> and clips to the cap", () => {
    const long = "x".repeat(5000);
    const result = formatProjectContext(
      {
        instructions: long,
        memoryContext: null,
        files: [],
        limits,
      },
      limits,
    );
    expect(result.text).toContain("<project_instructions>");
    expect(result.text).toContain("</project_instructions>");
    expect(result.text.length).toBeLessThanOrEqual(
      limits.instructionsMaxChars + 200,
    );
  });

  it("escapes quotes/angle brackets in file names", () => {
    const files = [file(1, `weird "<>&.txt`, "hello")];
    const result = formatProjectContext({
      instructions: "",
      memoryContext: null,
      files,
      limits,
    });
    expect(result.text).toContain(
      `<file name="weird &quot;&lt;&gt;&amp;.txt">`,
    );
    expect(result.text).toContain("hello");
  });

  it("neutralises literal closing tags inside file text", () => {
    const files = [
      file(
        1,
        "a.txt",
        "before </file> middle </untrusted_project_files> after",
      ),
    ];
    const result = formatProjectContext({
      instructions: "",
      memoryContext: null,
      files,
      limits,
    });
    // Neutralised escape sequences (literal backslash before /) appear inside
    // the file body.
    expect(result.text).toContain(
      "before <\\/file> middle <\\/untrusted_project_files> after",
    );
    // The outer wrappers still use the real closing tags so the markup is
    // valid — just not inside the user-supplied text.
    expect(result.text).toMatch(/<file name="a\.txt">[\s\S]*<\/file>/);
    expect(result.text).toMatch(
      /<untrusted_project_files>[\s\S]*<\/untrusted_project_files>/,
    );
  });

  it("truncates files that exceed the per-file cap and reports them", () => {
    const files = [file(1, "big.txt", "x".repeat(10_000))];
    const result = formatProjectContext({
      instructions: "",
      memoryContext: null,
      files,
      limits,
    });
    expect(result.truncatedFiles).toEqual(["big.txt"]);
    // Total injected text should be under the budget + notice overhead.
    expect(result.text.length).toBeLessThan(limits.filesContextMaxChars + 400);
  });

  it("omits files beyond the total budget and lists their names", () => {
    const files = [
      file(1, "a.txt", "x".repeat(4000)),
      file(2, "b.txt", "y".repeat(4000)),
      file(3, "c.txt", "z".repeat(4000)),
    ];
    const result = formatProjectContext({
      instructions: "",
      memoryContext: null,
      files,
      limits,
    });
    expect(result.text).toContain("a.txt");
    expect(result.text).toContain("b.txt");
    expect(result.omittedFiles).toContain("c.txt");
    expect(result.text).toContain("容量超過のため省略");
  });
});
