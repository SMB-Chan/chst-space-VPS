import { pool } from "@workspace/db";
import app from "./app";
import { closeBrowser } from "./lib/render-fetch";
import {
  ensureAiUsageSchema,
  ensureAlibabaVideoJobsSchema,
  ensureAssetsSchema,
  ensureMessageSchema,
} from "./lib/ensure-schema";
import { createGracefulShutdown } from "./lib/graceful-shutdown";
import { startAlibabaVideoWorker } from "./lib/alibaba-video-worker";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] ?? "5000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main(): Promise<void> {
  try {
    await ensureMessageSchema((sql) => pool.query(sql));
    await ensureAssetsSchema((sql) => pool.query(sql));
    await ensureAlibabaVideoJobsSchema((sql) => pool.query(sql));
    await ensureAiUsageSchema((sql) => pool.query(sql));
  } catch (err) {
    logger.error({ err }, "Failed to ensure database schema");
    process.exit(1);
  }

  const videoWorker = startAlibabaVideoWorker();
  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });

  const shutdown = createGracefulShutdown({
    server,
    resources: [
      { name: "alibaba-video-worker", close: videoWorker.close },
      { name: "browser-egress", close: closeBrowser },
      { name: "postgres", close: async () => pool.end() },
    ],
    logger,
  });

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

void main();
