import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

function healthResponse(res: Parameters<Parameters<IRouter["get"]>[1]>[1]): void {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
}

// Root API health check used by some deployment platforms.
router.get("/", (_req, res) => healthResponse(res));
router.get("/healthz", (_req, res) => healthResponse(res));

export default router;
