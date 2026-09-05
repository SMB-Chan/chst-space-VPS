import { describe, expect, it } from "vitest";
import { resolveOpenRouterApiKey } from "./openrouter-config";

describe("resolveOpenRouterApiKey", () => {
  it("uses the workspace secret name first", () => {
    expect(
      resolveOpenRouterApiKey({
        OPEN_ROUTER: " current-secret ",
        OPENROUTER_API_KEY: "legacy-secret",
      }),
    ).toBe("current-secret");
  });

  it("keeps the legacy secret name as a fallback", () => {
    expect(
      resolveOpenRouterApiKey({ OPENROUTER_API_KEY: "legacy-secret" }),
    ).toBe("legacy-secret");
  });

  it("ignores blank secret values", () => {
    expect(
      resolveOpenRouterApiKey({
        OPEN_ROUTER: "  ",
        OPENROUTER_API_KEY: "\t",
      }),
    ).toBeUndefined();
  });
});