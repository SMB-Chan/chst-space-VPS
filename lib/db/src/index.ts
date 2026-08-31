import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number.parseInt(process.env.DB_POOL_MAX ?? "5", 10),
  idleTimeoutMillis: Number.parseInt(
    process.env.DB_POOL_IDLE_TIMEOUT_MS ?? "30000",
    10,
  ),
  connectionTimeoutMillis: Number.parseInt(
    process.env.DB_POOL_CONNECTION_TIMEOUT_MS ?? "5000",
    10,
  ),
});
export const db = drizzle(pool, { schema });

export * from "./schema";
