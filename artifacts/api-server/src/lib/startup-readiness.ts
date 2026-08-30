import type { NextFunction, Request, Response } from "express";

export interface StartupReadiness {
  isReady(): boolean;
  markReady(): void;
  markNotReady(): void;
}

export function createStartupReadiness(): StartupReadiness {
  let ready = false;

  return {
    isReady: () => ready,
    markReady: () => {
      ready = true;
    },
    markNotReady: () => {
      ready = false;
    },
  };
}

export const startupReadiness = createStartupReadiness();

export function requireStartupReadiness(
  _req: Request,
  res: Response,
  next: NextFunction,
  readiness: StartupReadiness = startupReadiness,
): void {
  if (readiness.isReady()) {
    next();
    return;
  }

  res.status(503).json({
    status: "starting",
    detail: "Service is still starting",
  });
}