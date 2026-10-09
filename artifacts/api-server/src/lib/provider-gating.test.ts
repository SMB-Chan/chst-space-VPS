import { afterEach, describe, expect, it } from "vitest";
import { getAlibabaSpecialistConfig } from "./alibaba-specialist-config";
import {
  isBuiltinEnvKeyAllowed,
  isBuiltinEnvUsable,
  isBuiltinProviderActive,
  setCatalogSnapshot,
  type CatalogProvider,
} from "./model-registry";

function provider(overrides: Partial<CatalogProvider>): CatalogProvider {
  return {
    id: "dashscope",
    label: "DashScope (Qwen)",
    kind: "builtin",
    baseUrl: null,
    enabled: true,
    hasKey: false,
    keyHint: null,
    useEnvKey: true,
    deleted: false,
    apiKey: null,
    updatedAt: new Date(0),
    ...overrides,
  };
}

function useProvider(overrides: Partial<CatalogProvider>): void {
  const row = provider(overrides);
  setCatalogSnapshot({
    providers: new Map([[row.id, row]]),
    models: new Map(),
    customClients: new Map(),
  });
}

const env = {
  DASHSCOPE_API_KEY: "sk-regular-test-key",
} as unknown as NodeJS.ProcessEnv;

describe("built-in provider gating for env-backed direct uses", () => {
  afterEach(() => setCatalogSnapshot(null));

  it("treats an unloaded catalog as active with the env key allowed", () => {
    setCatalogSnapshot(null);
    expect(isBuiltinEnvUsable("dashscope")).toBe(true);
    expect(getAlibabaSpecialistConfig(env)).not.toBeNull();
  });

  it("keeps working when the provider is enabled and the env key allowed", () => {
    useProvider({});
    expect(getAlibabaSpecialistConfig(env)).not.toBeNull();
  });

  it("blocks the env key when the provider is disabled", () => {
    useProvider({ enabled: false });
    expect(isBuiltinProviderActive("dashscope")).toBe(false);
    expect(getAlibabaSpecialistConfig(env)).toBeNull();
  });

  it("blocks the env key when the provider is soft-deleted", () => {
    useProvider({ deleted: true });
    expect(isBuiltinEnvUsable("dashscope")).toBe(false);
    expect(getAlibabaSpecialistConfig(env)).toBeNull();
  });

  it("blocks the env key after キーを解除 (use_env_key=false)", () => {
    useProvider({ useEnvKey: false });
    expect(isBuiltinProviderActive("dashscope")).toBe(true);
    expect(isBuiltinEnvKeyAllowed("dashscope")).toBe(false);
    expect(getAlibabaSpecialistConfig(env)).toBeNull();
  });
});
