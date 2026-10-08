import express, {
  type Request as ExpressRequest,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The user id comes from a test header; the role is always "user".
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
const owner = `conv-project-owner:${randomUUID()}`;
const intruder = `conv-project-intruder:${randomUUID()}`;
let pool: (typeof import("@workspace/db"))["pool"];
let server: Server;
let base = "";
let ownersProject = 0;
const conversationIds: number[] = [];

async function call(
  method: string,
  path: string,
  user: string,
  body?: unknown,
): Promise<{
  status: number;
  body: { id?: number; projectId?: number | null };
}> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-test-user": user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

describePostgres("conversation project binding", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    const { default: router } = await import("./openai");
    const app = express();
    app.use(express.json());
    app.use(router);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing listener");
    base = `http://127.0.0.1:${address.port}`;
    const created = await pool.query<{ id: number }>(
      "INSERT INTO projects (user_id, name, slug) VALUES ($1, $2, $3) RETURNING id",
      [owner, "owner-project", `conv-project-${randomUUID()}`],
    );
    ownersProject = created.rows[0]!.id;
  });

  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (pool) {
      await pool.query("DELETE FROM conversations WHERE user_id = ANY($1)", [
        [owner, intruder],
      ]);
      await pool.query("DELETE FROM projects WHERE id = $1", [ownersProject]);
    }
  });

  it("refuses to attach a conversation to another user's project", async () => {
    const createForeign = await call(
      "POST",
      "/openai/conversations",
      intruder,
      {
        title: "x",
        projectId: ownersProject,
      },
    );
    expect(createForeign.status).toBe(400);

    const own = await call("POST", "/openai/conversations", intruder, {
      title: "mine",
    });
    expect(own.status).toBe(201);
    conversationIds.push(own.body.id!);

    const patch = await call(
      "PATCH",
      `/openai/conversations/${own.body.id}`,
      intruder,
      { title: "mine", projectId: ownersProject },
    );
    expect(patch.status).toBe(400);
    const row = await pool.query(
      "SELECT project_id FROM conversations WHERE id = $1",
      [own.body.id],
    );
    expect(row.rows[0]?.project_id).toBeNull();
  });

  it("still lets the owner attach their own project", async () => {
    const created = await call("POST", "/openai/conversations", owner, {
      title: "ok",
      projectId: ownersProject,
    });
    expect(created.status).toBe(201);
    expect(created.body.projectId).toBe(ownersProject);
  });
});
