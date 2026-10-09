import { describe, expect, it } from "vitest";
import {
  getProjectLimits,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
} from "./project-limits";

describe("project limits", () => {
  it("returns defaults matching the documented values", () => {
    const limits = getProjectLimits();
    expect(limits.fileMaxBytes).toBe(20 * 1024 * 1024);
    expect(limits.maxFilesPerProject).toBe(50);
    expect(limits.userTotalMaxBytes).toBe(500 * 1024 * 1024);
    expect(limits.fileTextMaxChars).toBe(100_000);
    expect(limits.instructionsMaxChars).toBe(4000);
    expect(limits.filesContextMaxChars).toBe(8000);
    expect(limits.fileContextPerFileMaxChars).toBe(4000);
  });

  it("exposes a stable shape", () => {
    expect(getProjectLimits()).toEqual(
      expect.objectContaining({
        fileMaxBytes: expect.any(Number),
        maxFilesPerProject: expect.any(Number),
        userTotalMaxBytes: expect.any(Number),
        fileTextMaxChars: expect.any(Number),
        instructionsMaxChars: expect.any(Number),
        filesContextMaxChars: expect.any(Number),
        fileContextPerFileMaxChars: expect.any(Number),
      }),
    );
  });

  it("keeps the instructions constant as a hard cap", () => {
    expect(PROJECT_INSTRUCTIONS_MAX_CHARS).toBe(4000);
  });
});
