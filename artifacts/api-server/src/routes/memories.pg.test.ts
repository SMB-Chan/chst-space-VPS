import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureLlmMemoriesSchema } from "../lib/ensure-schema";
vi.mock("@clerk/express", () => ({
  getAuth: (req: express.Request) => ({
    userId: req.header("authorization")?.replace(/^Bearer /, ""),
  }),
}));
import router from "./memories";
const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;
const users = [`memory-api-a:${randomUUID()}`, `memory-api-b:${randomUUID()}`];
let pool: (typeof import("@workspace/db"))["pool"];
let server: Server;
let base: string;
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  user: string | null = users[0],
) =>
  fetch(`${base}/memories${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(user ? { authorization: `Bearer ${user}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describePostgres("authenticated provider-neutral memory API", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    await ensureLlmMemoriesSchema((sql) => pool.query(sql));
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
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    if (pool)
      await pool.query(
        "DELETE FROM llm_memories WHERE user_id = ANY($1::text[])",
        [users],
      );
  });
  it("requires auth and rejects owner spoofing, invalid dates, and missing provenance", async () => {
    expect((await request("", "GET", undefined, null)).status).toBe(401);
    for (const extra of [
      { user_id: users[1] },
      { valid_as_of: "2026-02-30" },
      { kind: "sourced_fact" },
    ]) {
      expect(
        (await request("", "POST", { topic: "x", content: "x", ...extra }))
          .status,
      ).toBe(400);
    }
  });
  it("creates, retrieves bounded context, corrects, invalidates, and erases via HTTP", async () => {
    const created = await request("", "POST", {
      topic: "応答形式",
      content: "日本語で簡潔に答える",
      kind: "user_statement",
      category: "preference",
    });
    expect(created.status).toBe(201);
    const memory = await created.json();
    expect(
      (await request(`/${memory.id}`, "GET", undefined, users[1])).status,
    ).toBe(404);
    expect(
      (await request(`/${memory.id}`, "DELETE", undefined, users[1])).status,
    ).toBe(404);
    const context = await (
      await request("/context", "POST", {
        message: "こんにちは",
        max_chars: 1000,
      })
    ).json();
    expect(context.context).toContain("日本語で簡潔");
    expect(context.characters).toBeLessThanOrEqual(1000);
    expect(context.characters).toBe(context.context.length);
    expect(
      (await request(`/${memory.id}`, "PATCH", { content: "新しい値" })).status,
    ).toBe(400);
    const corrected = await request(`/${memory.id}`, "PATCH", {
      content: "詳しく答える",
      expected_revision: 1,
      reason: "preference changed",
    });
    expect(corrected.status).toBe(200);
    expect((await corrected.json()).revision).toBe(2);
    expect(
      (
        await request(`/${memory.id}`, "PATCH", {
          content: "競合",
          expected_revision: 1,
        })
      ).status,
    ).toBe(409);
    const history = await (await request(`/${memory.id}/revisions`)).json();
    expect(history.revisions[0].snapshot.content).toBe("日本語で簡潔に答える");
    expect(
      (
        await request(`/${memory.id}/invalidate`, "POST", {
          reason: "incorrect",
          expected_revision: 2,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await (
          await request("/context", "POST", { message: "こんにちは" })
        ).json()
      ).context,
    ).toBe("");
    expect(
      (
        await request(`/${memory.id}`, "PATCH", {
          content: "復活",
          expected_revision: 3,
        })
      ).status,
    ).toBe(409);
    expect((await request(`/${memory.id}`, "DELETE")).status).toBe(204);
    expect((await request(`/${memory.id}/revisions`)).status).toBe(404);
  });
  it("searches, lists, replaces, and maintains only the authenticated owner", async () => {
    const create = async (content: string) =>
      (
        await request("", "POST", {
          topic: "api-search",
          content,
          kind: "user_statement",
        })
      ).json();
    const old = await create("old");
    const fresh = await create("fresh");
    expect(
      (await (await request("/search?query=api-search&limit=10")).json())
        .memories,
    ).toHaveLength(2);
    expect(
      (await request(`/${old.id}/supersede`, "POST", { new_id: fresh.id }))
        .status,
    ).toBe(200);
    expect(
      (await (await request("/search?query=api-search")).json()).memories.map(
        (m: { id: string }) => m.id,
      ),
    ).toEqual([fresh.id]);
    expect(
      (await (await request("?limit=1&offset=1")).json()).memories,
    ).toHaveLength(1);
    expect((await request("/maintenance", "POST")).status).toBe(200);
    expect((await request("?limit=1000")).status).toBe(400);
  });
});
