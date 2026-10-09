import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  vision: new Set<string>(),
  usable: new Set<string>(),
  catalog: new Map<string, { providerId: string }>(),
  providers: new Map<string, { kind: "custom" | "builtin" }>(),
}));

vi.mock("./ai-clients", () => ({
  AVAILABLE_MODELS: [{ id: "qwen3.6-flash" }, { id: "gpt-5.6-luna" }],
  applyGenerationParams: vi.fn(),
  getModelLabel: (id: string) => id,
  modelSupportsVision: (id: string) => state.vision.has(id),
  getClientForModel: (id: string) => {
    if (!state.usable.has(id)) throw new Error("not configured");
    return { client: {}, provider: "custom" };
  },
}));

vi.mock("./model-registry", () => ({
  findCatalogModel: (id: string) => state.catalog.get(id) ?? null,
  findCatalogProvider: (id: string) => state.providers.get(id) ?? null,
  isCatalogModelUsable: (id: string) => state.usable.has(id),
}));

const { resolveImageDescribeModel } = await import("./project-images");

describe("resolveImageDescribeModel", () => {
  beforeEach(() => {
    state.vision.clear();
    state.usable.clear();
    state.catalog.clear();
    state.providers.clear();
    delete process.env.PROJECT_IMAGE_DESCRIBE_MODEL;
    delete process.env.PROJECT_IMAGE_ADMIN_DESCRIBE_MODEL;
    delete process.env.VISION_BRIDGE_MODEL;
    state.providers.set("minimax", { kind: "custom" });
    state.catalog.set("MiniMax-M3", { providerId: "minimax" });
  });

  it("uses MiniMax-M3 only for the admin when no built-in vision model works", () => {
    state.usable.add("MiniMax-M3");
    expect(resolveImageDescribeModel("admin")).toBe("MiniMax-M3");
    expect(resolveImageDescribeModel("user")).toBeNull();
  });

  it("never gives other users a custom-provider model, even if flagged vision", () => {
    state.usable.add("MiniMax-M3");
    state.vision.add("MiniMax-M3");
    expect(resolveImageDescribeModel("user")).toBeNull();
    expect(resolveImageDescribeModel("admin")).toBe("MiniMax-M3");
  });

  it("prefers a usable built-in vision model for everyone", () => {
    state.usable.add("MiniMax-M3");
    state.vision.add("qwen3.6-flash");
    state.usable.add("qwen3.6-flash");
    expect(resolveImageDescribeModel("user")).toBe("qwen3.6-flash");
    expect(resolveImageDescribeModel("admin")).toBe("qwen3.6-flash");
  });

  it("returns null for the admin when MiniMax is disabled", () => {
    expect(resolveImageDescribeModel("admin")).toBeNull();
  });

  it("ignores an unknown admin override id", () => {
    process.env.PROJECT_IMAGE_ADMIN_DESCRIBE_MODEL = "made-up-model";
    state.usable.add("made-up-model");
    expect(resolveImageDescribeModel("admin")).toBeNull();
  });
});
