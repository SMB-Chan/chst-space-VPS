import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clients, dashScopeList, openAiList, openRouterList, budgetState } =
  vi.hoisted(() => {
    const dashScopeList = vi.fn();
    const openAiList = vi.fn();
    const openRouterList = vi.fn();
    const budgetState = { over: false };
    const clients: {
      dashscopeClient: unknown;
      openaiClient: unknown;
      openrouterClient: unknown;
    } = {
      dashscopeClient: { models: { list: dashScopeList } },
      openaiClient: { models: { list: openAiList } },
      openrouterClient: { models: { list: openRouterList } },
    };
    return {
      clients,
      dashScopeList,
      openAiList,
      openRouterList,
      budgetState,
    };
  });

vi.mock("./ai-clients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ai-clients")>();
  return {
    ...actual,
    get dashscopeClient() {
      return clients.dashscopeClient;
    },
    get openaiClient() {
      return clients.openaiClient;
    },
    get openrouterClient() {
      return clients.openrouterClient;
    },
  };
});

vi.mock("./openrouter-budget", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openrouter-budget")>();
  return {
    ...actual,
    isOpenRouterOverBudget: async () => budgetState.over,
    openRouterConfigured: () => true,
  };
});

import {
  getAvailableChatModels,
  mergeAvailableChatModels,
  resetModelDiscoveryCache,
} from "./specialist-capabilities";

const modelList = (...ids: string[]) => ({
  data: ids.map((id) => ({ id })),
});

describe("dynamic chat model discovery", () => {
  beforeEach(() => {
    resetModelDiscoveryCache();
    dashScopeList.mockReset();
    openAiList.mockReset();
    openRouterList.mockReset();
    budgetState.over = false;
    clients.dashscopeClient = { models: { list: dashScopeList } };
    clients.openaiClient = { models: { list: openAiList } };
    clients.openrouterClient = { models: { list: openRouterList } };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps provider source when a model name resembles another provider", () => {
    const models = mergeAvailableChatModels([
      {
        provider: "dashscope",
        ids: new Set(["gpt-mirrored-by-dashscope", "qwen3.8-max"]),
      },
      {
        provider: "openai",
        ids: new Set(["qwen-mirrored-by-openai", "gpt-5.6-terra"]),
      },
      {
        provider: "openrouter",
        ids: new Set([
          "deepseek-mirrored-by-openrouter",
          "deepseek/deepseek-chat",
        ]),
      },
    ]);

    expect(
      models.find((model) => model.id === "gpt-mirrored-by-dashscope"),
    ).toMatchObject({
      provider: "dashscope",
    });
    expect(
      models.find((model) => model.id === "qwen-mirrored-by-openai"),
    ).toMatchObject({
      provider: "openai",
    });
    expect(
      models.find((model) => model.id === "deepseek-mirrored-by-openrouter"),
    ).toMatchObject({
      provider: "openrouter",
    });
    expect(models.filter((model) => model.id === "qwen3.8-max")).toHaveLength(
      1,
    );
    expect(models.find((model) => model.id === "qwen3.8-max")?.provider).toBe(
      "dashscope",
    );
    expect(
      models.find((model) => model.id === "deepseek/deepseek-chat")?.provider,
    ).toBe("openrouter");
    expect(models.find((model) => model.id === "o4-mini")).toBeUndefined();
  });

  it("uses a deterministic first-source policy for an unknown id collision", () => {
    const models = mergeAvailableChatModels([
      { provider: "dashscope", ids: new Set(["qwen-collision"]) },
      { provider: "openai", ids: new Set(["qwen-collision"]) },
    ]);

    expect(models.filter((model) => model.id === "qwen-collision")).toEqual([
      expect.objectContaining({ provider: "dashscope" }),
    ]);
  });

  it("filters static models only for providers with successful discovery", async () => {
    dashScopeList.mockResolvedValue(modelList("qwen3.8-max"));
    openAiList.mockResolvedValue(modelList("gpt-5.6-terra"));

    const models = await getAvailableChatModels();

    // OpenRouter keeps its full curated catalog: discovery is disabled.
    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-terra",
      "qwen3.8-max",
      "z-ai/glm-5.3-flash",
      "google/gemini-2.5-flash-lite",
      "openai/gpt-4o-mini",
      "deepseek/deepseek-chat",
      "qwen/qwen3-235b-a22b-thinking-2507",
    ]);
    expect(
      models.every(
        (model) =>
          model.provider ===
          (model.id === "gpt-5.6-terra"
            ? "openai"
            : model.id === "qwen3.8-max"
              ? "dashscope"
              : "openrouter"),
      ),
    ).toBe(true);
  });

  it("keeps each provider static catalog when its discovery is unavailable", async () => {
    dashScopeList.mockRejectedValue(new Error("provider failure"));
    openAiList.mockResolvedValue(modelList("gpt-5.6-terra"));
    openRouterList.mockRejectedValue(new Error("provider failure"));

    const models = await getAvailableChatModels();
    const ids = new Set(models.map((model) => model.id));

    expect(ids).toEqual(
      new Set([
        "gpt-5.6-terra",
        "qwen3.8-max",
        "qwen3.8-flash",
        "qwen3.7-plus",
        "qwen3.7-max",
        "qwen3.6-flash",
        "deepseek-v4-pro-0813",
        "deepseek-v4-pro",
        "deepseek-v4-flash-0731",
        "glm-5.2",
        "z-ai/glm-5.3-flash",
        "google/gemini-2.5-flash-lite",
        "openai/gpt-4o-mini",
        "deepseek/deepseek-chat",
        "qwen/qwen3-235b-a22b-thinking-2507",
      ]),
    );
  });

  it("hides OpenRouter models once the budget is spent", async () => {
    dashScopeList.mockRejectedValue(new Error("provider failure"));
    openAiList.mockResolvedValue(modelList("gpt-5.6-terra"));
    openRouterList.mockResolvedValue(modelList("google/gemini-2.5-flash-lite"));
    budgetState.over = true;

    const models = await getAvailableChatModels();
    const ids = new Set(models.map((model) => model.id));

    expect(ids.has("google/gemini-2.5-flash-lite")).toBe(false);
    expect(ids.has("openai/gpt-4o-mini")).toBe(false);
    expect(ids.has("gpt-5.6-terra")).toBe(true);
  });

  it("treats empty and malformed provider lists as unavailable", async () => {
    dashScopeList.mockResolvedValue({ data: [{ id: 123 }] });
    openAiList.mockResolvedValue({ data: [] });
    openRouterList.mockResolvedValue({ data: [] });

    const models = await getAvailableChatModels();

    expect(models).toHaveLength(17);
    expect(models.some((model) => model.id === "gpt-5.6-terra")).toBe(true);
    expect(models.some((model) => model.id === "qwen3.8-max")).toBe(true);
    expect(
      models.some((model) => model.id === "google/gemini-2.5-flash-lite"),
    ).toBe(true);
    expect(models.some((model) => model.id === "z-ai/glm-5.3-flash")).toBe(
      true,
    );
  });

  it("does not query or remove catalogs when provider clients are unavailable", async () => {
    clients.dashscopeClient = null;
    clients.openaiClient = null;
    clients.openrouterClient = null;

    const models = await getAvailableChatModels();

    expect(models).toHaveLength(17);
    expect(dashScopeList).not.toHaveBeenCalled();
    expect(openAiList).not.toHaveBeenCalled();
    expect(openRouterList).not.toHaveBeenCalled();
  });

  it("caches successful results independently for each provider", async () => {
    dashScopeList.mockResolvedValue(modelList("qwen-dynamic"));
    openAiList.mockResolvedValue(modelList("gpt-dynamic"));

    await getAvailableChatModels();
    await getAvailableChatModels();

    expect(dashScopeList).toHaveBeenCalledTimes(1);
    expect(openAiList).toHaveBeenCalledTimes(1);
    // OpenRouter discovery is disabled; only the catalog is offered.
    expect(openRouterList).not.toHaveBeenCalled();
  });

  it("caches timeout failures briefly and falls back without exposing the error", async () => {
    vi.useFakeTimers();
    clients.dashscopeClient = null;
    clients.openrouterClient = null;
    openAiList.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    const pending = getAvailableChatModels();
    await vi.advanceTimersByTimeAsync(5_000);
    const models = await pending;
    await getAvailableChatModels();

    expect(models).toHaveLength(17);
    expect(openAiList).toHaveBeenCalledTimes(1);
  });
});
