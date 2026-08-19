import type { Request } from "express";

export { requireAuth } from "../middlewares/requireAuth";

export function getUserId(req: Request): string {
  return req.userId!;
}
