import { describe, expect, it, vi } from "vitest";
import {
  createStartupReadiness,
  requireStartupReadiness,
} from "./startup-readiness";

describe("startup readiness", () => {
  it("starts not ready and can transition between states", () => {
    const readiness = createStartupReadiness();

    expect(readiness.isReady()).toBe(false);
    readiness.markReady();
    expect(readiness.isReady()).toBe(true);
    readiness.markNotReady();
    expect(readiness.isReady()).toBe(false);
  });

  it("returns 503 before startup completes", () => {
    const readiness = createStartupReadiness();
    const next = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    requireStartupReadiness({} as never, response as never, next, readiness);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({
      status: "starting",
      detail: "Service is still starting",
    });
    expect(next).not.toHaveBeenCalled();
  });

  it("passes requests after startup completes", () => {
    const readiness = createStartupReadiness();
    readiness.markReady();
    const next = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };

    requireStartupReadiness({} as never, response as never, next, readiness);

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).not.toHaveBeenCalled();
  });
});