import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetSearchEngineRuntimeForTests,
  resetSearchProviderHealthForTests,
  searchWithPlannedProviders,
  type ApiSearchProvider,
} from "./search-providers";
import type { SearchResult } from "./search-parse";

function result(host: string, path: string): SearchResult {
  return {
    title: path,
    url: `https://${host}/${path}`,
    snippet: `${path} snippet`,
  };
}

function provider(
  implementation: (
    query: string,
    signal?: AbortSignal,
  ) => Promise<SearchResult[]>,
): ApiSearchProvider & { search: ReturnType<typeof vi.fn> } {
  return {
    name: "planned-provider",
    kind: "general",
    search: vi.fn(implementation),
  };
}

afterEach(() => {
  resetSearchEngineRuntimeForTests();
  resetSearchProviderHealthForTests();
});

describe("searchWithPlannedProviders", () => {
  it("early-stops after the primary query when coverage is already sufficient", async () => {
    const searchProvider = provider(async (query) => {
      expect(query).toBe("倉敷市 明日 天気");
      return [
        result("a.example", "1"),
        result("a.example", "2"),
        result("b.example", "3"),
        result("c.example", "4"),
        result("c.example", "5"),
      ];
    });

    const results = await searchWithPlannedProviders("倉敷市 明日 天気", [
      searchProvider,
    ]);

    expect(results).toHaveLength(5);
    expect(searchProvider.search).toHaveBeenCalledOnce();
  });

  it("runs supplemental query angles only when primary coverage is insufficient", async () => {
    const searchProvider = provider(async (query) => {
      if (query === "倉敷市 明日 天気") {
        return [
          result("a.example", "primary-1"),
          result("a.example", "primary-2"),
        ];
      }
      expect(query).toContain("気象庁");
      return [
        result("b.example", "official-1"),
        result("c.example", "official-2"),
        result("d.example", "official-3"),
      ];
    });

    const results = await searchWithPlannedProviders("倉敷市 明日 天気", [
      searchProvider,
    ]);

    expect(searchProvider.search).toHaveBeenCalledTimes(2);
    expect(
      new Set(results.map((item) => new URL(item.url).hostname)).size,
    ).toBeGreaterThanOrEqual(4);
  });

  it("does not call providers for an unsafe base query", async () => {
    const searchProvider = provider(async () => [result("a.example", "1")]);

    const results = await searchWithPlannedProviders(
      "api_key=sk-abcdefghijklmnopqrstuvwxyz012345",
      [searchProvider],
    );

    expect(results).toEqual([]);
    expect(searchProvider.search).not.toHaveBeenCalled();
  });

  it("propagates cancellation before launching supplemental queries", async () => {
    const controller = new AbortController();
    const cancelled = new Error("client disconnected");
    const searchProvider = provider(async (query, signal) => {
      expect(query).toBe("倉敷市 明日 天気");
      expect(signal).toBe(controller.signal);
      controller.abort(cancelled);
      return [result("a.example", "primary")];
    });

    await expect(
      searchWithPlannedProviders(
        "倉敷市 明日 天気",
        [searchProvider],
        controller.signal,
      ),
    ).rejects.toBe(cancelled);
    expect(searchProvider.search).toHaveBeenCalledOnce();
  });
});
