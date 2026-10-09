import express, {
  type Request as ExpressRequest,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TINY_HEIC_BASE64 } from "../lib/project-images.fixtures";

// Header-driven auth stub; x-test-role selects admin vs user.
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
      const role = req.header("x-test-role") === "admin" ? "admin" : "user";
      req.userId = user;
      req.userRole = role;
      actual.requestUserContext.run({ userId: user, userRole: role }, () =>
        next(),
      );
    },
  };
});

process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??= "http://127.0.0.1:9/v1";
process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??= "test-key";

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

const admin = `proj-img-admin:${randomUUID()}`;
const member = `proj-img-user:${randomUUID()}`;
const intruder = `proj-img-intruder:${randomUUID()}`;
let pool: (typeof import("@workspace/db"))["pool"];
let store: typeof import("../lib/project-files-store");
let server: Server;
let base = "";
const describeCalls: { modelId: string; filename: string; url: string }[] = [];

async function call(
  method: string,
  path: string,
  user: string,
  body?: unknown,
  role: "admin" | "user" = "user",
): Promise<{ status: number; body: any; raw: Buffer; type: string | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-test-user": user,
      "x-test-role": role,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = Buffer.from(await res.arrayBuffer());
  let parsed: any = {};
  try {
    parsed = raw.length ? JSON.parse(raw.toString("utf-8")) : {};
  } catch {
    parsed = {};
  }
  return {
    status: res.status,
    body: parsed,
    raw,
    type: res.headers.get("content-type"),
  };
}

async function photoWithGps(): Promise<Buffer> {
  return sharp({
    create: { width: 300, height: 200, channels: 3, background: "#ddeeff" },
  })
    .jpeg()
    .withExif({
      IFD0: { Make: "Apple", Model: "iPhone 15" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 39/1 29/1" },
    })
    .toBuffer();
}

describePostgres("project image files (PostgreSQL)", () => {
  beforeAll(async () => {
    ({ pool } = await import("@workspace/db"));
    store = await import("../lib/project-files-store");
    // Only the admin has a describer (mirrors production: MiniMax admin-only).
    store.imageDescriberHooks.resolveModel = (role) =>
      role === "admin" ? "fake-vision" : null;
    store.imageDescriberHooks.describe = async (args) => {
      describeCalls.push({
        modelId: args.modelId,
        filename: args.filename,
        url: args.imageDataUrl,
      });
      return "## 概要\nテスト写真\n## 画像内の文字\n喫茶すおり ゆず茶 480円";
    };
    const { default: router } = await import("./projects");
    const app = express();
    app.use(express.json({ limit: "30mb" }));
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
    if (store) await store.waitForImageDescriptions();
    if (pool) {
      await pool.query("DELETE FROM projects WHERE user_id = ANY($1)", [
        [admin, member, intruder],
      ]);
    }
  });

  it("stores a stripped image, thumbnail and generated description", async () => {
    const created = await call(
      "POST",
      "/projects",
      admin,
      { name: "img" },
      "admin",
    );
    expect(created.status).toBe(201);
    const id = created.body.project.id as number;

    const upload = await call(
      "POST",
      `/projects/${id}/files`,
      admin,
      {
        filename: "看板.jpeg",
        dataBase64: (await photoWithGps()).toString("base64"),
      },
      "admin",
    );
    expect(upload.status).toBe(201);
    const file = upload.body.file;
    expect(file).toMatchObject({
      kind: "image",
      filename: "看板.jpg",
      mimeType: "image/jpeg",
      imageWidth: 300,
      imageHeight: 200,
      hasThumbnail: true,
      sendImage: false,
      descriptionStatus: "pending",
    });

    await store.waitForImageDescriptions();
    expect(describeCalls.at(-1)?.modelId).toBe("fake-vision");
    expect(describeCalls.at(-1)?.url).toMatch(/^data:image\/jpeg;base64,/);

    const list = await call(
      "GET",
      `/projects/${id}/files`,
      admin,
      undefined,
      "admin",
    );
    expect(list.body.imageDescription).toEqual({ available: true });
    const listed = list.body.files[0];
    expect(listed.descriptionStatus).toBe("ready");
    expect(listed.descriptionModel).toBe("fake-vision");
    expect(listed.textChars).toBeGreaterThan(10);

    // Description flows into chat context like extracted text.
    const { loadProjectContext } = await import("../lib/project-context");
    const ctx = await loadProjectContext(admin, id);
    expect(ctx).toContain("喫茶すおり ゆず茶 480円");
    expect(ctx).toContain('<file name="看板.jpg">');

    // Download carries no EXIF/GPS.
    const download = await call(
      "GET",
      `/projects/${id}/files/${file.id}/download`,
      admin,
      undefined,
      "admin",
    );
    expect(download.status).toBe(200);
    const meta = await sharp(download.raw).metadata();
    expect(meta.exif).toBeUndefined();
    expect(download.raw.includes(Buffer.from("iPhone 15"))).toBe(false);

    const thumb = await call(
      "GET",
      `/projects/${id}/files/${file.id}/thumbnail`,
      admin,
      undefined,
      "admin",
    );
    expect(thumb.status).toBe(200);
    expect(thumb.type).toBe("image/webp");
    expect((await sharp(thumb.raw).metadata()).format).toBe("webp");

    // 「画像そのものを送る」 toggle and the vision payload.
    expect(await store.loadProjectVisionImages(admin, id)).toEqual([]);
    const toggled = await call(
      "PATCH",
      `/projects/${id}/files/${file.id}`,
      admin,
      { sendImage: true },
      "admin",
    );
    expect(toggled.status).toBe(200);
    expect(toggled.body.file.sendImage).toBe(true);
    const vision = await store.loadProjectVisionImages(admin, id);
    expect(vision).toHaveLength(1);
    expect(vision[0]?.dataUrl).toMatch(/^data:image\/jpeg;base64,/);

    // Excluding the file from context also stops the image being sent.
    await call(
      "PATCH",
      `/projects/${id}/files/${file.id}`,
      admin,
      { includeInContext: false },
      "admin",
    );
    expect(await store.loadProjectVisionImages(admin, id)).toEqual([]);

    // Mixed or unknown patch bodies are rejected.
    const bad = await call(
      "PATCH",
      `/projects/${id}/files/${file.id}`,
      admin,
      { includeInContext: true, sendImage: true },
      "admin",
    );
    expect(bad.status).toBe(400);

    // Regenerate.
    const again = await call(
      "POST",
      `/projects/${id}/files/${file.id}/describe`,
      admin,
      undefined,
      "admin",
    );
    expect(again.status).toBe(202);
    expect(again.body.file.descriptionStatus).toBe("pending");
    await store.waitForImageDescriptions();

    // Other users cannot see, toggle, describe or download it.
    for (const [method, path, body] of [
      ["GET", `/projects/${id}/files/${file.id}/thumbnail`, undefined],
      ["GET", `/projects/${id}/files/${file.id}/download`, undefined],
      ["PATCH", `/projects/${id}/files/${file.id}`, { sendImage: false }],
      ["POST", `/projects/${id}/files/${file.id}/describe`, undefined],
    ] as const) {
      const denied = await call(method, path, intruder, body);
      expect(denied.status).toBe(404);
    }
    expect(await store.loadProjectVisionImages(intruder, id)).toEqual([]);
  });

  it("stores images without a describer as 'unavailable' (non-admin) and converts HEIC", async () => {
    const created = await call("POST", "/projects", member, { name: "img-u" });
    const id = created.body.project.id as number;
    const before = describeCalls.length;
    const upload = await call("POST", `/projects/${id}/files`, member, {
      filename: "IMG_0001.HEIC",
      dataBase64: TINY_HEIC_BASE64,
    });
    expect(upload.status).toBe(201);
    expect(upload.body.file).toMatchObject({
      kind: "image",
      filename: "IMG_0001.jpg",
      mimeType: "image/jpeg",
      descriptionStatus: "unavailable",
      textChars: 0,
    });
    await store.waitForImageDescriptions();
    expect(describeCalls.length).toBe(before);

    const list = await call("GET", `/projects/${id}/files`, member);
    expect(list.body.imageDescription).toEqual({ available: false });

    const retry = await call(
      "POST",
      `/projects/${id}/files/${upload.body.file.id}/describe`,
      member,
    );
    expect(retry.status).toBe(202);
    expect(retry.body.file.descriptionStatus).toBe("unavailable");

    // sendImage is only meaningful for images; documents return 404.
    const doc = await call("POST", `/projects/${id}/files`, member, {
      filename: "memo.txt",
      dataBase64: Buffer.from("メモ").toString("base64"),
    });
    expect(doc.body.file).toMatchObject({
      kind: "document",
      descriptionStatus: "none",
      hasThumbnail: false,
    });
    const docToggle = await call(
      "PATCH",
      `/projects/${id}/files/${doc.body.file.id}`,
      member,
      { sendImage: true },
    );
    expect(docToggle.status).toBe(404);
    const docDescribe = await call(
      "POST",
      `/projects/${id}/files/${doc.body.file.id}/describe`,
      member,
    );
    expect(docDescribe.status).toBe(415);
  });

  it("rejects corrupt images and counts the stored size toward the quota", async () => {
    const created = await call("POST", "/projects", member, {
      name: "img-bad",
    });
    const id = created.body.project.id as number;
    const fake = Buffer.concat([
      Buffer.from("ffd8ffe000104a464946", "hex"),
      Buffer.alloc(200, 7),
    ]);
    const bad = await call("POST", `/projects/${id}/files`, member, {
      filename: "broken.jpg",
      dataBase64: fake.toString("base64"),
    });
    expect(bad.status).toBe(422);

    const input = await photoWithGps();
    const ok = await call("POST", `/projects/${id}/files`, member, {
      filename: "a.jpg",
      dataBase64: input.toString("base64"),
    });
    expect(ok.status).toBe(201);
    const usage = await store.getUserProjectFilesUsage(member);
    const { rows } = await pool.query(
      "SELECT coalesce(sum(length(decode(data, 'base64'))),0)::int AS bytes FROM project_files WHERE user_id = $1",
      [member],
    );
    expect(usage.totalBytes).toBe(rows[0].bytes);
  });
});
