import { afterEach, describe, expect, it, vi } from "vitest";
import { isProviderFrozen } from "./provider-policy";
import { getAlibabaSpecialistConfig } from "./alibaba-specialist-config";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("provider freeze configuration", () => {
  it("disables Alibaba media credentials even with a separate specialist key", () => {
    expect(
      getAlibabaSpecialistConfig({
        DISABLE_DASHSCOPE_MODELS: " true ",
        ALIBABA_SPECIALIST_API_KEY: "regular-test-key",
      }),
    ).toBeNull();
    expect(
      isProviderFrozen("openrouter", {
        DISABLE_OPENAI_MODELS: "true",
        DISABLE_DASHSCOPE_MODELS: "true",
      }),
    ).toBe(false);
  });

  it("boots with MiMo alone when OpenAI is frozen and its credentials are removed", async () => {
    vi.resetModules();
    vi.stubEnv("DISABLE_OPENAI_MODELS", "true");
    vi.stubEnv("DISABLE_DASHSCOPE_MODELS", "true");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_API_KEY", "");
    vi.stubEnv("AI_INTEGRATIONS_OPENAI_BASE_URL", "");
    vi.stubEnv("Xiaomi_Mimo_KEY", "  primary-test-key  ");
    vi.stubEnv("XIAOMI_API_KEY", "fallback-test-key");
    vi.stubEnv("XIAOMI_BASE_URL", " ");
    const clients = await import("./ai-clients");
    expect(clients.openaiClient).toBeNull();
    expect(clients.xiaomiClient?.apiKey).toBe("primary-test-key");
    expect(clients.xiaomiClient?.baseURL).toBe(
      "https://token-plan-sgp.xiaomimimo.com/v1",
    );
    expect(clients.getClientForModel("mimo-v2.5-pro").provider).toBe("xiaomi");
    expect(() => clients.getClientForModel("gpt-5.6-terra")).toThrow(/凍結/);
  });

  it("uses the alternate MiMo key when the primary value is whitespace", async () => {
    vi.resetModules();
    vi.stubEnv("Xiaomi_Mimo_KEY", " ");
    vi.stubEnv("XIAOMI_API_KEY", " alternate-test-key ");
    const { xiaomiClient } = await import("./ai-clients");
    expect(xiaomiClient?.apiKey).toBe("alternate-test-key");
  });
});
