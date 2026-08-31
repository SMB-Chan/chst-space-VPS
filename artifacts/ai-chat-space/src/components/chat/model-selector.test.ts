import { describe, expect, it } from "vitest";
import {
  readTokenPlanQuotaHint,
  readTokenPlanQuotaResponse,
} from "./model-selector";

function completeHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    "X-Chat-Space-Token-Plan-Weekly-Remaining": "67.3",
    "X-Chat-Space-Token-Plan-Five-Hour-Remaining": "42.5",
    ...overrides,
  });
}

describe("Token Plan quota hint parsing", () => {
  it("accepts a complete valid response", () => {
    expect(
      readTokenPlanQuotaResponse(
        new Response("[]", {
          status: 200,
          headers: completeHeaders({
            "X-Chat-Space-Token-Plan-Limiting-Window": "5-hour",
          }),
        }),
      ),
    ).toMatchObject({
      weeklyRemainingPercent: 67.3,
      fiveHourRemainingPercent: 42.5,
      limitingWindow: "5-hour",
    });
  });

  it("clears the prior hint for a non-success response", () => {
    expect(
      readTokenPlanQuotaResponse(
        new Response("temporarily unavailable", {
          status: 503,
          headers: completeHeaders(),
        }),
      ),
    ).toBeNull();
  });

  it.each([
    [
      "weekly header missing",
      { "X-Chat-Space-Token-Plan-Weekly-Remaining": "" },
    ],
    [
      "five-hour header missing",
      { "X-Chat-Space-Token-Plan-Five-Hour-Remaining": "" },
    ],
    [
      "weekly header invalid",
      { "X-Chat-Space-Token-Plan-Weekly-Remaining": "unknown" },
    ],
    [
      "five-hour header out of range",
      { "X-Chat-Space-Token-Plan-Five-Hour-Remaining": "101" },
    ],
  ])("clears the prior hint when %s", (_label, overrides) => {
    expect(readTokenPlanQuotaHint(completeHeaders(overrides))).toBeNull();
  });
});
