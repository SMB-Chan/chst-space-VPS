import { describe, expect, it } from "vitest";
import { sanitizeProjectFilename } from "./project-files-store";

describe("sanitizeProjectFilename", () => {
  it("strips path components and trims", () => {
    expect(sanitizeProjectFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeProjectFilename("..\\..\\evil.txt")).toBe("evil.txt");
    expect(sanitizeProjectFilename("  spaced.txt  ")).toBe("spaced.txt");
  });

  it("removes control characters", () => {
    expect(sanitizeProjectFilename("file\u0000name.txt")).toBe("filename.txt");
    expect(sanitizeProjectFilename("file\u0007\u001fname.txt")).toBe(
      "filename.txt",
    );
  });

  it("falls back to 'file' when the name is empty after stripping", () => {
    expect(sanitizeProjectFilename("")).toBe("file");
    expect(sanitizeProjectFilename("///")).toBe("file");
    expect(sanitizeProjectFilename("\u0000")).toBe("file");
  });

  it("caps the filename length at 200 characters", () => {
    const long = `${"a".repeat(250)}.txt`;
    expect(sanitizeProjectFilename(long).length).toBeLessThanOrEqual(200);
  });
});
