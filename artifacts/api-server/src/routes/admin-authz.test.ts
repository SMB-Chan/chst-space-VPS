import express, {
  type Request as ExpressRequest,
  type Response,
  type NextFunction,
} from "express";
import { describe, expect, it, vi } from "vitest";
import adminRouter from "./admin";
import authRouter from "./auth";

// Capture every method+path that the admin routers expose. If any new
// admin endpoint slips in without going through this list, this test
// will start failing and force the author to update the snapshot — and
// to keep requireAuth/requireAdmin in front of every new handler.
const ADMIN_ROUTES: Array<{ method: string; path: string }> = [
  // legacy admin routes
  { method: "GET", path: "/admin/overview" },
  { method: "PUT", path: "/admin/users/:userId/budget" },
  { method: "PUT", path: "/admin/users/:userId/suspension" },
  { method: "DELETE", path: "/admin/users/:userId/data" },
  // new CRUD
  { method: "GET", path: "/admin/providers" },
  { method: "POST", path: "/admin/providers" },
  { method: "PATCH", path: "/admin/providers/:id" },
  { method: "DELETE", path: "/admin/providers/:id" },
  { method: "GET", path: "/admin/models" },
  { method: "POST", path: "/admin/models" },
  { method: "PATCH", path: "/admin/models/:id" },
  { method: "DELETE", path: "/admin/models/:id" },
  { method: "GET", path: "/admin/accounts" },
  { method: "POST", path: "/admin/accounts" },
  { method: "PATCH", path: "/admin/accounts/:id" },
  { method: "DELETE", path: "/admin/accounts/:id" },
];

// Mock the auth middleware. The "X-Test-Role" header drives the role
// for each test request; the absence of the header simulates an
// unauthenticated request.
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

// The auth router pulls in heavy DB-touching code paths; stub the
// password-auth helpers it depends on so the import doesn't try to open
// a pg pool during the test.
vi.mock("../lib/password-auth", async () => {
  const actual = await vi.importActual<typeof import("../lib/password-auth")>(
    "../lib/password-auth",
  );
  return {
    ...actual,
    findUserByUsername: async () => null,
    resolveSession: async () => null,
  };
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(authRouter);
  app.use(adminRouter);
  return app;
}

interface RouteCall {
  status: number;
  body: unknown;
}

async function call(
  app: express.Express,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<RouteCall> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("missing address"));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(async (res) => {
          await server.close();
          let parsed: unknown = null;
          const raw = await res.text();
          if (raw) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
          }
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => {
          void server.close();
          reject(err);
        });
    });
  });
}

describe("admin route authorization", () => {
  it("returns 401 when no role header is supplied", async () => {
    const app = buildApp();
    for (const route of ADMIN_ROUTES) {
      const res = await call(app, route.method, route.path);
      expect(res.status, `${route.method} ${route.path} unauthenticated`).toBe(
        401,
      );
    }
  });

  it("returns 403 ADMIN_ONLY for general users on every admin route", async () => {
    const app = buildApp();
    for (const route of ADMIN_ROUTES) {
      const res = await call(app, route.method, route.path, {
        "x-test-role": "user",
      });
      expect(res.status, `${route.method} ${route.path} as user`).toBe(403);
      expect((res.body as { code?: string }).code).toBe("ADMIN_ONLY");
    }
  });

  it("lets admins through the guard (handlers run)", async () => {
    const app = buildApp();
    const res = await call(app, "GET", "/admin/providers", {
      "x-test-role": "admin",
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
