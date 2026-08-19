import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";

const router: IRouter = Router();

async function healthResponse(res: Parameters<Parameters<IRouter["get"]>[1]>[1]): Promise<void> {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "error", detail: "Database unreachable" });
  }
}

// Root API health check used by some deployment platforms.
router.get("/", (_req, res) => void healthResponse(res));
router.get("/healthz", (_req, res) => void healthResponse(res));

export default router;
