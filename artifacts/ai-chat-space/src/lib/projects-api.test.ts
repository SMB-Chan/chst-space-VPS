import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectsApiError,
  base64ToString,
  normalizeProjectsLimits,
  fileToBase64,
  parseProjectIdFromSearch,
  projectsApi,
  stringToBase64,
} from "./projects-api";

describe("parseProjectIdFromSearch", () => {
  it("returns null when missing", () => {
    expect(parseProjectIdFromSearch("")).toBeNull();
    expect(parseProjectIdFromSearch("?foo=bar")).toBeNull();
  });

  it("accepts a positive integer", () => {
    expect(parseProjectIdFromSearch("?project=42")).toBe(42);
  });

  it("handles a leading '?' if present", () => {
    expect(parseProjectIdFromSearch("?project=1&other=2")).toBe(1);
  });

  it("rejects zero, negatives, decimals, and non-numeric values", () => {
    expect(parseProjectIdFromSearch("?project=0")).toBeNull();
    expect(parseProjectIdFromSearch("?project=-1")).toBeNull();
    expect(parseProjectIdFromSearch("?project=1.5")).toBeNull();
    expect(parseProjectIdFromSearch("?project=abc")).toBeNull();
  });
});

describe("base64 helpers", () => {
  it("round-trips a short ASCII string", () => {
    const s = "こんにちは、世界";
    expect(base64ToString(stringToBase64(s))).toBe(s);
  });

  it("does not throw on a > 64 KB string", () => {
    const huge = "あ".repeat(200_000);
    expect(() => stringToBase64(huge)).not.toThrow();
    expect(base64ToString(stringToBase64(huge))).toBe(huge);
  });

  it("preserves characters that need escaping (sjis would not, but utf-8 should)", () => {
    // Direct btoa() on this string throws; chunked form must succeed.
    const s = "🎉🚀漢字";
    expect(() => stringToBase64(s)).not.toThrow();
    expect(base64ToString(stringToBase64(s))).toBe(s);
  });
});

describe("fileToBase64", () => {
  it("encodes a File without the data URL prefix", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    const encoded = await fileToBase64(file);
    expect(encoded.startsWith("data:")).toBe(false);
    expect(base64ToString(encoded)).toBe("hello");
  });
});

describe("ProjectsApiError", () => {
  it("captures status, message, and code", () => {
    const err = new ProjectsApiError(
      "ファイルが大きすぎます。",
      413,
      "TOO_LARGE",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(413);
    expect(err.code).toBe("TOO_LARGE");
    expect(err.message).toBe("ファイルが大きすぎます。");
  });
});

describe("projectsApi error mapping", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }
  function emptyResponse(status = 204): Response {
    return new Response(null, { status });
  }

  it("parses the server's Japanese error and surfaces it", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse(
        { error: "プロジェクトが見つかりません。", code: "NOT_FOUND" },
        404,
      ),
    ) as typeof fetch;
    const err = await projectsApi.get(99).catch((e) => e);
    expect(err).toBeInstanceOf(ProjectsApiError);
    expect((err as ProjectsApiError).status).toBe(404);
    expect((err as ProjectsApiError).code).toBe("NOT_FOUND");
    expect((err as ProjectsApiError).message).toBe(
      "プロジェクトが見つかりません。",
    );
  });

  it("falls back to the generic message when the body has no error", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({}, 500)) as typeof fetch;
    const err = await projectsApi.list().catch((e) => e);
    expect(err).toBeInstanceOf(ProjectsApiError);
    expect((err as ProjectsApiError).message).toBe(
      "プロジェクト一覧を取得できませんでした。",
    );
  });

  it("handles a non-JSON error body gracefully", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("upstream", { status: 502 }),
    ) as typeof fetch;
    const err = await projectsApi.list().catch((e) => e);
    expect((err as ProjectsApiError).status).toBe(502);
    expect((err as ProjectsApiError).message).toBe(
      "プロジェクト一覧を取得できませんでした。",
    );
  });

  it("list() unwraps the {projects: [...]} envelope", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        projects: [
          {
            id: 1,
            name: "Demo",
            slug: "demo",
            description: null,
            instructions: "",
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    ) as typeof fetch;
    const list = await projectsApi.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Demo");
  });

  it("remove() ignores 204 empty bodies", async () => {
    globalThis.fetch = vi.fn(async () => emptyResponse(204)) as typeof fetch;
    await expect(projectsApi.remove(1)).resolves.toBeUndefined();
  });
});

describe("normalizeProjectsLimits", () => {
  it("maps the server limits payload onto the UI shape", () => {
    expect(
      normalizeProjectsLimits({
        limits: {
          fileMaxBytes: 5242880,
          maxFilesPerProject: 20,
          userTotalMaxBytes: 104857600,
          fileTextMaxChars: 100000,
          instructionsMaxChars: 4000,
          filesContextMaxChars: 8000,
          fileContextPerFileMaxChars: 4000,
        },
        usage: { totalBytes: 12, fileCount: 1 },
      }),
    ).toEqual({
      fileMaxBytes: 5242880,
      maxFiles: 20,
      userMaxTotalBytes: 104857600,
      fileTextMaxChars: 100000,
      instructionsMaxChars: 4000,
      filesContextMaxChars: 8000,
      perFileContextMaxChars: 4000,
      usage: { totalBytes: 12, fileCount: 1 },
    });
  });
});
