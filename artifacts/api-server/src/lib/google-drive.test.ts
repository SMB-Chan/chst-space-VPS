import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./google-auth", () => ({
  getValidAccessToken: vi.fn(async () => "test-access-token"),
  isGoogleOAuthConfigured: () => true,
}));

import {
  DriveError,
  fetchDriveFileText,
  searchDriveFiles,
  type DriveFileInfo,
} from "./google-drive";
import {
  escapeDriveQueryLiteral,
  parseDriveFileId,
} from "./google-drive-utils";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const DOC: DriveFileInfo = {
  id: "1AbcDEFghijKLmnOP",
  name: "仕様書",
  mimeType: "application/vnd.google-apps.document",
  sizeBytes: null,
  modifiedTime: "2026-10-09T00:00:00.000Z",
  webViewLink: "https://docs.google.com/document/d/1AbcDEFghijKLmnOP/edit",
};

describe("google-drive-utils", () => {
  it("escapes backslashes before quotes in Drive query literals", () => {
    expect(escapeDriveQueryLiteral("a'b")).toBe("a\\'b");
    expect(escapeDriveQueryLiteral("a\\' or name contains '")).toBe(
      "a\\\\\\' or name contains \\'",
    );
  });

  it("parses bare ids and Drive/Docs share URLs", () => {
    expect(parseDriveFileId("1AbcDEFghijKLmnOP")).toBe("1AbcDEFghijKLmnOP");
    expect(
      parseDriveFileId(
        "https://docs.google.com/spreadsheets/d/1AbcDEFghijKLmnOP/edit#gid=0",
      ),
    ).toBe("1AbcDEFghijKLmnOP");
    expect(
      parseDriveFileId(
        "https://drive.google.com/file/d/1AbcDEFghijKLmnOP/view?usp=sharing",
      ),
    ).toBe("1AbcDEFghijKLmnOP");
    expect(
      parseDriveFileId("https://drive.google.com/open?id=1AbcDEFghijKLmnOP"),
    ).toBe("1AbcDEFghijKLmnOP");
    expect(parseDriveFileId("../../etc/passwd")).toBeNull();
    expect(parseDriveFileId("short")).toBeNull();
  });
});

describe("fetchDriveFileText", () => {
  it("exports Google Docs as text and extracts it", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("見出し\n本文です。", { status: 200 }),
    );
    const out = await fetchDriveFileText("u1", DOC.id, { info: DOC });
    expect(out.extractedText).toBe("見出し\n本文です。");
    expect(out.textChars).toBe("見出し\n本文です。".length);
    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain(`/files/${DOC.id}/export?mimeType=text%2Fplain`);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer test-access-token",
    );
  });

  it("downloads binary files with alt=media", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("a,b\n1,2\n", { status: 200 }),
    );
    const out = await fetchDriveFileText("u1", "1CsvFileIdXYZ", {
      info: {
        ...DOC,
        id: "1CsvFileIdXYZ",
        name: "data.csv",
        mimeType: "text/csv",
        sizeBytes: 8,
      },
    });
    expect(out.extractedText).toBe("a,b\n1,2\n");
    expect(String(fetchMock.mock.calls[0]![0])).toContain("alt=media");
  });

  it("rejects files above the Drive size cap without downloading", async () => {
    await expect(
      fetchDriveFileText("u1", "1BigFileIdXYZ", {
        info: {
          ...DOC,
          id: "1BigFileIdXYZ",
          mimeType: "application/pdf",
          sizeBytes: 500 * 1024 * 1024,
        },
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops streaming when the body exceeds the cap", async () => {
    vi.stubEnv("GOOGLE_DRIVE_FILE_MAX_BYTES", "2048");
    fetchMock.mockResolvedValueOnce(
      new Response("x".repeat(4096), { status: 200 }),
    );
    await expect(
      fetchDriveFileText("u1", "1TxtFileIdXYZ", {
        info: {
          ...DOC,
          id: "1TxtFileIdXYZ",
          mimeType: "text/plain",
          sizeBytes: null,
        },
      }),
    ).rejects.toBeInstanceOf(DriveError);
    vi.unstubAllEnvs();
  });

  it("maps a Drive 404 to not_found", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    await expect(
      fetchDriveFileText("u1", DOC.id, { info: DOC }),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("rejects unsupported Google-native types (forms, drawings)", async () => {
    await expect(
      fetchDriveFileText("u1", DOC.id, {
        info: { ...DOC, mimeType: "application/vnd.google-apps.form" },
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("searchDriveFiles", () => {
  it("excludes folders/trash, escapes the query, and omits orderBy for text search", async () => {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        files: [{ id: DOC.id, name: "仕様書", mimeType: DOC.mimeType }],
      }),
    );
    const files = await searchDriveFiles("u1", "it's");
    expect(files).toHaveLength(1);
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    const q = url.searchParams.get("q")!;
    expect(q).toContain("trashed = false");
    expect(q).toContain("mimeType != 'application/vnd.google-apps.folder'");
    expect(q).toContain("name contains 'it\\'s'");
    expect(url.searchParams.get("orderBy")).toBeNull();
  });

  it("lists recent files when the query is empty", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ files: [] }));
    await searchDriveFiles("u1", "");
    const url = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(url.searchParams.get("orderBy")).toBe("modifiedTime desc");
  });
});
