export const STREAM_RENDER_BATCH_MS = 32;

type TimerHandle = ReturnType<typeof setTimeout>;
type Schedule = (callback: () => void, delay: number) => TimerHandle;
type Cancel = (handle: TimerHandle) => void;

export interface CoalescedTextScheduler {
  push(value: string): void;
  flush(): void;
  clear(): void;
  dispose(): void;
}

/**
 * Keeps the latest streamed value and publishes it at most once per short
 * interval. The producer can still receive every delta; React and Markdown
 * only see the coalesced snapshots.
 */
export function createCoalescedTextScheduler(
  onFlush: (value: string) => void,
  schedule: Schedule = setTimeout,
  cancel: Cancel = clearTimeout,
): CoalescedTextScheduler {
  let pending: string | null = null;
  let timer: TimerHandle | null = null;
  let disposed = false;

  const flush = () => {
    timer = null;
    if (disposed || pending === null) return;
    const next = pending;
    pending = null;
    onFlush(next);
  };

  const scheduleFlush = () => {
    if (timer !== null || disposed) return;
    timer = schedule(flush, STREAM_RENDER_BATCH_MS);
  };

  return {
    push(value) {
      if (disposed) return;
      pending = value;
      scheduleFlush();
    },
    flush() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (disposed || pending === null) return;
      const next = pending;
      pending = null;
      onFlush(next);
    },
    clear() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      pending = null;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) cancel(timer);
      timer = null;
      pending = null;
    },
  };
}
