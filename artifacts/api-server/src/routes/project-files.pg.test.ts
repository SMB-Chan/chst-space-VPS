import express, {
  type Request as ExpressRequest,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Header-driven auth stub mirrors conversation-project.pg.test.ts.
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

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

const owner = `proj-files-owner:${randomUUID()}`;
const intruder = `proj-files-intruder:${randomUUID()}`;
let pool: (typeof import("@workspace/db"))["pool"];
let server: Server;
let base = "";

const ownerProjects: number[] = [];
const intruderProjects: number[] = [];
const fileIds: number[] = [];

async function call(
  method: string,
  path: string,
  user: string,
  body?: unknown,
): Promise<{ status: number; body: any; raw: string }> {
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
  return { status: res.status, body: parsed, raw };
}

const PLAIN_TEXT = Buffer.from("Hello\nWorld\n", "utf-8");
const PLAIN_B64 = PLAIN_TEXT.toString("base64");
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
]);

async function createProject(user: string, name: string): Promise<number> {
  const created = await call("POST", "/projects", user, { name });
  expect(created.status, `createProject ${user}`).toBe(201);
  const id = created.body.project?.id as number;
  expect(typeof id).toBe("number");
  return id;
}

describePostgres("project files (PostgreSQL)", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    const { default: router } = await import("./projects");
    const { default: openaiRouter } = await import("./openai");
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use(openaiRouter);
    app.use(router);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener");
    base = `http://127.0.0.1:${address.port}`;
    ownerProjects.push(await createProject(owner, "owner"));
    intruderProjects.push(await createProject(intruder, "intruder"));
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

  it("uploads, lists, downloads, toggles, and deletes a UTF-8 text file", async () => {
    const projectId = ownerProjects[0]!;
    const uploaded = await call("POST", `/projects/${projectId}/files`, owner, {
      filename: "notes.txt",
      dataBase64: PLAIN_B64,
    });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.file.mimeType).toBe("text/plain; charset=utf-8");
    expect(uploaded.body.file.sizeBytes).toBe(PLAIN_TEXT.length);
    expect(uploaded.body.file.textChars).toBe(PLAIN_TEXT.length);
    fileIds.push(uploaded.body.file.id);

    const list = await call("GET", `/projects/${projectId}/files`, owner);
    expect(list.status).toBe(200);
    expect(list.body.files).toHaveLength(1);
    expect(list.body.files[0].id).toBe(uploaded.body.file.id);
    expect(list.body.files[0]).not.toHaveProperty("data");

    const download = await fetch(
      `${base}/projects/${projectId}/files/${uploaded.body.file.id}/download`,
      { headers: { "x-test-user": owner } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(download.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await download.arrayBuffer()).toString("utf-8")).toBe(
      PLAIN_TEXT.toString("utf-8"),
    );

    const patch = await call(
      "PATCH",
      `/projects/${projectId}/files/${uploaded.body.file.id}`,
      owner,
      { includeInContext: false },
    );
    expect(patch.status).toBe(200);
    expect(patch.body.file.includeInContext).toBe(false);

    const remove = await call(
      "DELETE",
      `/projects/${projectId}/files/${uploaded.body.file.id}`,
      owner,
    );
    expect(remove.status).toBe(204);
  });

  it("rejects invalid base64 payloads with 400", async () => {
    const projectId = ownerProjects[0]!;
    const bad = await call("POST", `/projects/${projectId}/files`, owner, {
      filename: "x.txt",
      dataBase64: "!!!not base64!!!",
    });
    expect(bad.status).toBe(400);
  });

  it("returns 415 for PNG (image) content", async () => {
    const projectId = ownerProjects[0]!;
    const png = await call("POST", `/projects/${projectId}/files`, owner, {
      filename: "image.png",
      dataBase64: PNG_BYTES.toString("base64"),
    });
    expect(png.status).toBe(415);
  });

  it("returns 415 for invalid UTF-8", async () => {
    const projectId = ownerProjects[0]!;
    const invalid = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x01]);
    const result = await call("POST", `/projects/${projectId}/files`, owner, {
      filename: "binary.bin",
      dataBase64: invalid.toString("base64"),
    });
    expect(result.status).toBe(415);
  });

  it("returns 400 for empty uploads", async () => {
    const projectId = ownerProjects[0]!;
    const empty = await call("POST", `/projects/${projectId}/files`, owner, {
      filename: "x.txt",
      dataBase64: "",
    });
    // Empty dataBase64 fails the zod min(1) check first.
    expect([400, 413]).toContain(empty.status);
  });

  it("blocks another user from reading or writing the owner's files", async () => {
    const ownerId = ownerProjects[0]!;
    const upload = await call("POST", `/projects/${ownerId}/files`, owner, {
      filename: "secret.txt",
      dataBase64: PLAIN_B64,
    });
    expect(upload.status).toBe(201);
    const fileId = upload.body.file.id;
    fileIds.push(fileId);

    const listIntruder = await call(
      "GET",
      `/projects/${ownerId}/files`,
      intruder,
    );
    expect(listIntruder.status).toBe(404);

    const uploadIntruder = await call(
      "POST",
      `/projects/${ownerId}/files`,
      intruder,
      { filename: "intruder.txt", dataBase64: PLAIN_B64 },
    );
    expect(uploadIntruder.status).toBe(404);

    const patchIntruder = await call(
      "PATCH",
      `/projects/${ownerId}/files/${fileId}`,
      intruder,
      { includeInContext: false },
    );
    expect(patchIntruder.status).toBe(404);

    const deleteIntruder = await call(
      "DELETE",
      `/projects/${ownerId}/files/${fileId}`,
      intruder,
    );
    expect(deleteIntruder.status).toBe(404);

    const downloadIntruder = await fetch(
      `${base}/projects/${ownerId}/files/${fileId}/download`,
      { headers: { "x-test-user": intruder } },
    );
    expect(downloadIntruder.status).toBe(404);
  });

  it("returns 400 for invalid project ids", async () => {
    const bad = await call("GET", `/projects/abc/files`, owner);
    expect(bad.status).toBe(400);
    const badPatch = await call(
      "PATCH",
      `/projects/${ownerProjects[0]}/files/0`,
      owner,
      { includeInContext: false },
    );
    expect(badPatch.status).toBe(400);
  });

  it("deletes a project and cascades files + nulls conversations.project_id", async () => {
    const projectId = ownerProjects[0]!;
    // Upload a file first
    const uploaded = await call("POST", `/projects/${projectId}/files`, owner, {
      filename: "to-cascade.txt",
      dataBase64: PLAIN_B64,
    });
    expect(uploaded.status).toBe(201);

    // Create a conversation in the project
    const conv = await fetch(`${base}/openai/conversations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-user": owner },
      body: JSON.stringify({ title: "linked", projectId }),
    });
    expect(conv.status).toBe(201);
    const convBody = (await conv.json()) as { id: number; projectId: number };
    expect(convBody.projectId).toBe(projectId);

    const del = await call("DELETE", `/projects/${projectId}`, owner);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    // After deletion, the conversation's projectId should be null.
    const row = await pool.query(
      "SELECT project_id FROM conversations WHERE id = $1",
      [convBody.id],
    );
    expect(row.rows[0]?.project_id).toBeNull();

    // Files for the deleted project should be gone (cascade via FK).
    const files = await pool.query(
      "SELECT id FROM project_files WHERE project_id = $1",
      [projectId],
    );
    expect(files.rows.length).toBe(0);
  });
});
