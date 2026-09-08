import { afterEach, describe, expect, it } from "vitest";
import {
  classifySearchProviderFailure,
  fuseSearchProviderResults,
  getSearchProviderHealth,
  isSearchProviderAvailable,
  recordSearchProviderFailure,
  recordSearchProviderSuccess,
  resetSearchProviderHealthForTests,
} from "./search-core";
import type { SearchResult } from "./search-parse";

function result(host: string, path: string, title = path): SearchResult {
  return {
    title,
    url: `https://${host}/${path}`,
    snippet: `${title} snippet`,
  };
}

afterEach(() => {
  resetSearchProviderHealthForTests();
});

describe("search provider health", () => {
  it("classifies rate limits, blocks, timeouts and server errors", () => {
    expect(
      classifySearchProviderFailure(
        Object.assign(new Error("x"), { status: 429 }),
      ),
    ).toBe("rate_limited");
    expect(
      classifySearchProviderFailure(
        Object.assign(new Error("x"), { status: 403 }),
      ),
    ).toBe("blocked");
    expect(
      classifySearchProviderFailure(new Error("Search provider timed out")),
    ).toBe("timeout");
    expect(
      classifySearchProviderFailure(
        Object.assign(new Error("x"), { status: 503 }),
      ),
    ).toBe("server_error");
  });

  it("puts a rate-limited provider into cooldown and honors Retry-After", () => {
    const now = 1_000_000;
    const error = Object.assign(new Error("Search API returned 429"), {
      status: 429,
      retryAfterMs: 120_000,
    });
    const health = recordSearchProviderFailure("brave", error, now);
    expect(health.health).toBe("cooldown");
    expect(health.lastFailureKind).toBe("rate_limited");
    expect(health.suspendedUntil).toBe(now + 120_000);
    expect(isSearchProviderAvailable("brave", now + 119_999)).toBe(false);
    expect(isSearchProviderAvailable("brave", now + 120_000)).toBe(true);
  });

  it("does not immediately suspend an engine for one generic transient failure", () => {
    const now = 2_000_000;
    const health = recordSearchProviderFailure(
      "generic",
      new Error("socket reset"),
      now,
    );
    expect(health.health).toBe("degraded");
    expect(isSearchProviderAvailable("generic", now)).toBe(true);
  });

  it("recovers health after a successful request", () => {
    const now = 3_000_000;
    recordSearchProviderFailure(
      "engine",
      Object.assign(new Error("Search API returned 503"), { status: 503 }),
      now,
    );
    expect(getSearchProviderHealth("engine", now).health).toBe("cooldown");
    recordSearchProviderSuccess("engine");
    expect(getSearchProviderHealth("engine", now).health).toBe("healthy");
  });
});

describe("weighted reciprocal rank fusion", () => {
  it("promotes a URL independently confirmed by multiple providers", () => {
    const confirmed = result("shared.example", "confirmed", "confirmed");
    const fused = fuseSearchProviderResults(
      [
        {
          providerName: "one",
          results: [
            result("one.example", "first"),
            result("one.example", "second"),
            confirmed,
          ],
        },
        {
          providerName: "two",
          results: [confirmed, result("two.example", "other")],
        },
      ],
      5,
    );
    expect(fused[0]?.url).toBe(confirmed.url);
  });

  it("preserves evidence vectors when duplicate URLs fuse across lanes", () => {
    const url = "https://shared.example/source";
    const fused = fuseSearchProviderResults(
      [
        {
          providerName: "query:official:0",
          results: [
            {
              title: "source",
              url,
              snippet: "official",
              evidence: {
                dimensions: { primary_source: 1 },
                queryRoles: ["official"],
                providerNames: ["brave"],
              },
            },
          ],
        },
        {
          providerName: "query:counterevidence:1",
          results: [
            {
              title: "source",
              url,
              snippet: "counter evidence with a longer snippet",
              evidence: {
                dimensions: { counterevidence: 1 },
                queryRoles: ["counterevidence"],
                providerNames: ["exa"],
              },
            },
          ],
        },
      ],
      2,
    );

    expect(fused[0]?.evidence).toEqual({
      dimensions: { primary_source: 1, counterevidence: 1 },
      queryRoles: ["official", "counterevidence"],
      providerNames: ["brave", "exa"],
    });
  });

  it("uses provider weights without allowing extreme values to dominate unboundedly", () => {
    const weighted = result("weighted.example", "a");
    const consensus = result("consensus.example", "b");
    const fused = fuseSearchProviderResults(
      [
        { providerName: "weighted", weight: 1000, results: [weighted] },
        { providerName: "a", results: [consensus] },
        { providerName: "b", results: [consensus] },
        { providerName: "c", results: [consensus] },
        { providerName: "d", results: [consensus] },
        { providerName: "e", results: [consensus] },
      ],
      2,
    );
    expect(new Set(fused.map((item) => item.url))).toEqual(
      new Set([weighted.url, consensus.url]),
    );
  });

  it("keeps hostname diversity as a soft cap", () => {
    const fused = fuseSearchProviderResults(
      [
        {
          providerName: "one",
          results: [
            result("same.example", "1"),
            result("same.example", "2"),
            result("same.example", "3"),
            result("other.example", "4"),
          ],
        },
      ],
      4,
    );
    expect(fused).toHaveLength(4);
    expect(
      new Set(fused.slice(0, 3).map((item) => new URL(item.url).hostname)).size,
    ).toBeGreaterThanOrEqual(2);
  });
});
