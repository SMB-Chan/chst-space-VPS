import express from "express";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  HASHED_ASSET_CACHE_CONTROL,
  SHELL_CACHE_CONTROL,
  cacheControlForStaticFile,
  setStaticCacheHeaders,
} from "./static-cache";

describe("cacheControlForStaticFile", () => {
  it("never lets the shell or service worker be cached", () => {
    for (const f of ["/d/index.html", "/d/sw.js", "/d/manifest.webmanifest"]) {
      expect(cacheControlForStaticFile(f)).toBe(SHELL_CACHE_CONTROL);
    }
  });
  it("caches hashed assets immutably and leaves other files alone", () => {
    expect(cacheControlForStaticFile("/d/assets/index-abc123.js")).toBe(
      HASHED_ASSET_CACHE_CONTROL,
    );
    expect(cacheControlForStaticFile("/d/favicon.svg")).toBeNull();
  });
});

describe("static serving headers (express)", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "static-cache-"));
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "sw.js"), "// sw");
    writeFileSync(path.join(dir, "assets", "app-1a2b.js"), "// app");
    const app = express();
    app.use(express.static(dir, { setHeaders: setStaticCacheHeaders }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("overrides serve-static's default max-age", async () => {
    const sw = await fetch(`${base}/sw.js`);
    expect(sw.headers.get("cache-control")).toBe(SHELL_CACHE_CONTROL);
    const root = await fetch(`${base}/`);
    expect(root.headers.get("cache-control")).toBe(SHELL_CACHE_CONTROL);
    const asset = await fetch(`${base}/assets/app-1a2b.js`);
    expect(asset.headers.get("cache-control")).toBe(HASHED_ASSET_CACHE_CONTROL);
  });
});
