import { purgeExpiredMemoryBatch } from "./llm-memory-store";
import { logger } from "./logger";

/** Start only after schema readiness; drain the in-flight batch before closing PostgreSQL. */
export function startMemoryWorker(intervalMs = 60_000): {
  close(): Promise<void>;
} {
  let running: Promise<void> | undefined;
  const tick = () => {
    if (running) return;
    running = purgeExpiredMemoryBatch()
      .then(() => undefined)
      .catch(() => {
        logger.warn(
          { component: "memory-worker" },
          "Memory retention cleanup failed; retrying next interval",
        );
      })
      .finally(() => {
        running = undefined;
      });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  tick();
  return {
    async close() {
      clearInterval(timer);
      await running;
    },
  };
}
