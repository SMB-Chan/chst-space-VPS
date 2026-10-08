import { pool } from "@workspace/db";
import app from "./app";
import { closeBrowser } from "./lib/render-fetch";
import { ensureChatSchema } from "./lib/ensure-schema";
import { createGracefulShutdown } from "./lib/graceful-shutdown";
import { startAlibabaVideoWorker } from "./lib/alibaba-video-worker";
import { attachAlibabaRealtimeWebSocket } from "./lib/alibaba-realtime";
import { startMemoryWorker } from "./lib/llm-memory-worker";
import { logger } from "./lib/logger";
import { startupReadiness } from "./lib/startup-readiness";
import { resolveAuthMode } from "./middlewares/requireAuth";
import { ensureBootstrapAdmin } from "./lib/bootstrap-admin";
import { seedModelCatalog } from "./lib/model-catalog";

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
    // Single aggregate entry point: every table (including the usage and
    // user-settings stores) is ensured here. Enumerating functions here used
    // to drift from ensureChatSchema and left new tables uncreated at boot.
    await ensureChatSchema((sql) => pool.query(sql));
    // Seed built-in providers/models into the admin-managed catalog
    // (ON CONFLICT DO NOTHING keeps admin edits) and load the registry.
    try {
      await seedModelCatalog();
    } catch (err) {
      // The static in-code catalog keeps serving chats if this fails.
      logger.error({ err }, "Failed to seed the model catalog");
    }
    if (resolveAuthMode() === "password") {
      const bootstrap = await ensureBootstrapAdmin();
      if (bootstrap === "created") {
        logger.info("Created the first admin account from BOOTSTRAP_ADMIN_*");
      } else if (bootstrap === "missing-config") {
        logger.warn(
          "AUTH_MODE=password has no admin account yet. Set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD, or run dist/create-admin.mjs.",
        );
      } else if (bootstrap === "invalid-config") {
        logger.warn(
          "BOOTSTRAP_ADMIN_* is invalid (username 3-32 chars [a-z0-9._-], password 8-200 chars) or already taken; no admin was created.",
        );
      }
    }
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
