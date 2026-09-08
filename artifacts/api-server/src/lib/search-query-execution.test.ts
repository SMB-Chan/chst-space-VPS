import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger";
import {
  getSearchEngineRoleRuntime,
  resetSearchEngineRuntimeForTests,
  resetSearchProviderHealthForTests,
  searchWithPlannedProviders,
  type ApiSearchProvider,
} from "./search-providers";
import type { SearchResult } from "./search-parse";
import { planSearchQueries } from "./search-query-planner";

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
  it("early-stops routine lookup when primary coverage is already sufficient", async () => {
    const searchProvider = provider(async (query) => {
      expect(query).toBe("倉敷市 観光 おすすめ");
      return [
        result("a.example", "1"),
        result("a.example", "2"),
        result("b.example", "3"),
        result("c.example", "4"),
        result("c.example", "5"),
      ];
    });

    const results = await searchWithPlannedProviders("倉敷市 観光 おすすめ", [
      searchProvider,
    ]);

    expect(results).toHaveLength(5);
    expect(searchProvider.search).toHaveBeenCalledOnce();
  });

  it("runs required weather evidence lanes even when primary quantity is sufficient", async () => {
    const searchProvider = provider(async (query) => {
      if (query === "倉敷市 明日 天気") {
        return [
          result("a.example", "1"),
          result("a.example", "2"),
          result("b.example", "3"),
          result("c.example", "4"),
          result("c.example", "5"),
        ];
      }
      expect(query).toContain("気象庁");
      return [result("jma.example", "forecast")];
    });

    await searchWithPlannedProviders("倉敷市 明日 天気", [searchProvider]);

    expect(searchProvider.search).toHaveBeenCalledTimes(2);
    expect(searchProvider.search.mock.calls.map(([query]) => query)).toEqual([
      "倉敷市 明日 天気",
      expect.stringContaining("気象庁"),
    ]);
  });

  it("runs supplemental query angles when primary coverage is insufficient", async () => {
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

  it("runs official and counterevidence lanes for fact checks despite broad coverage", async () => {
    const question = "この主張は本当か？ 公式資料と反証も含めて検証して";
    const searchProvider = provider(async (query) => {
      if (query === question) {
        return [
          result("a.example", "1"),
          result("a.example", "2"),
          result("b.example", "3"),
          result("c.example", "4"),
          result("c.example", "5"),
        ];
      }
      return [result("evidence.example", encodeURIComponent(query))];
    });

    await searchWithPlannedProviders(question, [searchProvider]);

    const queries = searchProvider.search.mock.calls.map(([query]) => query);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toBe(question);
    expect(queries.some((query) => /公式|official/i.test(query))).toBe(true);
    expect(queries.some((query) => /反証|counterevidence/i.test(query))).toBe(
      true,
    );
  });

  it("executes supplied structured suggestions only after primary coverage is insufficient", async () => {
    const plan = planSearchQueries("OpenAI product overview", {
      suggestedQueries: [
        { query: "OpenAI official product overview", role: "official" },
      ],
    });
    const searchProvider = provider(async (query) => {
      if (query === "OpenAI product overview") {
        return [result("primary.example", "primary")];
      }
      expect(query).toBe("OpenAI official product overview");
      return [
        result("official-a.example", "one"),
        result("official-b.example", "two"),
        result("official-c.example", "three"),
      ];
    });

    await searchWithPlannedProviders(
      "OpenAI product overview",
      [searchProvider],
      undefined,
      plan,
    );

    expect(searchProvider.search).toHaveBeenCalledTimes(2);
    expect(searchProvider.search.mock.calls.map(([query]) => query)).toEqual([
      "OpenAI product overview",
      "OpenAI official product overview",
    ]);
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

  it("logs anonymous engine and subquery metadata against the final top-k", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => undefined);
    const searchProvider = provider(async () => [
      result("a.example", "one"),
      result("a.example", "two"),
      result("b.example", "three"),
      result("c.example", "four"),
      result("c.example", "five"),
    ]);

    try {
      await searchWithPlannedProviders("safe topic", [searchProvider]);
      const metadataCall = debug.mock.calls.find(
        ([fields]) =>
          fields &&
          typeof fields === "object" &&
          "eventCode" in fields &&
          fields.eventCode === "SEARCH_EXECUTION_METADATA",
      );

      expect(metadataCall?.[0]).toMatchObject({
        subqueryRole: "primary",
        engine: "planned-provider",
        success: true,
        resultCount: 5,
        finalTopKContributionCount: 5,
        finalResultCount: 5,
        finalDistinctDomainCount: 3,
      });
      expect(metadataCall?.[0]).not.toHaveProperty("query");
      expect(
        getSearchEngineRoleRuntime("planned-provider", "primary"),
      ).toMatchObject({
        samples: 1,
        contributionCount: 5,
        opportunityCount: 5,
      });
    } finally {
      debug.mockRestore();
    }
  });
});
