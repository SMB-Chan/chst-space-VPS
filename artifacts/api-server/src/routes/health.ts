import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { getBrowserEgressMetrics } from "../lib/browser-egress-proxy";
import { shouldIncludeOperationalHealthMetrics } from "../lib/health-config";
import { getBrowserFetchMetrics } from "../lib/render-fetch";
import { getSharedAiUsageMetrics } from "../middlewares/sharedAiUsageGuard";
import { startupReadiness } from "../lib/startup-readiness";

const router: IRouter = Router();

function operationalMetrics() {
  return {
    aiUsageLimiter: getSharedAiUsageMetrics(),
    browserFetch: getBrowserFetchMetrics(),
    browserEgress: getBrowserEgressMetrics(),
  };
}

function optionalOperationalMetrics(): Record<string, unknown> {
  return shouldIncludeOperationalHealthMetrics() ? operationalMetrics() : {};
}

async function healthResponse(
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
): Promise<void> {
  if (!startupReadiness.isReady()) {
    res.status(503).json({
      status: "starting",
      detail: "Service is still starting",
      ...optionalOperationalMetrics(),
    });
    return;
  }

  try {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      ...optionalOperationalMetrics(),
    });
  } catch (err) {
    res.status(503).json({
      status: "error",
      detail: "Database unreachable",
      ...optionalOperationalMetrics(),
    });
  }
}

// Root API health check used by some deployment platforms. Keep the response
// minimal by default because these routes are intentionally mounted before
// authentication. Operators may opt into aggregate counters explicitly.
router.get("/", (_req, res) => void healthResponse(res));
router.get("/healthz", (_req, res) => void healthResponse(res));

export default router;
