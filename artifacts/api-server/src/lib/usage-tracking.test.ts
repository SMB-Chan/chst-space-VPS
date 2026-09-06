import { describe, expect, it } from "vitest";
import {
  estimateCostUsd,
  estimateTokens,
  resolveDefaultUserBudgetUsd,
  usageMonthKey,
} from "./usage-pricing";

describe("usage accounting primitives", () => {
  it("prices recorded OpenRouter models per 1M tokens", () => {
    // GLM-5.3 Flash: $0.07 input / $0.25 output per 1M.
    expect(
      estimateCostUsd("z-ai/glm-5.3-flash", 1_000_000, 1_000_000),
    ).toBeCloseTo(0.32, 5);
    expect(estimateCostUsd("z-ai/glm-5.3-flash", 0, 2_000_000)).toBeCloseTo(
      0.5,
      5,
    );
    // Qwen3.7 Flash is the cheapest pick.
    expect(
      estimateCostUsd("qwen/qwen3.7-flash", 1_000_000, 1_000_000),
    ).toBeCloseTo(0.16, 5);
    expect(estimateCostUsd("qwen/qwen3.8-flash", 1_000_000, 0)).toBeCloseTo(
      0.15,
      5,
    );
    // Qwen thinking has expensive output.
    expect(
      estimateCostUsd("qwen/qwen3-235b-a22b-thinking-2507", 0, 1_000_000),
    ).toBeCloseTo(2.3, 5);
  });

  it("uses a conservative fallback for unknown models", () => {
    expect(estimateCostUsd("some/new-model", 1_000_000, 1_000_000)).toBeCloseTo(
      1.3,
      5,
    );
  });

  it("computes UTC month keys", () => {
    expect(usageMonthKey(new Date("2026-09-05T23:30:00.000Z"))).toBe("2026-09");
    expect(usageMonthKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });

  it("estimates tokens from character length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("1234567890")).toBe(4);
    expect(estimateTokens("あ")).toBe(1);
  });

  it("parses the default general-user budget", () => {
    expect(resolveDefaultUserBudgetUsd(undefined)).toBe(2);
    expect(resolveDefaultUserBudgetUsd("3.5")).toBe(3.5);
    expect(resolveDefaultUserBudgetUsd("0")).toBe(2);
    expect(resolveDefaultUserBudgetUsd("-1")).toBe(2);
    expect(resolveDefaultUserBudgetUsd("abc")).toBe(2);
  });
});
