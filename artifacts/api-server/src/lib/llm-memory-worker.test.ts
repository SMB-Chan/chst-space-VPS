import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ purge: vi.fn() }));
vi.mock("./llm-memory-store", () => ({ purgeExpiredMemoryBatch: mocks.purge }));
import { startMemoryWorker } from "./llm-memory-worker";
describe("memory retention worker", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });
  it("does not overlap batches and waits for cleanup before shutdown", async () => {
    vi.useFakeTimers();
    let resolve!: (value: number) => void;
    mocks.purge.mockImplementation(
      () =>
        new Promise<number>((done) => {
          resolve = done;
        }),
    );
    const worker = startMemoryWorker(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.purge).toHaveBeenCalledTimes(1);
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resolve(1);
    await closing;
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.purge).toHaveBeenCalledTimes(1);
  });
  it("retries a failed batch on the next interval", async () => {
    vi.useFakeTimers();
    mocks.purge
      .mockRejectedValueOnce(new Error("database down"))
      .mockResolvedValue(0);
    const worker = startMemoryWorker(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.purge).toHaveBeenCalledTimes(2);
    await worker.close();
  });
});
