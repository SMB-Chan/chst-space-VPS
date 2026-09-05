import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  storeMemory: vi.fn(),
  updateMemory: vi.fn(),
  invalidateMemory: vi.fn(),
}));
vi.mock("./llm-memory-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./llm-memory-store")>()),
  ...mocks,
}));
import {
  executeMemoryTool,
  getMemoryToolDefinitions,
  isMemoryTool,
} from "./llm-memory-tools";
const call = (name: string, args: unknown) => ({
  id: "call",
  name,
  arguments: JSON.stringify(args),
});
const context = { memoryEnabled: true, userId: "owner" };
describe("shared memory tools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("does not mutate during private sessions or accept missing revision guards", async () => {
    expect(
      (
        await executeMemoryTool(
          call("memory_store", { topic: "x", content: "x" }),
          { memoryEnabled: false, userId: "owner" },
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await executeMemoryTool(
          call("memory_update", { id: "x", content: "x" }),
          context,
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await executeMemoryTool(
          call("memory_invalidate", { id: "x", reason: "incorrect" }),
          context,
        )
      ).ok,
    ).toBe(false);
    expect(mocks.storeMemory).not.toHaveBeenCalled();
    expect(mocks.updateMemory).not.toHaveBeenCalled();
    expect(mocks.invalidateMemory).not.toHaveBeenCalled();
  });
  it("exposes provenance, validity and invalidation to every tool-enabled model", () => {
    const definitions = getMemoryToolDefinitions();
    expect(definitions.every((tool) => isMemoryTool(tool.function.name))).toBe(
      true,
    );
    const schema = definitions.find(
      (tool) => tool.function.name === "memory_store",
    )!.function.parameters as { properties: Record<string, unknown> };
    for (const name of [
      "kind",
      "category",
      "source_url",
      "valid_as_of",
      "expires_at",
    ])
      expect(schema.properties).toHaveProperty(name);
  });
  it("passes the authenticated owner and revision to invalidation", async () => {
    mocks.invalidateMemory.mockResolvedValue(true);
    const result = await executeMemoryTool(
      call("memory_invalidate", {
        id: "mem-1",
        reason: "incorrect",
        expected_revision: 3,
      }),
      context,
    );
    expect(result.ok).toBe(true);
    expect(mocks.invalidateMemory).toHaveBeenCalledWith(
      "owner",
      "mem-1",
      "incorrect",
      3,
    );
  });
});
