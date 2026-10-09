import { describe, expect, it } from "vitest";
import { providerKeyStatusLabel } from "./provider-key-status";
import type { AdminProvider } from "./admin-api";

function provider(overrides: Partial<AdminProvider>): AdminProvider {
  return {
    id: "x",
    label: "X",
    kind: "custom",
    baseUrl: null,
    enabled: true,
    hasKey: false,
    keyHint: null,
    configured: false,
    useEnvKey: true,
    envKeyPresent: false,
    keySource: "none",
    deleted: false,
    modelCount: 0,
    ...overrides,
  };
}

describe("providerKeyStatusLabel", () => {
  it("shows the DB hint suffix when the key was set in the admin UI", () => {
    expect(
      providerKeyStatusLabel(
        provider({ keySource: "db", hasKey: true, keyHint: "…abcd" }),
      ),
    ).toBe("管理画面で設定 (…abcd)");
  });

  it("falls back to a plain label when the DB key has no hint yet", () => {
    expect(
      providerKeyStatusLabel(
        provider({ keySource: "db", hasKey: true, keyHint: null }),
      ),
    ).toBe("管理画面で設定");
  });

  it("labels env-var-only built-ins as サーバー環境変数", () => {
    expect(
      providerKeyStatusLabel(
        provider({
          kind: "builtin",
          keySource: "env",
          useEnvKey: true,
          envKeyPresent: true,
        }),
      ),
    ).toBe("サーバー環境変数");
  });

  it("labels built-ins whose env key is present but disabled as 環境変数（未使用）", () => {
    expect(
      providerKeyStatusLabel(
        provider({
          kind: "builtin",
          keySource: "none",
          useEnvKey: false,
          envKeyPresent: true,
        }),
      ),
    ).toBe("環境変数（未使用）");
  });

  it("does not label custom providers with the env-unused wording", () => {
    expect(
      providerKeyStatusLabel(
        provider({
          kind: "custom",
          keySource: "none",
          useEnvKey: false,
          envKeyPresent: true,
        }),
      ),
    ).toBe("未設定");
  });

  it("does not label built-ins without an env key as env-unused", () => {
    expect(
      providerKeyStatusLabel(
        provider({
          kind: "builtin",
          keySource: "none",
          useEnvKey: false,
          envKeyPresent: false,
        }),
      ),
    ).toBe("未設定");
  });

  it("falls back to 未設定 for unconfigured providers", () => {
    expect(providerKeyStatusLabel(provider({ keySource: "none" }))).toBe(
      "未設定",
    );
  });
});
