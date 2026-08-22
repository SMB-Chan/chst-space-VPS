import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getBrowserEgressMetrics } from "../lib/browser-egress-proxy";
import { getBrowserFetchMetrics } from "../lib/render-fetch";
import { getSharedAiUsageMetrics } from "../middlewares/sharedAiUsageGuard";

const router: IRouter = Router();

function operationalMetrics() {
  return {
    aiUsageLimiter: getSharedAiUsageMetrics(),
    browserFetch: getBrowserFetchMetrics(),
    browserEgress: getBrowserEgressMetrics(),
  };
}

async function healthResponse(res: Parameters<Parameters<IRouter["get"]>[1]>[1]): Promise<void> {
  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      ...operationalMetrics(),
    });
  } catch (err) {
    res.status(503).json({
      status: "error",
      detail: "Database unreachable",
      ...operationalMetrics(),
    });
  }
}

// Root API health check used by some deployment platforms.
router.get("/", (_req, res) => void healthResponse(res));
router.get("/healthz", (_req, res) => void healthResponse(res));

export default router;
