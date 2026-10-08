import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express, {
  type Request as ExpressRequest,
  type Response,
  type NextFunction,
} from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Same header-driven auth stub as admin-authz.test.ts.
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
      const role = req.header("x-test-role");
      if (!role) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }
      req.userId = "test-user";
      req.userRole = role === "admin" ? "admin" : "user";
      next();
    },
  };
});

const { default: filesRouter } = await import("./files");
const { default: devRouter } = await import("./dev");

// The shared coding workspace (and the OpenCode access mode that governs it)
// belongs to the operator. A general user must not browse, write, delete or
// switch it to "full" access.
const WORKSPACE_ROUTES: Array<{
  method: string;
  path: string;
  body?: unknown;
}> = [
  { method: "GET", path: "/files" },
  { method: "GET", path: "/files/content?path=a.txt" },
  { method: "GET", path: "/files/download?path=a.txt" },
  { method: "POST", path: "/files/mkdir", body: { path: "x" } },
  { method: "PUT", path: "/files/content", body: { path: "a", content: "" } },
  { method: "POST", path: "/files/rename", body: { from: "a", to: "b" } },
  { method: "DELETE", path: "/files?path=x" },
  { method: "GET", path: "/dev/access-mode" },
  { method: "PUT", path: "/dev/access-mode", body: { mode: "full" } },
];

let root = "";
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), "ws-authz-"));
  process.env.CODE_WORKSPACE_ROOT = root;
});
afterAll(() => {
  delete process.env.CODE_WORKSPACE_ROOT;
  rmSync(root, { recursive: true, force: true });
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(filesRouter);
  app.use(devRouter);
  return app;
}

async function call(
  method: string,
  url: string,
  role?: string,
  body?: unknown,
): Promise<number> {
  const app = buildApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}${url}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(role ? { "x-test-role": role } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    await res.arrayBuffer();
    return res.status;
  } finally {
    server.close();
  }
}

describe("workspace routes are admin-only", () => {
  it("rejects unauthenticated requests", async () => {
    for (const r of WORKSPACE_ROUTES) {
      expect(await call(r.method, r.path, undefined, r.body), r.path).toBe(401);
    }
  });

  it("rejects general users with 403", async () => {
    for (const r of WORKSPACE_ROUTES) {
      expect(
        await call(r.method, r.path, "user", r.body),
        `${r.method} ${r.path}`,
      ).toBe(403);
    }
  });

  it("lets admins list the workspace", async () => {
    expect(await call("GET", "/files", "admin")).toBe(200);
  });
});
