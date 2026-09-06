import { describe, expect, it, vi } from "vitest";
import {
  createCoalescedTextScheduler,
  STREAM_RENDER_BATCH_MS,
} from "./coalesced-text-scheduler";

describe("coalesced streamed text scheduler", () => {
  it("publishes only the latest delta snapshot per render interval", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const scheduler = createCoalescedTextScheduler(onFlush);

    scheduler.push("a");
    scheduler.push("ab");
    scheduler.push("abc");

    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(STREAM_RENDER_BATCH_MS - 1);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenLastCalledWith("abc");

    scheduler.push("abcd");
    scheduler.flush();
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush).toHaveBeenLastCalledWith("abcd");

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("does not publish queued text after clear or dispose", () => {
    vi.useFakeTimers();
    const onFlush = vi.fn();
    const scheduler = createCoalescedTextScheduler(onFlush);

    scheduler.push("discarded");
    scheduler.clear();
    vi.advanceTimersByTime(STREAM_RENDER_BATCH_MS);
    expect(onFlush).not.toHaveBeenCalled();

    scheduler.push("also discarded");
    scheduler.dispose();
    vi.advanceTimersByTime(STREAM_RENDER_BATCH_MS);
    expect(onFlush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
