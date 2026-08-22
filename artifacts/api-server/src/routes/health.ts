import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getSharedAiUsageMetrics } from "../middlewares/sharedAiUsageGuard";

const router: IRouter = Router();

async function healthResponse(res: Parameters<Parameters<IRouter["get"]>[1]>[1]): Promise<void> {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      aiUsageLimiter: getSharedAiUsageMetrics(),
    });
  } catch (err) {
    res.status(503).json({
      status: "error",
      detail: "Database unreachable",
      aiUsageLimiter: getSharedAiUsageMetrics(),
    });
  }
}

// Root API health check used by some deployment platforms.
router.get("/", (_req, res) => void healthResponse(res));
router.get("/healthz", (_req, res) => void healthResponse(res));

export default router;