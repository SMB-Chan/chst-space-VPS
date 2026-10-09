import express, {
  type Request as ExpressRequest,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Header-driven auth stub mirrors project-files.pg.test.ts.
vi.mock("../middlewares/requireAuth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../middlewares/requireAuth")>();
  return {
    ...actual,
    requireAuth: (
      req: ExpressRequest,
      res: Response,
      next: NextFunction,
    ): void => {
      const user = req.header("x-test-user");
      if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      req.userId = user;
      req.userRole = "user";
      actual.requestUserContext.run({ userId: user, userRole: "user" }, () =>
        next(),
      );
    },
  };
});

process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??= "http://127.0.0.1:9/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??= "test-key";

// Drive network calls are mocked; isDriveIntegrationConfigured stays real
// (it reads GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET at call time).
const driveMocks = vi.hoisted(() => ({
  fetchDriveFileText: vi.fn(),
  getDriveFileInfo: vi.fn(),
  searchDriveFiles: vi.fn(),
}));
vi.mock("../lib/google-drive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/google-drive")>();
  return { ...actual, ...driveMocks };
});

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

const owner = `proj-drive-owner:${randomUUID()}`;
const intruder = `proj-drive-intruder:${randomUUID()}`;
let pool: (typeof import("@workspace/db"))["pool"];
let server: Server;
let base = "";
let projectId = 0;

async function call(
  method: string,
  path: string,
  user: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await res.text();
  let parsed: any = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  return { status: res.status, body: parsed };
}

const FILE_ID = "1AbcDEFghijKLmnOPq";
const INFO = {
  id: FILE_ID,
  name: "仕様書",
  mimeType: "application/vnd.google-apps.document",
  sizeBytes: null,
  modifiedTime: "2026-10-09T00:00:00.000Z",
  webViewLink: `https://docs.google.com/document/d/${FILE_ID}/edit`,
};

describePostgres("project Google Drive references (PostgreSQL)", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    const { default: projectsRouter } = await import("./projects");
    const { default: driveRouter } = await import("./project-drive");
    const app = express();
    app.use(express.json());
    app.use(projectsRouter);
    app.use(driveRouter);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener");
    base = `http://127.0.0.1:${address.port}`;
    const created = await call("POST", "/projects", owner, { name: "drive" });
    expect(created.status).toBe(201);
    projectId = created.body.project.id;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (pool) {
      await pool.query("DELETE FROM projects WHERE user_id = ANY($1)", [
        [owner, intruder],
      ]);
    }
  });

  it("is inert without Google OAuth credentials", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const status = await call("GET", "/project-drive/status", owner);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ configured: false, connected: false });
    const search = await call("GET", "/project-drive/search?q=x", owner);
    expect(search.status).toBe(404);
    expect(search.body.code).toBe("not_configured");
    const add = await call(
      "POST",
      `/projects/${projectId}/drive-files`,
      owner,
      {
        fileId: FILE_ID,
      },
    );
    expect(add.status).toBe(404);
    expect(add.body.code).toBe("not_configured");
    const list = await call("GET", `/projects/${projectId}/drive-files`, owner);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ files: [], configured: false });
    expect(driveMocks.fetchDriveFileText).not.toHaveBeenCalled();
  });

  it("adds, injects into context, toggles, refreshes and deletes a reference", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "test-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "test-secret");
    driveMocks.fetchDriveFileText.mockResolvedValue({
      info: INFO,
      extractedText: "仕様本文",
      textChars: 4,
    });

    const status = await call("GET", "/project-drive/status", owner);
    expect(status.body).toMatchObject({ configured: true, connected: false });

    const add = await call(
      "POST",
      `/projects/${projectId}/drive-files`,
      owner,
      {
        fileId: INFO.webViewLink,
      },
    );
    expect(add.status).toBe(201);
    expect(add.body.file).toMatchObject({
      driveFileId: FILE_ID,
      name: "仕様書",
      textChars: 4,
      includeInContext: true,
      fetchError: null,
    });
    expect(add.body.file).not.toHaveProperty("extractedText");
    const refId = add.body.file.id as number;

    const dup = await call(
      "POST",
      `/projects/${projectId}/drive-files`,
      owner,
      {
        fileId: FILE_ID,
      },
    );
    expect(dup.status).toBe(422);

    const { loadProjectContext } = await import("../lib/project-context");
    const ctx = await loadProjectContext(owner, projectId);
    expect(ctx).toContain("Googleドライブ: 仕様書");
    expect(ctx).toContain("仕様本文");

    const intruderList = await call(
      "GET",
      `/projects/${projectId}/drive-files`,
      intruder,
    );
    expect(intruderList.status).toBe(404);
    const intruderDelete = await call(
      "DELETE",
      `/projects/${projectId}/drive-files/${refId}`,
      intruder,
    );
    expect(intruderDelete.status).toBe(404);

    const off = await call(
      "PATCH",
      `/projects/${projectId}/drive-files/${refId}`,
      owner,
      { includeInContext: false },
    );
    expect(off.status).toBe(200);
    expect(off.body.file.includeInContext).toBe(false);
    const ctxOff = await loadProjectContext(owner, projectId);
    expect(ctxOff ?? "").not.toContain("仕様本文");

    // Forced refresh re-extracts; a failure keeps the old text and records
    // the (Japanese) error on the row.
    driveMocks.getDriveFileInfo.mockResolvedValue({
      ...INFO,
      modifiedTime: "2026-10-10T00:00:00.000Z",
    });
    driveMocks.fetchDriveFileText.mockResolvedValueOnce({
      info: INFO,
      extractedText: "更新後の本文",
      textChars: 6,
    });
    const refreshed = await call(
      "POST",
      `/projects/${projectId}/drive-files/${refId}/refresh`,
      owner,
    );
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.file.textChars).toBe(6);
    expect(refreshed.body.file.driveModifiedTime).toBe(
      "2026-10-10T00:00:00.000Z",
    );

    const { DriveError } = await import("../lib/google-drive");
    driveMocks.getDriveFileInfo.mockRejectedValueOnce(
      new DriveError("not_found", "見つかりません"),
    );
    const failed = await call(
      "POST",
      `/projects/${projectId}/drive-files/${refId}/refresh`,
      owner,
    );
    expect(failed.status).toBe(404);
    const list = await call("GET", `/projects/${projectId}/drive-files`, owner);
    expect(list.body.files[0]).toMatchObject({
      fetchError: "見つかりません",
      textChars: 6,
    });

    const removed = await call(
      "DELETE",
      `/projects/${projectId}/drive-files/${refId}`,
      owner,
    );
    expect(removed.status).toBe(204);
    const empty = await call(
      "GET",
      `/projects/${projectId}/drive-files`,
      owner,
    );
    expect(empty.body.files).toEqual([]);
  });
});
