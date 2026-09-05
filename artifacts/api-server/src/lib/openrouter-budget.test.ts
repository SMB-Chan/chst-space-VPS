import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOpenRouterKeyState,
  isOpenRouterOverBudget,
  openRouterConfigured,
  resetOpenRouterBudgetCache,
  resolveMonthlyBudgetUsd,
} from "./openrouter-budget";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("openrouter-budget", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    vi.unstubAllEnvs();
    vi.stubEnv("OPEN_ROUTER", "");
    vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
    delete process.env.OPENROUTER_MONTHLY_BUDGET_USD;
    fetchMock.mockReset();
    resetOpenRouterBudgetCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetOpenRouterBudgetCache();
  });

  it("reports unconfigured without a key", async () => {
    vi.stubEnv("OPEN_ROUTER", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    expect(openRouterConfigured()).toBe(false);
    expect(await isOpenRouterOverBudget()).toBe(false);
    expect(await getOpenRouterKeyState()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hides models only near the key spend limit", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { usage: 2, limit: 5 } }));
    expect(await isOpenRouterOverBudget()).toBe(false);

    resetOpenRouterBudgetCache();
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { usage: 4.8, limit: 5 } }),
    );
    expect(await isOpenRouterOverBudget()).toBe(true);
  });

  it("falls back to the configured budget when the key has no limit", async () => {
    process.env.OPENROUTER_MONTHLY_BUDGET_USD = "5";
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { usage: 4.9, limit: null } }),
    );
    expect(await isOpenRouterOverBudget()).toBe(false);

    resetOpenRouterBudgetCache();
    fetchMock.mockResolvedValue(
      jsonResponse({ data: { usage: 5.1, limit: null } }),
    );
    expect(await isOpenRouterOverBudget()).toBe(true);
  });

  it("never blocks when the key state is unavailable", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    expect(await getOpenRouterKeyState()).toBeNull();
    expect(await isOpenRouterOverBudget()).toBe(false);
  });

  it("caches the key state within the TTL", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { usage: 1, limit: 5 } }));
    await getOpenRouterKeyState();
    await getOpenRouterKeyState();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resetOpenRouterBudgetCache();
    await getOpenRouterKeyState();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("parses the default monthly budget", () => {
    expect(resolveMonthlyBudgetUsd(undefined)).toBe(5);
    expect(resolveMonthlyBudgetUsd("12.5")).toBe(12.5);
    expect(resolveMonthlyBudgetUsd("0")).toBe(5);
    expect(resolveMonthlyBudgetUsd("abc")).toBe(5);
  });
});
