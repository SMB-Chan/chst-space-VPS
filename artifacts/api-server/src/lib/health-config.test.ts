import { describe, expect, it } from "vitest";
import { shouldIncludeOperationalHealthMetrics } from "./health-config";

describe("shouldIncludeOperationalHealthMetrics", () => {
  it("keeps aggregate counters out of unauthenticated health responses by default", () => {
    expect(shouldIncludeOperationalHealthMetrics({})).toBe(false);
    expect(
      shouldIncludeOperationalHealthMetrics({ HEALTH_INCLUDE_OPERATIONAL_METRICS: "0" }),
    ).toBe(false);
  });

  it("requires an explicit opt-in", () => {
    expect(
      shouldIncludeOperationalHealthMetrics({ HEALTH_INCLUDE_OPERATIONAL_METRICS: "1" }),
    ).toBe(true);
    expect(
      shouldIncludeOperationalHealthMetrics({ HEALTH_INCLUDE_OPERATIONAL_METRICS: " 1 " }),
    ).toBe(true);
  });
});
