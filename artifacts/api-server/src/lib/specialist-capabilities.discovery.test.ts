import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clients, dashScopeList, openAiList } = vi.hoisted(() => {
  const dashScopeList = vi.fn();
  const openAiList = vi.fn();
  const clients: {
    dashscopeClient: unknown;
    openaiClient: unknown;
  } = {
    dashscopeClient: { models: { list: dashScopeList } },
    openaiClient: { models: { list: openAiList } },
  };
  return { clients, dashScopeList, openAiList };
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
    clients.dashscopeClient = { models: { list: dashScopeList } };
    clients.openaiClient = { models: { list: openAiList } };
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
    expect(models.filter((model) => model.id === "qwen3.8-max")).toHaveLength(
      1,
    );
    expect(models.find((model) => model.id === "qwen3.8-max")?.provider).toBe(
      "dashscope",
    );
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

    expect(models.map((model) => model.id)).toEqual([
      "gpt-5.6-terra",
      "qwen3.8-max",
    ]);
    expect(
      models.every(
        (model) =>
          model.provider ===
          (model.id === "gpt-5.6-terra" ? "openai" : "dashscope"),
      ),
    ).toBe(true);
  });

  it("keeps each provider static catalog when its discovery is unavailable", async () => {
    dashScopeList.mockRejectedValue(new Error("provider failure"));
    openAiList.mockResolvedValue(modelList("gpt-5.6-terra"));

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
      ]),
    );
  });

  it("treats empty and malformed provider lists as unavailable", async () => {
    dashScopeList.mockResolvedValue({ data: [{ id: 123 }] });
    openAiList.mockResolvedValue({ data: [] });

    const models = await getAvailableChatModels();

    expect(models).toHaveLength(12);
    expect(models.some((model) => model.id === "gpt-5.6-terra")).toBe(true);
    expect(models.some((model) => model.id === "qwen3.8-max")).toBe(true);
  });

  it("does not query or remove catalogs when provider clients are unavailable", async () => {
    clients.dashscopeClient = null;
    clients.openaiClient = null;

    const models = await getAvailableChatModels();

    expect(models).toHaveLength(12);
    expect(dashScopeList).not.toHaveBeenCalled();
    expect(openAiList).not.toHaveBeenCalled();
  });

  it("caches successful results independently for each provider", async () => {
    dashScopeList.mockResolvedValue(modelList("qwen-dynamic"));
    openAiList.mockResolvedValue(modelList("gpt-dynamic"));

    await getAvailableChatModels();
    await getAvailableChatModels();

    expect(dashScopeList).toHaveBeenCalledTimes(1);
    expect(openAiList).toHaveBeenCalledTimes(1);
  });

  it("caches timeout failures briefly and falls back without exposing the error", async () => {
    vi.useFakeTimers();
    clients.dashscopeClient = null;
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

    expect(models).toHaveLength(12);
    expect(openAiList).toHaveBeenCalledTimes(1);
  });
});
