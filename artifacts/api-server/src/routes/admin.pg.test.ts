import express from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Password mode must be active before any route module is evaluated.
vi.hoisted(() => {
  process.env.AUTH_MODE = "password";
  process.env.AUTH_COOKIE_SECURE = "false";
});

vi.mock("@clerk/express", () => ({
  getAuth: () => null,
  clerkMiddleware: () => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

const suffix = randomBytes(4).toString("hex");
const ADMIN = {
  id: `t-admin-${suffix}`,
  username: `tadmin${suffix}`,
  password: "admin-password-1",
};
const ADMIN2 = {
  id: `t-admin2-${suffix}`,
  username: `tadmintwo${suffix}`,
  password: "admin-password-2",
};
const USER = {
  id: `t-user-${suffix}`,
  username: `tuser${suffix}`,
  password: "user-password-1",
};
const PROVIDER_ID = `tp-${suffix}`;
const PROVIDER_KEY = `sk-test-${randomBytes(16).toString("hex")}`;
const CUSTOM_MODEL = `custom-model-${suffix}`;
const BUILTIN_SLASH_MODEL = "qwen/qwen3.7-flash";
const ADDED_BUILTIN_MODEL = `test/extra-${suffix}`;

let server: Server;
let base: string;
let pool: (typeof import("@workspace/db"))["pool"];
const createdAccountIds: string[] = [];

interface Res {
  status: number;
  body: unknown;
  raw: string;
  setCookie: string | null;
}

async function call(
  method: string,
  path: string,
  options: { cookie?: string; body?: unknown; forwardedFor?: string } = {},
): Promise<Res> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.forwardedFor
        ? { "x-forwarded-for": options.forwardedFor }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return {
    status: res.status,
    body,
    raw,
    setCookie: res.headers.get("set-cookie"),
  };
}

function cookieFrom(res: Res): string {
  const match = res.setCookie?.match(/cs_session=([^;]+)/);
  if (!match) throw new Error(`no session cookie (status ${res.status})`);
  return `cs_session=${match[1]}`;
}

async function login(username: string, password: string): Promise<string> {
  const res = await call("POST", "/auth/login", {
    body: { username, password },
  });
  expect(res.status).toBe(200);
  return cookieFrom(res);
}

describePostgres("password auth + admin console (PostgreSQL)", () => {
  let adminCookie = "";
  let userCookie = "";

  beforeAll(async () => {
    const dbModule = await import("@workspace/db");
    pool = dbModule.pool;
    const { ensureChatSchema } = await import("../lib/ensure-schema");
    await ensureChatSchema((sql) => pool.query(sql));
    const { seedModelCatalog } = await import("../lib/model-catalog");
    await seedModelCatalog();
    const { hashPassword } = await import("../lib/password-auth");
    for (const [account, role] of [
      [ADMIN, "admin"],
      [ADMIN2, "admin"],
      [USER, "user"],
    ] as const) {
      await pool.query(
        "INSERT INTO app_users (id, username, password_hash, role) VALUES ($1, $2, $3, $4)",
        [
          account.id,
          account.username,
          await hashPassword(account.password),
          role,
        ],
      );
      createdAccountIds.push(account.id);
    }
    const { default: authRouter } = await import("./auth");
    const { default: adminRouter } = await import("./admin");
    const app = express();
    app.use(express.json());
    app.use(authRouter);
    app.use(adminRouter);
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
    adminCookie = await login(ADMIN.username, ADMIN.password);
    userCookie = await login(USER.username, USER.password);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    if (!pool) return;
    await pool.query("DELETE FROM llm_providers WHERE id = $1", [PROVIDER_ID]);
    await pool.query("DELETE FROM llm_models WHERE id = $1", [
      ADDED_BUILTIN_MODEL,
    ]);
    await pool.query(
      "UPDATE llm_models SET deleted = false, enabled = true, user_visible = true WHERE id = $1",
      [BUILTIN_SLASH_MODEL],
    );
    await pool.query(
      "UPDATE llm_providers SET enabled = true WHERE id = 'openrouter'",
    );
    await pool.query("DELETE FROM app_users WHERE id = ANY($1::text[])", [
      createdAccountIds,
    ]);
    await pool.query("DELETE FROM app_users WHERE username LIKE $1", [
      `%${suffix}`,
    ]);
    const { resetModelCatalogForTests } = await import("../lib/model-catalog");
    resetModelCatalogForTests();
  });

  it("issues an HttpOnly session cookie and reports the account via /auth/me", async () => {
    const res = await call("POST", "/auth/login", {
      body: {
        username: ADMIN.username.toUpperCase(),
        password: ADMIN.password,
      },
    });
    expect(res.status).toBe(200);
    expect(res.setCookie).toMatch(/HttpOnly/);
    expect(res.setCookie).toMatch(/SameSite=Lax/);
    expect(res.raw).not.toContain("password");
    const me = await call("GET", "/auth/me", { cookie: cookieFrom(res) });
    expect(me.body).toMatchObject({
      authMode: "password",
      user: { id: ADMIN.id, username: ADMIN.username, role: "admin" },
    });
    const anonymous = await call("GET", "/auth/me");
    expect(anonymous.body).toEqual({ authMode: "password", user: null });
  });

  it("rejects wrong passwords and unknown users with the same generic error", async () => {
    const wrong = await call("POST", "/auth/login", {
      body: { username: USER.username, password: "definitely-wrong" },
    });
    const unknown = await call("POST", "/auth/login", {
      body: { username: `nobody${suffix}`, password: "definitely-wrong" },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("enforces authentication and the admin role on admin APIs", async () => {
    for (const path of [
      "/admin/providers",
      "/admin/models",
      "/admin/accounts",
      "/admin/overview",
    ]) {
      expect((await call("GET", path)).status, path).toBe(401);
      const asUser = await call("GET", path, { cookie: userCookie });
      expect(asUser.status, path).toBe(403);
      expect(
        (await call("GET", path, { cookie: adminCookie })).status,
        path,
      ).toBe(200);
    }
    const forged = await call("GET", "/admin/providers", {
      cookie: "cs_session=forged-token",
    });
    expect(forged.status).toBe(401);
    const userCreate = await call("POST", "/admin/accounts", {
      cookie: userCookie,
      body: {
        username: `evil${suffix}`,
        password: "password-123",
        role: "admin",
      },
    });
    expect(userCreate.status).toBe(403);
  });

  it("manages custom providers without ever returning the API key", async () => {
    const { getClientForModel } = await import("../lib/ai-clients");
    const { getCustomChatModels } = await import("../lib/model-catalog");
    const created = await call("POST", "/admin/providers", {
      cookie: adminCookie,
      body: {
        id: PROVIDER_ID,
        label: "Test Gateway",
        baseUrl: "https://gateway.example.test/v1",
        apiKey: PROVIDER_KEY,
      },
    });
    expect(created.status).toBe(201);
    expect(
      (
        await call("POST", "/admin/providers", {
          cookie: adminCookie,
          body: {
            id: PROVIDER_ID,
            label: "dup",
            baseUrl: "https://x.test/v1",
            apiKey: "k",
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("POST", "/admin/providers", {
          cookie: adminCookie,
          body: {
            id: "openai",
            label: "dup",
            baseUrl: "https://x.test/v1",
            apiKey: "k",
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("POST", "/admin/providers", {
          cookie: adminCookie,
          body: {
            id: `bad-${suffix}`,
            label: "x",
            baseUrl: "ftp://x.test",
            apiKey: "k",
          },
        })
      ).status,
    ).toBe(400);

    const list = await call("GET", "/admin/providers", { cookie: adminCookie });
    expect(list.raw).not.toContain(PROVIDER_KEY);
    const row = (list.body as Array<Record<string, unknown>>).find(
      (p) => p.id === PROVIDER_ID,
    );
    expect(row).toMatchObject({
      kind: "custom",
      hasKey: true,
      keyHint: `…${PROVIDER_KEY.slice(-4)}`,
      configured: true,
      enabled: true,
    });
    expect(Object.keys(row!)).not.toContain("apiKeyEncrypted");

    const model = await call("POST", "/admin/models", {
      cookie: adminCookie,
      body: {
        id: CUSTOM_MODEL,
        providerId: PROVIDER_ID,
        label: "Custom Model",
        userVisible: true,
      },
    });
    expect(model.status).toBe(201);
    expect(getCustomChatModels().map((m) => m.id)).toContain(CUSTOM_MODEL);
    const resolved = getClientForModel(CUSTOM_MODEL);
    expect(resolved.provider).toBe("custom");
    expect(resolved.client.baseURL).toBe("https://gateway.example.test/v1");

    // Disabling the provider removes its models from the chat catalog.
    expect(
      (
        await call("PATCH", `/admin/providers/${PROVIDER_ID}`, {
          cookie: adminCookie,
          body: { enabled: false },
        })
      ).status,
    ).toBe(204);
    expect(getCustomChatModels().map((m) => m.id)).not.toContain(CUSTOM_MODEL);
    expect(() => getClientForModel(CUSTOM_MODEL)).toThrow();

    // Deleting the provider cascades to its models.
    expect(
      (
        await call("DELETE", `/admin/providers/${PROVIDER_ID}`, {
          cookie: adminCookie,
        })
      ).status,
    ).toBe(204);
    const models = await call("GET", "/admin/models", { cookie: adminCookie });
    expect(
      (models.body as Array<{ id: string }>).some((m) => m.id === CUSTOM_MODEL),
    ).toBe(false);
  });

  it("protects built-in providers: toggle only, never delete", async () => {
    const { isCatalogProviderEnabled } = await import("../lib/model-registry");
    expect(
      (
        await call("PATCH", "/admin/providers/openrouter", {
          cookie: adminCookie,
          body: { label: "renamed" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("DELETE", "/admin/providers/openrouter", {
          cookie: adminCookie,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("PATCH", "/admin/providers/openrouter", {
          cookie: adminCookie,
          body: { enabled: false },
        })
      ).status,
    ).toBe(204);
    expect(isCatalogProviderEnabled("openrouter")).toBe(false);
    await call("PATCH", "/admin/providers/openrouter", {
      cookie: adminCookie,
      body: { enabled: true },
    });
    expect(isCatalogProviderEnabled("openrouter")).toBe(true);
  });

  it("tombstones built-in models (ids with '/'), survives re-seeding, and restores on re-add", async () => {
    const { getCuratedBuiltinChatModels, seedModelCatalog } =
      await import("../lib/model-catalog");
    const { isModelAllowedForRole } =
      await import("../lib/specialist-capabilities");
    const encoded = encodeURIComponent(BUILTIN_SLASH_MODEL);
    const hidden = await call("PATCH", `/admin/models/${encoded}`, {
      cookie: adminCookie,
      body: { userVisible: false },
    });
    expect(hidden.status).toBe(204);
    expect(
      isModelAllowedForRole(
        { id: BUILTIN_SLASH_MODEL, provider: "openrouter" },
        "user",
      ),
    ).toBe(false);

    expect(
      (
        await call("DELETE", `/admin/models/${encoded}`, {
          cookie: adminCookie,
        })
      ).status,
    ).toBe(204);
    await seedModelCatalog();
    expect(getCuratedBuiltinChatModels().map((m) => m.id)).not.toContain(
      BUILTIN_SLASH_MODEL,
    );
    const listed = await call("GET", "/admin/models", { cookie: adminCookie });
    expect(
      (listed.body as Array<{ id: string }>).some(
        (m) => m.id === BUILTIN_SLASH_MODEL,
      ),
    ).toBe(false);

    const restored = await call("POST", "/admin/models", {
      cookie: adminCookie,
      body: {
        id: BUILTIN_SLASH_MODEL,
        providerId: "openrouter",
        label: "Qwen3.7 Flash (OR)",
        supportsVision: true,
        supportsReasoning: true,
        userVisible: true,
      },
    });
    expect(restored.status).toBe(201);
    expect(restored.body).toMatchObject({ restored: true });
    const curated = getCuratedBuiltinChatModels().find(
      (m) => m.id === BUILTIN_SLASH_MODEL,
    );
    expect(curated?.reasoning).toBe("openrouter");

    const added = await call("POST", "/admin/models", {
      cookie: adminCookie,
      body: {
        id: ADDED_BUILTIN_MODEL,
        providerId: "openrouter",
        label: "Extra",
        supportsReasoning: true,
      },
    });
    expect(added.status).toBe(201);
    expect(
      getCuratedBuiltinChatModels().find((m) => m.id === ADDED_BUILTIN_MODEL),
    ).toMatchObject({ provider: "openrouter", reasoning: "openrouter" });
    expect(
      (
        await call("POST", "/admin/models", {
          cookie: adminCookie,
          body: {
            id: ADDED_BUILTIN_MODEL,
            providerId: "openrouter",
            label: "dup",
          },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          "DELETE",
          `/admin/models/${encodeURIComponent(ADDED_BUILTIN_MODEL)}`,
          {
            cookie: adminCookie,
          },
        )
      ).status,
    ).toBe(204);
  });

  it("creates, updates and deletes accounts with self-protection", async () => {
    const username = `tnew${suffix}`;
    const created = await call("POST", "/admin/accounts", {
      cookie: adminCookie,
      body: { username, password: "new-user-pass", displayName: "New" },
    });
    expect(created.status).toBe(201);
    const newId = (created.body as { id: string }).id;
    createdAccountIds.push(newId);
    expect(
      (
        await call("POST", "/admin/accounts", {
          cookie: adminCookie,
          body: { username, password: "new-user-pass" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("POST", "/admin/accounts", {
          cookie: adminCookie,
          body: { username: "x", password: "new-user-pass" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/admin/accounts", {
          cookie: adminCookie,
          body: { username: `short${suffix}`, password: "short" },
        })
      ).status,
    ).toBe(400);

    const accounts = await call("GET", "/admin/accounts", {
      cookie: adminCookie,
    });
    expect(accounts.raw).not.toContain("scrypt$");
    expect(accounts.body).toMatchObject({ authMode: "password" });

    const newCookie = await login(username, "new-user-pass");
    expect(
      (
        await call("PATCH", `/admin/accounts/${newId}`, {
          cookie: adminCookie,
          body: { password: "reset-password-1" },
        })
      ).status,
    ).toBe(204);
    // The reset signs the account out everywhere.
    expect(
      (await call("GET", "/auth/me", { cookie: newCookie })).body,
    ).toMatchObject({
      user: null,
    });
    await login(username, "reset-password-1");

    expect(
      (
        await call("PATCH", `/admin/accounts/${ADMIN.id}`, {
          cookie: adminCookie,
          body: { role: "user" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("DELETE", `/admin/accounts/${ADMIN.id}`, {
          cookie: adminCookie,
        })
      ).status,
    ).toBe(400);

    expect(
      (
        await call("DELETE", `/admin/accounts/${newId}?purgeData=true`, {
          cookie: adminCookie,
        })
      ).status,
    ).toBe(204);
    const gone = await call("POST", "/auth/login", {
      body: { username, password: "reset-password-1" },
    });
    expect(gone.status).toBe(401);
  });

  it("lets another admin demote an admin, and the overview reflects DB roles", async () => {
    const admin2Cookie = await login(ADMIN2.username, ADMIN2.password);
    expect(
      (
        await call("PATCH", `/admin/accounts/${ADMIN2.id}`, {
          cookie: adminCookie,
          body: { role: "user" },
        })
      ).status,
    ).toBe(204);
    // Role changes take effect immediately: old admin session is revoked.
    expect(
      (await call("GET", "/admin/providers", { cookie: admin2Cookie })).status,
    ).toBe(401);
    const overview = await call("GET", "/admin/overview", {
      cookie: adminCookie,
    });
    const users = (
      overview.body as { users: Array<{ userId: string; role: string }> }
    ).users;
    expect(users.find((u) => u.userId === ADMIN.id)?.role).toBe("admin");
    expect(users.find((u) => u.userId === ADMIN2.id)?.role).toBe("user");
  });

  it("changes the own password and revokes other sessions", async () => {
    const otherDevice = await login(USER.username, USER.password);
    const changed = await call("POST", "/auth/password", {
      cookie: userCookie,
      body: { currentPassword: USER.password, newPassword: "user-password-2" },
    });
    expect(changed.status).toBe(204);
    const renewed = cookieFrom(changed);
    expect(
      (await call("GET", "/auth/me", { cookie: otherDevice })).body,
    ).toMatchObject({
      user: null,
    });
    expect(
      (await call("GET", "/auth/me", { cookie: renewed })).body,
    ).toMatchObject({
      user: { id: USER.id },
    });
    expect(
      (
        await call("POST", "/auth/password", {
          cookie: renewed,
          body: {
            currentPassword: "wrong-password",
            newPassword: "whatever-123",
          },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("POST", "/auth/password", {
          body: { currentPassword: "x", newPassword: "y" },
        })
      ).status,
    ).toBe(401);
    userCookie = renewed;
  });

  it("logout invalidates the session", async () => {
    const cookie = await login(ADMIN.username, ADMIN.password);
    expect((await call("POST", "/auth/logout", { cookie })).status).toBe(204);
    expect((await call("GET", "/admin/providers", { cookie })).status).toBe(
      401,
    );
  });

  it("throttles repeated login failures with 429", async () => {
    const { resetLoginThrottleForTests } = await import("./auth");
    resetLoginThrottleForTests();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (
        await call("POST", "/auth/login", {
          body: { username: USER.username, password: "wrong-password" },
        })
      ).status;
    }
    expect(last).toBe(429);
    resetLoginThrottleForTests();
  });

  it("throttles per address via the rightmost X-Forwarded-For hop only", async () => {
    const { resetLoginThrottleForTests } = await import("./auth");
    resetLoginThrottleForTests();
    const attempt = (username: string, forwardedFor: string) =>
      call("POST", "/auth/login", {
        body: { username, password: "wrong-password" },
        forwardedFor,
      });
    // 50 failures from one client address, spread over unknown usernames so
    // the per-username bucket never trips. A rotating spoofed leftmost hop
    // must not dodge the address bucket.
    for (let i = 0; i < 50; i++) {
      const res = await attempt(`ghost${i}`, `198.51.100.${i}, 203.0.113.7`);
      expect(res.status).toBe(401);
    }
    expect((await attempt("ghost-next", "203.0.113.7")).status).toBe(429);
    // A different client behind the same proxy is unaffected, and the real
    // account still signs in from there.
    expect((await attempt("ghost-other", "203.0.113.8")).status).toBe(401);
    const ok = await call("POST", "/auth/login", {
      body: { username: ADMIN.username, password: ADMIN.password },
      forwardedFor: "203.0.113.8",
    });
    expect(ok.status).toBe(200);
    resetLoginThrottleForTests();
  });
});
