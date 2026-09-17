import { describe, expect, it } from "vitest";
import { projectNameToFolder } from "./workspace-folders";

describe("projectNameToFolder", () => {
  it("keeps plain names unchanged", () => {
    expect(projectNameToFolder("Wao")).toBe("Wao");
    expect(projectNameToFolder("Chat-Space VPS")).toBe("Chat-Space VPS");
  });

  it("replaces filesystem-unsafe characters", () => {
    expect(projectNameToFolder('a/b\\c:d*e?f"g<h>i|j')).toBe(
      "a-b-c-d-e-f-g-h-i-j",
    );
  });

  it("falls back to a generated name for empty input", () => {
    expect(projectNameToFolder("   ")).toMatch(/^project-\d+$/);
    expect(projectNameToFolder("")).toMatch(/^project-\d+$/);
  });

  it("caps the length at 80 characters", () => {
    expect(projectNameToFolder("x".repeat(120)).length).toBe(80);
  });
});
