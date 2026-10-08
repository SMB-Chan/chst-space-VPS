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

// Tight limits so count/size/quota paths are exercised cheaply. Read at
// import time by project-limits.ts, which is imported lazily in beforeAll.
process.env.PROJECT_MAX_FILES = "2";
process.env.PROJECT_FILE_MAX_BYTES = "2048";
process.env.PROJECT_USER_MAX_TOTAL_BYTES = "4096";

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

const owner = `proj-limits-owner:${randomUUID()}`;
const racer = `proj-limits-racer:${randomUUID()}`;
const intruder = `proj-limits-intruder:${randomUUID()}`;
let pool: (typeof import("@workspace/db"))["pool"];
let server: Server;
let base = "";

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

function textB64(bytes: number, fill = "a"): string {
  return Buffer.from(fill.repeat(bytes), "utf-8").toString("base64");
}

async function createProject(user: string, name: string): Promise<number> {
  const created = await call("POST", "/projects", user, { name });
  expect(created.status).toBe(201);
  return created.body.project.id as number;
}

describePostgres("project file limits and ownership (PostgreSQL)", () => {
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
  });

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (pool) {
      await pool.query("DELETE FROM conversations WHERE user_id = ANY($1)", [
        [owner, racer, intruder],
      ]);
      await pool.query("DELETE FROM projects WHERE user_id = ANY($1)", [
        [owner, racer, intruder],
      ]);
    }
  });

  it("enforces per-file size, per-project count and per-user quota", async () => {
    const a = await createProject(owner, "limits-a");
    const b = await createProject(owner, "limits-b");

    const tooBig = await call("POST", `/projects/${a}/files`, owner, {
      filename: "big.txt",
      dataBase64: textB64(2049),
    });
    expect(tooBig.status).toBe(413);

    for (const name of ["1.txt", "2.txt"]) {
      const ok = await call("POST", `/projects/${a}/files`, owner, {
        filename: name,
        dataBase64: textB64(1500),
      });
      expect(ok.status).toBe(201);
    }
    const third = await call("POST", `/projects/${a}/files`, owner, {
      filename: "3.txt",
      dataBase64: textB64(10),
    });
    expect(third.status).toBe(409);
    expect(third.body.code).toBe("too_many_files");

    // 3000 bytes used; another 1500 in a different project exceeds 4096.
    const overQuota = await call("POST", `/projects/${b}/files`, owner, {
      filename: "q.txt",
      dataBase64: textB64(1500),
    });
    expect(overQuota.status).toBe(409);
    expect(overQuota.body.code).toBe("quota_exceeded");

    const limits = await call("GET", "/projects/limits", owner);
    expect(limits.status).toBe(200);
    expect(limits.body.usage).toEqual({ totalBytes: 3000, fileCount: 2 });
  });

  it("serialises concurrent uploads across projects against the user quota", async () => {
    const projects = await Promise.all(
      ["r1", "r2", "r3"].map((name) => createProject(racer, name)),
    );
    const results = await Promise.all(
      projects.map((id, i) =>
        call("POST", `/projects/${id}/files`, racer, {
          filename: `r${i}.txt`,
          dataBase64: textB64(1500),
        }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 409]);
  });

  it("does not duplicate project memory when the chat path excludes it", async () => {
    const id = await createProject(owner, "memory-dedupe");
    await call("PATCH", `/projects/${id}`, owner, {
      instructions: "常に敬語で答える",
    });
    const mem = await call("PUT", `/projects/${id}/memory/notes`, owner, {
      content: "memory-marker-xyz",
    });
    expect(mem.status).toBe(200);
    const { loadProjectContext } = await import("../lib/project-context");
    const full = await loadProjectContext(owner, id);
    expect(full).toContain("memory-marker-xyz");
    const chatOnly = await loadProjectContext(owner, id, undefined, {
      includeMemory: false,
    });
    expect(chatOnly).toContain("常に敬語で答える");
    expect(chatOnly).not.toContain("memory-marker-xyz");
    // Another user's id resolves to nothing.
    expect(await loadProjectContext(intruder, id)).toBeNull();
  });

  it("keeps project conversations private to the owner", async () => {
    const id = await createProject(owner, "conv-owner");
    const conv = await call("POST", "/openai/conversations", owner, {
      title: "in project",
      projectId: id,
    });
    expect(conv.status).toBe(201);
    expect(conv.body.projectId).toBe(id);

    const listed = await call("GET", `/projects/${id}/conversations`, owner);
    expect(listed.status).toBe(200);
    expect(listed.body.conversations.map((c: any) => c.id)).toContain(
      conv.body.id,
    );

    expect(
      (await call("GET", `/projects/${id}/conversations`, intruder)).status,
    ).toBe(404);
    expect(
      (
        await call(
          "DELETE",
          `/projects/${id}/conversations/${conv.body.id}`,
          intruder,
        )
      ).status,
    ).toBe(404);
    const intruderProject = await createProject(intruder, "steal");
    expect(
      (
        await call(
          "PUT",
          `/projects/${intruderProject}/conversations/${conv.body.id}`,
          intruder,
        )
      ).status,
    ).toBe(404);

    const unassigned = await call(
      "DELETE",
      `/projects/${id}/conversations/${conv.body.id}`,
      owner,
    );
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.conversation.projectId).toBeNull();
  });
});
