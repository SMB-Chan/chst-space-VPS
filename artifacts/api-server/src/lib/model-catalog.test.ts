import { afterEach, describe, expect, it } from "vitest";
import { AVAILABLE_MODELS } from "./ai-clients";
import {
  getCatalogModels,
  getCatalogProviders,
  getCuratedBuiltinChatModels,
  getCustomChatModels,
  refreshModelCatalog,
  resetModelCatalogForTests,
  seedModelCatalog,
} from "./model-catalog";
import {
  findCatalogModel,
  isCatalogModelUsable,
  isCatalogProviderEnabled,
} from "./model-registry";
import { isModelAllowedForRole } from "./specialist-capabilities";

const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

afterEach(() => {
  resetModelCatalogForTests();
});

describe("model catalog fallback (no DB refresh)", () => {
  it("exposes every built-in provider", () => {
    expect(
      getCatalogProviders()
        .map((p) => p.id)
        .sort(),
    ).toEqual(["dashscope", "openai", "openrouter", "xiaomi"].sort());
  });

  it("exposes every AVAILABLE_MODELS entry with openrouter-only user visibility", () => {
    const models = getCatalogModels();
    const ids = new Set(models.map((m) => m.id));
    for (const model of AVAILABLE_MODELS) expect(ids.has(model.id)).toBe(true);
    for (const model of models) {
      expect(model.userVisible).toBe(model.providerId === "openrouter");
    }
  });

  it("treats unknown providers as enabled until the catalog loads", () => {
    expect(isCatalogProviderEnabled("openai")).toBe(true);
    expect(isCatalogProviderEnabled("custom-foo")).toBe(true);
    expect(isCatalogModelUsable("gpt-5.6-terra")).toBe(true);
  });

  it("findCatalogModel returns null until the registry is loaded", () => {
    expect(findCatalogModel("gpt-5.6-terra")).toBeNull();
  });

  it("isModelAllowedForRole keeps the openrouter-only policy without a registry", () => {
    expect(
      isModelAllowedForRole(
        { id: "gpt-5.6-terra", provider: "openai" },
        "admin",
      ),
    ).toBe(true);
    expect(
      isModelAllowedForRole(
        { id: "gpt-5.6-terra", provider: "openai" },
        "user",
      ),
    ).toBe(false);
    expect(
      isModelAllowedForRole(
        { id: "qwen/qwen3.7-flash", provider: "openrouter" },
        "user",
      ),
    ).toBe(true);
  });

  it("curated chat models equal AVAILABLE_MODELS before refresh", () => {
    expect(getCuratedBuiltinChatModels().map((m) => m.id)).toEqual(
      AVAILABLE_MODELS.map((m) => m.id),
    );
    expect(getCustomChatModels()).toEqual([]);
  });
});

describeDb("model catalog with a live database", () => {
  it("seeds, refreshes, and respects user visibility from the registry", async () => {
    await seedModelCatalog();
    await refreshModelCatalog();
    expect(getCatalogProviders().length).toBeGreaterThanOrEqual(4);
    const terra = findCatalogModel("gpt-5.6-terra");
    expect(terra).not.toBeNull();
    expect(terra?.userVisible).toBe(false);
    expect(
      isModelAllowedForRole(
        { id: "gpt-5.6-terra", provider: "openai" },
        "user",
      ),
    ).toBe(false);
    const orModel = getCatalogModels().find(
      (m) => m.providerId === "openrouter",
    );
    expect(orModel?.userVisible).toBe(true);
    expect(
      isModelAllowedForRole(
        { id: orModel!.id, provider: "openrouter" },
        "user",
      ),
    ).toBe(true);
  });
});
