import type { Server } from "node:http";

export interface ShutdownLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface ShutdownResource {
  name: string;
  close(): Promise<void>;
}

export interface GracefulShutdownOptions {
  server: Pick<Server, "close"> & Partial<Pick<Server, "closeAllConnections">>;
  resources: ShutdownResource[];
  logger: ShutdownLogger;
  graceMs?: number;
  setExitCode?: (code: number) => void;
}

const DEFAULT_GRACE_MS = 10_000;

function normalizeGraceMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_GRACE_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "Shutdown grace period must be a non-negative finite number",
    );
  }
  return Math.floor(value);
}

async function drainHttpServer(
  server: GracefulShutdownOptions["server"],
  graceMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };

    try {
      server.close((error?: Error) => {
        if (settled) return;
        if (error) {
          settled = true;
          if (timer) clearTimeout(timer);
          reject(error);
          return;
        }
        finish(true);
      });
    } catch (error) {
      reject(error);
      return;
    }

    timer = setTimeout(() => finish(false), graceMs);
    timer.unref?.();
  });
}

/**
 * Build an idempotent shutdown function. `server.close()` immediately stops
 * accepting new connections and is given a bounded period to drain existing
 * requests/SSE streams. After that period, remaining HTTP connections are
 * closed before process-scoped resources (Chromium/proxy, DB pool, etc.) are
 * released.
 */
export function createGracefulShutdown(
  options: GracefulShutdownOptions,
): (signal: string) => Promise<void> {
  const graceMs = normalizeGraceMs(options.graceMs);
  const setExitCode =
    options.setExitCode ??
    ((code: number) => {
      process.exitCode = code;
    });
  let shutdownPromise: Promise<void> | null = null;

  return (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      options.logger.info({ signal, graceMs }, "Graceful shutdown started");
      let failed = false;

      try {
        const drained = await drainHttpServer(options.server, graceMs);
        if (!drained) {
          options.logger.warn(
            { signal, graceMs },
            "HTTP shutdown grace period expired; closing remaining connections",
          );
          options.server.closeAllConnections?.();
        }
      } catch (error) {
        failed = true;
        options.logger.error(
          { err: error, signal },
          "Failed while draining HTTP server",
        );
        options.server.closeAllConnections?.();
      }

      const results = await Promise.allSettled(
        options.resources.map(async (resource) => {
          await resource.close();
          return resource.name;
        }),
      );

      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        const resource = options.resources[index];
        if (result?.status === "rejected") {
          failed = true;
          options.logger.error(
            { err: result.reason, resource: resource?.name, signal },
            "Failed to close shutdown resource",
          );
        }
      }

      setExitCode(failed ? 1 : 0);
      options.logger.info(
        { signal, failed, resources: options.resources.length },
        "Graceful shutdown complete",
      );
    })();

    return shutdownPromise;
  };
}
