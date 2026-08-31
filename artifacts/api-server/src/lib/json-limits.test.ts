import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import {
  DEFAULT_JSON_LIMIT,
  LARGE_JSON_LIMIT,
  LARGE_JSON_PATHS,
} from "./json-limits";

function listen(app: express.Express): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function post(
  port: number,
  path: string,
  bytes: number,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({ content: "x".repeat(bytes) });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

describe("JSON body limits", () => {
  it("accepts a ~300KB image-sized payload on conversation and private-session posts", async () => {
    const app = express();
    app.use([...LARGE_JSON_PATHS], express.json({ limit: LARGE_JSON_LIMIT }));
    app.use(express.json({ limit: DEFAULT_JSON_LIMIT }));
    const echo: express.RequestHandler = (req, res) => {
      res.json({
        n: typeof req.body?.content === "string" ? req.body.content.length : 0,
      });
    };
    app.post("/api/openai/conversations/:id/messages", echo);
    app.post("/api/openai/ephemeral/messages", echo);
    app.post("/api/openai/conversations", echo);
    app.use(
      (
        err: Error & { status?: number; type?: string },
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        res
          .status(err.status ?? 500)
          .json({ error: err.message, type: err.type });
      },
    );

    const server = await listen(app);
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("expected a TCP port");
    }
    const { port } = address;
    try {
      const large = 300_000;
      const conv = await post(
        port,
        "/api/openai/conversations/16/messages",
        large,
      );
      const ephemeral = await post(
        port,
        "/api/openai/ephemeral/messages",
        large,
      );
      const other = await post(port, "/api/openai/conversations", large);
      expect(conv.status).toBe(200);
      expect(ephemeral.status).toBe(200);
      expect(other.status).toBe(413);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
