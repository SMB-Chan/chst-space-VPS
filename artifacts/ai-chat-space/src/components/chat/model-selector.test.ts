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
    ["HTTP 400", 400],
    ["HTTP 401", 401],
    ["HTTP 403", 403],
    ["HTTP 404", 404],
    ["HTTP 429", 429],
    ["HTTP 500", 500],
    ["HTTP 502", 502],
    ["HTTP 503", 503],
    ["HTTP 504", 504],
  ])("clears the prior hint for %s response", (_label, status) => {
    expect(
      readTokenPlanQuotaResponse(
        new Response("error", {
          status,
          headers: completeHeaders(),
        }),
      ),
    ).toBeNull();
  });

  it("reads quota from headers even when response body is malformed", () => {
    expect(
      readTokenPlanQuotaResponse(
        new Response("not-json{{{", {
          status: 200,
          headers: completeHeaders(),
        }),
      ),
    ).toMatchObject({
      weeklyRemainingPercent: 67.3,
      fiveHourRemainingPercent: 42.5,
    });
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
      "five-hour out of range",
      { "X-Chat-Space-Token-Plan-Five-Hour-Remaining": "101" },
    ],
    [
      "weekly header negative",
      { "X-Chat-Space-Token-Plan-Weekly-Remaining": "-1" },
    ],
    [
      "five-hour header NaN",
      { "X-Chat-Space-Token-Plan-Five-Hour-Remaining": "abc" },
    ],
  ])("clears the prior hint when %s", (_label, overrides) => {
    expect(readTokenPlanQuotaHint(completeHeaders(overrides))).toBeNull();
  });

  it("returns null hint when no quota headers are present at all", () => {
    expect(readTokenPlanQuotaHint(new Headers())).toBeNull();
  });

  it("preserves boundary values at exactly 0 and 100 percent", () => {
    const headers = completeHeaders({
      "X-Chat-Space-Token-Plan-Weekly-Remaining": "0",
      "X-Chat-Space-Token-Plan-Five-Hour-Remaining": "100",
    });
    expect(readTokenPlanQuotaHint(headers)).toMatchObject({
      weeklyRemainingPercent: 0,
      fiveHourRemainingPercent: 100,
    });
  });
});
