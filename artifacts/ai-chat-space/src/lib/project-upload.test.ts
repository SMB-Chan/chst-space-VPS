import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatBytes,
  planProjectUploads,
  summarizeUploadOutcomes,
  uploadFilesToProject,
  type UploadOutcome,
} from "./project-upload";

interface FakeFile {
  name: string;
  size: number;
}

const PLANNER_DEFAULT = {
  fileMaxBytes: 1024 * 1024,
  maxFiles: 10,
  existingCount: 0,
  userMaxTotalBytes: 10 * 1024 * 1024,
  usedBytes: 0,
};

describe("formatBytes", () => {
  it("uses B / KB / MB according to the bucket", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(900)).toBe("900B");
    expect(formatBytes(2048)).toBe("2KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5MB");
  });
});

describe("planProjectUploads", () => {
  it("rejects oversize files before checking slots or totals", () => {
    const { accepted, rejected } = planProjectUploads<FakeFile>(
      [{ name: "big.bin", size: 2 * 1024 * 1024 }],
      PLANNER_DEFAULT,
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { name: "big.bin", error: "1ファイル最大 1.0MB を超えています" },
    ]);
  });

  it("rejects empty files", () => {
    const { accepted, rejected } = planProjectUploads<FakeFile>(
      [{ name: "blank.txt", size: 0 }],
      PLANNER_DEFAULT,
    );
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([
      { name: "blank.txt", error: "空のファイルです" },
    ]);
  });

  it("rejects once existingCount + accepted exceeds maxFiles, with JP message", () => {
    const { accepted, rejected } = planProjectUploads<FakeFile>(
      [
        { name: "a.txt", size: 100 },
        { name: "b.txt", size: 100 },
        { name: "c.txt", size: 100 },
      ],
      { ...PLANNER_DEFAULT, maxFiles: 5, existingCount: 3 },
    );
    // Two slots left, so a and b fit; c is rejected.
    expect(accepted.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
    expect(rejected).toEqual([
      {
        name: "c.txt",
        error: "ファイル数の上限 (5件) に達しました",
      },
    ]);
  });

  it("rejects later files when running total would exceed user cap", () => {
    const { accepted, rejected } = planProjectUploads<FakeFile>(
      [
        { name: "a.bin", size: 6 * 1024 * 1024 },
        { name: "b.bin", size: 6 * 1024 * 1024 },
      ],
      {
        ...PLANNER_DEFAULT,
        fileMaxBytes: 16 * 1024 * 1024,
        userMaxTotalBytes: 8 * 1024 * 1024,
        usedBytes: 0,
      },
    );
    // a.bin (6MB) fits; b.bin would push the running total past 8MB.
    expect(accepted.map((f) => f.name)).toEqual(["a.bin"]);
    expect(rejected).toEqual([
      {
        name: "b.bin",
        error: "保存容量の上限 (8.0MB) を超えます",
      },
    ]);
  });

  it("treats negative usedBytes as zero so a bad server value cannot wedge the planner", () => {
    const { accepted, rejected } = planProjectUploads<FakeFile>(
      [{ name: "a.txt", size: 1000 }],
      { ...PLANNER_DEFAULT, usedBytes: -50, userMaxTotalBytes: 1500 },
    );
    expect(accepted.map((f) => f.name)).toEqual(["a.txt"]);
    expect(rejected).toEqual([]);
  });

  it("preserves the user's original order across mixed accepted / rejected", () => {
    const { accepted, rejected } = planProjectUploads<FakeFile>(
      [
        { name: "ok1.txt", size: 100 },
        { name: "too-big.txt", size: 5 * 1024 * 1024 },
        { name: "ok2.txt", size: 200 },
        { name: "blank.txt", size: 0 },
        { name: "ok3.txt", size: 300 },
      ],
      PLANNER_DEFAULT,
    );
    // accepted only ever receives files in input order; the caller is
    // responsible for re-combining against the input for display.
    expect(accepted.map((f) => f.name)).toEqual([
      "ok1.txt",
      "ok2.txt",
      "ok3.txt",
    ]);
    // rejected preserves the relative order of the rejects.
    expect(rejected.map((r) => r.name)).toEqual(["too-big.txt", "blank.txt"]);
  });
});

describe("summarizeUploadOutcomes", () => {
  it("formats an all-success outcome", () => {
    const outcomes: UploadOutcome[] = [
      { name: "a.txt", ok: true },
      { name: "b.txt", ok: true },
      { name: "c.txt", ok: true },
    ];
    expect(summarizeUploadOutcomes(outcomes)).toBe(
      "3件のファイルを追加しました。",
    );
  });

  it("formats a mixed batch with success + failure counts", () => {
    const outcomes: UploadOutcome[] = [
      { name: "a.txt", ok: true },
      { name: "b.txt", ok: true },
      { name: "c.txt", ok: false, error: "サイズ超過" },
    ];
    expect(summarizeUploadOutcomes(outcomes)).toBe(
      "2件追加、1件失敗しました。",
    );
  });

  it("reports zero successes as 'could not add anything'", () => {
    const outcomes: UploadOutcome[] = [
      { name: "a.txt", ok: false, error: "bad" },
    ];
    expect(summarizeUploadOutcomes(outcomes)).toBe("追加できませんでした。");
  });

  it("treats an empty outcome list as zero successes", () => {
    expect(summarizeUploadOutcomes([])).toBe("追加できませんでした。");
  });
});

describe("uploadFilesToProject", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function limits() {
    return {
      fileMaxBytes: 1024 * 1024,
      maxFiles: 5,
      userMaxTotalBytes: 10 * 1024 * 1024,
      instructionsMaxChars: 4000,
      filesContextMaxChars: 8000,
      perFileContextMaxChars: 4000,
      fileTextMaxChars: 100000,
      usage: { totalBytes: 0, fileCount: 0 },
    };
  }

  function fakeFile(name: string, size: number): File {
    // new File() with a known size for the planner is fine even with [].slice
    // because the planner only reads .name / .size.
    return new File([new Uint8Array(size)], name, {
      type: "application/octet-stream",
    });
  }

  it("returns rejected outcomes for files the planner cannot accept", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ file: { id: 1 } }));
    globalThis.fetch = fetchMock as typeof fetch;

    const outcomes = await uploadFilesToProject(
      42,
      [fakeFile("oversize.bin", 2 * 1024 * 1024), fakeFile("ok.txt", 100)],
      limits(),
      0,
    );

    // Order preserved: rejection first, success second (without error).
    expect(outcomes).toEqual([
      {
        name: "oversize.bin",
        ok: false,
        error: "1ファイル最大 1.0MB を超えています",
      },
      { name: "ok.txt", ok: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("captures per-file server errors and continues the batch", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        jsonResponse({ error: "大きすぎます" }, 413),
      )
      .mockImplementationOnce(async () => jsonResponse({ file: { id: 7 } }));
    globalThis.fetch = fetchMock as typeof fetch;

    const outcomes = await uploadFilesToProject(
      42,
      [fakeFile("a.txt", 100), fakeFile("b.txt", 200)],
      limits(),
      0,
    );

    expect(outcomes).toEqual([
      { name: "a.txt", ok: false, error: "大きすぎます" },
      { name: "b.txt", ok: true },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invokes onProgress with monotonically non-decreasing done counts", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ file: { id: 1 } }),
    ) as typeof fetch;
    const events: number[] = [];
    await uploadFilesToProject(
      42,
      [fakeFile("a.txt", 100), fakeFile("b.txt", 200)],
      limits(),
      0,
      (p) => events.push(p.done),
    );
    // The runner emits: start (0), before each file (current set), after each
    // file (done++), and a final event. Done count must never go backwards.
    for (let i = 1; i < events.length; i++) {
      expect(events[i]).toBeGreaterThanOrEqual(events[i - 1]);
    }
    // And we definitely get to fully-done.
    expect(events[events.length - 1]).toBe(2);
  });
});
