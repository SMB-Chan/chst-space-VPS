import { describe, expect, it, vi } from "vitest";
import {
  createGracefulShutdown,
  type ShutdownLogger,
} from "./graceful-shutdown";

function testLogger(): ShutdownLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("createGracefulShutdown", () => {
  it("drains HTTP, closes resources, and is idempotent", async () => {
    const close = vi.fn((callback: (error?: Error) => void) => {
      callback();
      return undefined as never;
    });
    const closeAllConnections = vi.fn();
    const closeBrowser = vi.fn(async () => undefined);
    const closePool = vi.fn(async () => undefined);
    const setExitCode = vi.fn();

    const shutdown = createGracefulShutdown({
      server: { close, closeAllConnections },
      resources: [
        { name: "browser", close: closeBrowser },
        { name: "postgres", close: closePool },
      ],
      logger: testLogger(),
      graceMs: 50,
      setExitCode,
    });

    const first = shutdown("SIGTERM");
    const second = shutdown("SIGINT");
    expect(second).toBe(first);
    await first;

    expect(close).toHaveBeenCalledOnce();
    expect(closeAllConnections).not.toHaveBeenCalled();
    expect(closeBrowser).toHaveBeenCalledOnce();
    expect(closePool).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(0);
  });

  it("forces remaining HTTP connections closed after the grace period", async () => {
    const close = vi.fn(
      (_callback: (error?: Error) => void) => undefined as never,
    );
    const closeAllConnections = vi.fn();
    const closeResource = vi.fn(async () => undefined);

    const shutdown = createGracefulShutdown({
      server: { close, closeAllConnections },
      resources: [{ name: "resource", close: closeResource }],
      logger: testLogger(),
      graceMs: 1,
      setExitCode: vi.fn(),
    });

    await shutdown("SIGTERM");
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(closeResource).toHaveBeenCalledOnce();
  });

  it("records a failing resource close without skipping other resources", async () => {
    const close = vi.fn((callback: (error?: Error) => void) => {
      callback();
      return undefined as never;
    });
    const first = vi.fn(async () => {
      throw new Error("browser close failed");
    });
    const second = vi.fn(async () => undefined);
    const setExitCode = vi.fn();
    const logger = testLogger();

    const shutdown = createGracefulShutdown({
      server: { close, closeAllConnections: vi.fn() },
      resources: [
        { name: "browser", close: first },
        { name: "postgres", close: second },
      ],
      logger,
      setExitCode,
    });

    await shutdown("SIGINT");
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalled();
  });
});
