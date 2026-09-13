import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  start: vi.fn(),
  settle: vi.fn(),
  finish: vi.fn(),
  owns: vi.fn(),
}));

vi.mock("@clerk/express", () => ({
  getAuth: () => { throw new Error("Clerk middleware is absent"); },
}));
vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn() },
  safeFailureFields: vi.fn(() => ({})),
}));
vi.mock("../lib/run-execution", () => ({
  createRunExecutionContext: mocks.create,
  withRunExecutionContext: (_context: unknown, callback: () => void) => callback(),
}));
vi.mock("@workspace/db", () => ({
  conversations: { id: "id", userId: "user_id" },
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.owns }) }) }) },
}));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));

import { chatRunTrackingMiddleware } from "./chatRunTrackingMiddleware";

describe("chat run tracking after authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue({
      startStep: mocks.start,
      settleStep: mocks.settle,
      finish: mocks.finish,
    });
    mocks.start.mockResolvedValue({ id: "step" });
    mocks.settle.mockResolvedValue(undefined);
    mocks.finish.mockResolvedValue(undefined);
    mocks.owns.mockResolvedValue([{ id: 42 }]);
  });

  async function invoke(userId?: string, conversationId?: string) {
    const req = {
      userId, method: "POST", body: { modelId: "test-model" },
      params: conversationId ? { conversationId } : {},
    } as unknown as Request;
    const res = Object.assign(new EventEmitter(), { statusCode: 200, writableEnded: true });
    const next = vi.fn();
    await chatRunTrackingMiddleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    return res;
  }

  it.each(["local-user", "user_clerk"])('tracks the authenticated identity %s without calling Clerk', async (userId) => {
    const res = await invoke(userId, "42");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ userId, conversationId: 42 }));
    res.emit("finish");
    await vi.waitFor(() => expect(mocks.finish).toHaveBeenCalledWith("completed", { errorCode: null }));
  });

  it("tracks ephemeral requests using the resolved identity", async () => {
    await invoke("local-user");
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ userId: "local-user", conversationId: null }));
  });

  it("skips requests without an authenticated identity", async () => {
    await invoke();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not track a conversation owned by another user", async () => {
    mocks.owns.mockResolvedValue([]);
    await invoke("local-user", "42");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("continues chat when tracking storage fails", async () => {
    mocks.create.mockRejectedValueOnce(new Error("storage unavailable"));
    await invoke("local-user", "42");
  });
});
