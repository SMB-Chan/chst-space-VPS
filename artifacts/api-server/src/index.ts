import { pool } from "@workspace/db";
import app from "./app";
import { closeBrowser } from "./lib/render-fetch";
import {
  ensureAiUsageSchema,
  ensureAlibabaVideoJobsSchema,
  ensureAssetsSchema,
  ensureMessageSchema,
  ensureLlmMemoriesSchema,
} from "./lib/ensure-schema";
import { createGracefulShutdown } from "./lib/graceful-shutdown";
import { startAlibabaVideoWorker } from "./lib/alibaba-video-worker";
import { attachAlibabaRealtimeWebSocket } from "./lib/alibaba-realtime";
import { startMemoryWorker } from "./lib/llm-memory-worker";
import { logger } from "./lib/logger";
import { startupReadiness } from "./lib/startup-readiness";

const rawPort = process.env["PORT"] ?? "5000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main(): Promise<void> {
  startupReadiness.markNotReady();
  const videoWorker = startAlibabaVideoWorker();
  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
  const realtimeSocket = attachAlibabaRealtimeWebSocket(server);
  let memoryWorker: ReturnType<typeof startMemoryWorker> | undefined;
  const shutdown = createGracefulShutdown({
    server,
    resources: [
      { name: "memory-worker", close: async () => memoryWorker?.close() },
      { name: "alibaba-video-worker", close: videoWorker.close },
      { name: "alibaba-realtime-websocket", close: realtimeSocket.close },
      { name: "browser-egress", close: closeBrowser },
      { name: "postgres", close: async () => pool.end() },
    ],
    logger,
  });

  server.once("error", (err) => {
    logger.error({ err }, "Error listening on port");
    void shutdown("listen-error");
  });

  process.once("SIGTERM", () => {
    startupReadiness.markNotReady();
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    startupReadiness.markNotReady();
    void shutdown("SIGINT");
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(
      { err: reason instanceof Error ? reason : undefined },
      "Unhandled promise rejection — initiating graceful shutdown",
    );
    void shutdown("unhandledRejection");
  });
  process.on("uncaughtException", (err) => {
    logger.error({ err }, "Uncaught exception — initiating graceful shutdown");
    void shutdown("uncaughtException");
  });

  try {
    await ensureMessageSchema((sql) => pool.query(sql));
    await ensureAssetsSchema((sql) => pool.query(sql));
    await ensureAlibabaVideoJobsSchema((sql) => pool.query(sql));
    await ensureAiUsageSchema((sql) => pool.query(sql));
    await ensureLlmMemoriesSchema((sql) => pool.query(sql));
    memoryWorker = startMemoryWorker();
    startupReadiness.markReady();
    logger.info("Server ready");
  } catch (err) {
    logger.error({ err }, "Failed to ensure database schema");
    await shutdown("startup-failure");
    process.exitCode = 1;
  }
}

void main();
