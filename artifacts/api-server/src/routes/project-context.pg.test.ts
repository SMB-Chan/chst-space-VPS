import express, {
  type Request as ExpressRequest,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

const userId = `proj-context-${randomUUID()}`;
const intruderId = `proj-intruder-${randomUUID()}`;
let pool: (typeof import("@workspace/db"))["pool"];
let server: Server;
let base = "";

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

describePostgres(
  "project instructions, conversations, and context loader",
  () => {
    beforeAll(async () => {
      ({ pool } = await import("@workspace/db"));
      const { default: projectsRouter } = await import("./projects");
      const app = express();
      app.use(express.json({ limit: "10mb" }));
      app.use(projectsRouter);
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
        await pool.query("DELETE FROM projects WHERE user_id = ANY($1)", [
          [userId, intruderId],
        ]);
      }
    });

    it("accepts, persists, and returns instructions on GET", async () => {
      const created = await call("POST", "/projects", userId, {
        name: "context-test",
        instructions: "always respond in Japanese",
      });
      expect(created.status).toBe(201);
      const id = created.body.project.id as number;
      expect(created.body.project.instructions).toBe(
        "always respond in Japanese",
      );

      const got = await call("GET", `/projects/${id}`, userId);
      expect(got.status).toBe(200);
      expect(got.body.project.instructions).toBe("always respond in Japanese");

      // Update instructions
      const patched = await call("PATCH", `/projects/${id}`, userId, {
        instructions: "always respond in English",
      });
      expect(patched.status).toBe(200);
      expect(patched.body.project.instructions).toBe(
        "always respond in English",
      );

      // Persisted to DB
      const row = await pool.query(
        "SELECT instructions FROM projects WHERE id = $1",
        [id],
      );
      expect(row.rows[0].instructions).toBe("always respond in English");

      await pool.query("DELETE FROM projects WHERE id = $1", [id]);
    });

    it("rejects instructions that exceed the character cap (400)", async () => {
      const created = await call("POST", "/projects", userId, {
        name: "context-cap",
      });
      expect(created.status).toBe(201);
      const id = created.body.project.id as number;

      const tooLong = "x".repeat(4001);
      const failed = await call("PATCH", `/projects/${id}`, userId, {
        instructions: tooLong,
      });
      expect(failed.status).toBe(400);

      await pool.query("DELETE FROM projects WHERE id = $1", [id]);
    });

    it("loads instructions + files into loadProjectContext", async () => {
      const created = await call("POST", "/projects", userId, {
        name: "with-instructions-and-files",
        instructions: "answer in bullet points",
      });
      expect(created.status).toBe(201);
      const id = created.body.project.id as number;

      const txt = Buffer.from("alpha beta gamma", "utf-8");
      const uploaded = await call("POST", `/projects/${id}/files`, userId, {
        filename: "facts.txt",
        dataBase64: txt.toString("base64"),
      });
      expect(uploaded.status).toBe(201);

      const { loadProjectContext } = await import("../lib/project-context");
      const ctx = await loadProjectContext(userId, id);
      expect(ctx).not.toBeNull();
      expect(ctx).toContain("<project_instructions>");
      expect(ctx).toContain("answer in bullet points");
      expect(ctx).toContain("<untrusted_project_files>");
      expect(ctx).toContain("alpha beta gamma");

      // Toggle file off; loader no longer includes its body.
      await call(
        "PATCH",
        `/projects/${id}/files/${uploaded.body.file.id}`,
        userId,
        {
          includeInContext: false,
        },
      );
      const ctxOff = await loadProjectContext(userId, id);
      expect(ctxOff).not.toBeNull();
      expect(ctxOff).not.toContain("alpha beta gamma");

      await pool.query("DELETE FROM projects WHERE id = $1", [id]);
    });

    it("refuses to assign an unowned conversation (404)", async () => {
      const my = await call("POST", "/projects", userId, {
        name: "assign-test",
      });
      expect(my.status).toBe(201);
      const myId = my.body.project.id as number;

      // Use openai router to create conversations (need different test mount),
      // but we can verify assign via direct DB rows + the assign endpoint:
      const convInsert = await pool.query<{ id: number }>(
        "INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id",
        [userId, "my-conv"],
      );
      const myConvoId = convInsert.rows[0]!.id;

      const intruderConvo = await pool.query<{ id: number }>(
        "INSERT INTO conversations (user_id, title) VALUES ($1, $2) RETURNING id",
        [intruderId, "intruder-conv"],
      );
      const intruderConvoId = intruderConvo.rows[0]!.id;

      // Assign the user's own conversation: should succeed.
      const ownAssign = await call(
        "PUT",
        `/projects/${myId}/conversations/${myConvoId}`,
        userId,
      );
      expect(ownAssign.status).toBe(200);

      // Attempt to assign an intruder-owned conversation: should 404.
      const badAssign = await call(
        "PUT",
        `/projects/${myId}/conversations/${intruderConvoId}`,
        userId,
      );
      expect(badAssign.status).toBe(404);

      // List conversations in the project: only the user's own.
      const list = await call("GET", `/projects/${myId}/conversations`, userId);
      expect(list.status).toBe(200);
      expect(list.body.conversations).toHaveLength(1);
      expect(list.body.conversations[0].id).toBe(myConvoId);

      // Unassign via DELETE
      const unassign = await call(
        "DELETE",
        `/projects/${myId}/conversations/${myConvoId}`,
        userId,
      );
      expect(unassign.status).toBe(200);

      await pool.query("DELETE FROM conversations WHERE id = ANY($1)", [
        [myConvoId, intruderConvoId],
      ]);
      await pool.query("DELETE FROM projects WHERE id = $1", [myId]);
    });

    it("exposes limits + usage", async () => {
      const limits = await call("GET", "/projects/limits", userId);
      expect(limits.status).toBe(200);
      expect(limits.body.limits.fileMaxBytes).toBe(20 * 1024 * 1024);
      expect(limits.body.limits.maxFilesPerProject).toBe(50);
      expect(limits.body.limits.userTotalMaxBytes).toBe(500 * 1024 * 1024);
      expect(limits.body.limits.instructionsMaxChars).toBe(4000);
      expect(limits.body.usage).toEqual(
        expect.objectContaining({
          totalBytes: expect.any(Number),
          fileCount: expect.any(Number),
        }),
      );
    });
  },
);
