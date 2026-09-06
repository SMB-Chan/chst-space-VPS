import { describe, expect, it, vi } from "vitest";
import { planSearchQueries } from "./search-query-planner";

const searchWithApiProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("./search-providers", () => ({
  searchWithApiProviders: searchWithApiProvidersMock,
}));

import { searchWeb } from "./web-search";

function result(index: number) {
  return [
    {
      title: `result-${index}`,
      url: `https://cache-${index}.example/result`,
      snippet: `snippet-${index}`,
    },
  ];
}

describe("searchWeb cache isolation", () => {
  it("bypasses cache read/write whenever a structured plan is supplied", async () => {
    let callCount = 0;
    searchWithApiProvidersMock.mockImplementation(async () => {
      callCount += 1;
      return result(callCount);
    });

    const query = "cache isolation structured plan";
    const plan = planSearchQueries(query, {
      suggestedQueries: [
        { query: "cache isolation official source", role: "official" },
      ],
    });

    const plannedFirst = await searchWeb(query, undefined, plan);
    const normalAfterPlanned = await searchWeb(query);
    const normalCacheHit = await searchWeb(query);
    const plannedAfterNormal = await searchWeb(query, undefined, plan);

    expect(plannedFirst[0]?.title).toBe("result-1");
    expect(normalAfterPlanned[0]?.title).toBe("result-2");
    expect(normalCacheHit[0]?.title).toBe("result-2");
    expect(plannedAfterNormal[0]?.title).toBe("result-3");
    expect(searchWithApiProvidersMock).toHaveBeenCalledTimes(3);
    expect(
      searchWithApiProvidersMock.mock.calls.map(([, , suppliedPlan]) =>
        Boolean(suppliedPlan),
      ),
    ).toEqual([true, false, true]);
  });
});
