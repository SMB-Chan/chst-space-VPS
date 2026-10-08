import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectNameToFolder, resolveInsideRoot } from "./workspace-folders";

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

describe("resolveInsideRoot", () => {
  const dirs: string[] = [];
  const mk = (): string => {
    const d = mkdtempSync(path.join(tmpdir(), "ws-root-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("resolves plain and not-yet-existing paths inside the root", () => {
    const root = mk();
    mkdirSync(path.join(root, "a"));
    expect(resolveInsideRoot(root, "a/b/c.txt", "nope")).toBe(
      path.join(root, "a/b/c.txt"),
    );
    expect(resolveInsideRoot(root, "", "nope")).toBe(path.resolve(root));
  });

  it("rejects lexical escapes", () => {
    const root = mk();
    expect(() => resolveInsideRoot(root, "../x", "nope")).toThrow("nope");
  });

  it("rejects paths through a symlink that points outside the root", () => {
    const root = mk();
    const outside = mk();
    writeFileSync(path.join(outside, "secret.txt"), "s");
    symlinkSync(outside, path.join(root, "link"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "f.txt"));
    expect(() => resolveInsideRoot(root, "link/secret.txt", "nope")).toThrow(
      "nope",
    );
    expect(() => resolveInsideRoot(root, "link/new/file", "nope")).toThrow(
      "nope",
    );
    expect(() => resolveInsideRoot(root, "f.txt", "nope")).toThrow("nope");
  });

  it("allows symlinks that stay inside the root", () => {
    const root = mk();
    mkdirSync(path.join(root, "real"));
    symlinkSync(path.join(root, "real"), path.join(root, "alias"));
    expect(resolveInsideRoot(root, "alias/x", "nope")).toBe(
      path.join(root, "alias/x"),
    );
  });
});
