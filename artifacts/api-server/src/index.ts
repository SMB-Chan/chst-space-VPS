import { pool } from "@workspace/db";
import app from "./app";
import { ensureMessageSchema } from "./lib/ensure-schema";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"] ?? "5000";

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function main(): Promise<void> {
  try {
    await ensureMessageSchema((sql) => pool.query(sql));
  } catch (err) {
    logger.error({ err }, "Failed to ensure database schema");
    process.exit(1);
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    logger.info({ port }, "Server listening");
  });
}

void main();
