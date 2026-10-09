import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectsApiError,
  base64ToString,
  hasPendingDescriptions,
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

describe("image-aware project files", () => {
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

  it("listFilesWithMeta unwraps the files array and exposes imageDescriptionAvailable=true", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        files: [
          {
            id: 1,
            filename: "a.png",
            mimeType: "image/png",
            sizeBytes: 1234,
            textChars: 12,
            includeInContext: true,
            createdAt: "2026-01-01T00:00:00Z",
            kind: "image",
            hasThumbnail: true,
            imageWidth: 800,
            imageHeight: 600,
            sendImage: false,
            descriptionStatus: "ready",
            descriptionModel: "gpt-4o-mini",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        imageDescription: { available: true },
      }),
    ) as typeof fetch;
    const meta = await projectsApi.listFilesWithMeta(7);
    expect(meta.imageDescriptionAvailable).toBe(true);
    expect(meta.files).toHaveLength(1);
    expect(meta.files[0].kind).toBe("image");
  });

  it("listFilesWithMeta defaults imageDescriptionAvailable to true when the server omits it", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        files: [],
        // no imageDescription key (older server)
      }),
    ) as typeof fetch;
    const meta = await projectsApi.listFilesWithMeta(1);
    expect(meta.imageDescriptionAvailable).toBe(true);
    expect(meta.files).toEqual([]);
  });

  it("listFilesWithMeta honours imageDescription.available=false", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        files: [],
        imageDescription: { available: false },
      }),
    ) as typeof fetch;
    const meta = await projectsApi.listFilesWithMeta(1);
    expect(meta.imageDescriptionAvailable).toBe(false);
  });

  it("setFileSendImage sends PATCH {sendImage:true} and unwraps the file", async () => {
    const updated = {
      id: 3,
      filename: "photo.jpg",
      mimeType: "image/jpeg",
      sizeBytes: 1,
      textChars: 0,
      includeInContext: true,
      createdAt: "2026-01-01T00:00:00Z",
      kind: "image" as const,
      hasThumbnail: true,
      imageWidth: 100,
      imageHeight: 100,
      sendImage: true,
      descriptionStatus: "ready" as const,
      descriptionModel: "gpt-4o-mini",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        jsonResponse({ file: updated }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await projectsApi.setFileSendImage(5, 3, true);
    expect(result.sendImage).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, initArg] = fetchMock.mock.calls[0]!;
    expect(initArg?.method).toBe("PATCH");
    expect(JSON.parse(String(initArg?.body))).toEqual({ sendImage: true });
  });

  it("describeFile POSTs to the describe endpoint and unwraps the file", async () => {
    const updated = {
      id: 9,
      filename: "scan.png",
      mimeType: "image/png",
      sizeBytes: 9,
      textChars: 0,
      includeInContext: true,
      createdAt: "2026-01-01T00:00:00Z",
      kind: "image" as const,
      hasThumbnail: true,
      imageWidth: 1,
      imageHeight: 1,
      sendImage: false,
      descriptionStatus: "pending" as const,
      descriptionModel: null,
      updatedAt: "2026-01-01T00:00:00Z",
    };
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        jsonResponse({ file: updated }, 202),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await projectsApi.describeFile(2, 9);
    expect(result.descriptionStatus).toBe("pending");
    const [urlArg, initArg] = fetchMock.mock.calls[0]!;
    expect(String(urlArg)).toContain("/api/projects/2/files/9/describe");
    expect(initArg?.method).toBe("POST");
  });

  it("fileThumbnailUrl mirrors fileDownloadUrl with a /thumbnail suffix", () => {
    expect(projectsApi.fileThumbnailUrl(12, 34)).toBe(
      projectsApi.fileDownloadUrl(12, 34).replace(/\/download$/, "/thumbnail"),
    );
  });
});

describe("hasPendingDescriptions", () => {
  it("returns false for null / empty lists", () => {
    expect(hasPendingDescriptions(null)).toBe(false);
    expect(hasPendingDescriptions([])).toBe(false);
  });

  it("returns false when there are no images at all", () => {
    expect(
      hasPendingDescriptions([
        {
          id: 1,
          filename: "doc.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
          textChars: 10,
          includeInContext: true,
          createdAt: "2026-01-01T00:00:00Z",
        },
      ]),
    ).toBe(false);
  });

  it("returns false when images are all ready", () => {
    expect(
      hasPendingDescriptions([
        {
          id: 1,
          filename: "a.png",
          mimeType: "image/png",
          sizeBytes: 1,
          textChars: 0,
          includeInContext: true,
          createdAt: "2026-01-01T00:00:00Z",
          kind: "image",
          descriptionStatus: "ready",
        },
      ]),
    ).toBe(false);
  });

  it("returns true when at least one image is pending", () => {
    expect(
      hasPendingDescriptions([
        {
          id: 1,
          filename: "a.png",
          mimeType: "image/png",
          sizeBytes: 1,
          textChars: 0,
          includeInContext: true,
          createdAt: "2026-01-01T00:00:00Z",
          kind: "image",
          descriptionStatus: "ready",
        },
        {
          id: 2,
          filename: "b.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1,
          textChars: 0,
          includeInContext: true,
          createdAt: "2026-01-01T00:00:00Z",
          kind: "image",
          descriptionStatus: "pending",
        },
      ]),
    ).toBe(true);
  });

  it("ignores document entries even when their descriptionStatus is pending (defensive)", () => {
    expect(
      hasPendingDescriptions([
        {
          id: 1,
          filename: "doc.pdf",
          mimeType: "application/pdf",
          sizeBytes: 1,
          textChars: 10,
          includeInContext: true,
          createdAt: "2026-01-01T00:00:00Z",
          // @ts-expect-error documents shouldn't have descriptionStatus, but if
          // a server bug ever returns one we should still treat it as not-pending.
          descriptionStatus: "pending",
        },
      ]),
    ).toBe(false);
  });
});
