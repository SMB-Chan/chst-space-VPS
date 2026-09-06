import { afterEach, describe, expect, it } from "vitest";
import {
  getSearchEngineRuntime,
  rankSearchEngines,
  recordSearchEngineObservation,
  resetSearchEngineRuntimeForTests,
} from "./search-engine-scheduler";
import { resetSearchProviderHealthForTests } from "./search-core";
import type { ApiSearchProvider } from "./search-provider-types";

function provider(
  name: string,
  options: Partial<ApiSearchProvider> = {},
): ApiSearchProvider {
  return {
    name,
    search: async () => [],
    ...options,
  };
}

afterEach(() => {
  resetSearchEngineRuntimeForTests();
  resetSearchProviderHealthForTests();
});

describe("search engine scheduler", () => {
  it("keeps general engines ahead of unrelated vertical engines", () => {
    const general = provider("general", { kind: "general" });
    const vertical = provider("vertical", {
      kind: "vertical",
      queryAffinity: () => 0.1,
    });

    expect(
      rankSearchEngines("今日の天気", [vertical, general]).map((p) => p.name),
    ).toEqual(["general", "vertical"]);
  });

  it("raises a strongly matching vertical engine", () => {
    const general = provider("general", { kind: "general" });
    const github = provider("github", {
      kind: "vertical",
      queryAffinity: (query) => (query.includes("GitHub") ? 0.98 : 0.1),
    });

    expect(
      rankSearchEngines("GitHubの検索ライブラリ", [general, github]).map(
        (p) => p.name,
      ),
    ).toEqual(["github", "general"]);
  });

  it("learns from reliability and latency observations", () => {
    const fast = provider("fast", {
      kind: "general",
      queryAffinity: () => 0.62,
    });
    const slow = provider("slow", {
      kind: "general",
      queryAffinity: () => 0.62,
    });

    for (let i = 0; i < 6; i += 1) {
      recordSearchEngineObservation("fast", { ok: true, latencyMs: 250 });
      recordSearchEngineObservation("slow", {
        ok: i < 3,
        latencyMs: 4_000,
      });
    }

    const ranked = rankSearchEngines("neutral query", [slow, fast]);
    expect(ranked[0]?.name).toBe("fast");
    expect(getSearchEngineRuntime("fast").successRate).toBeGreaterThan(
      getSearchEngineRuntime("slow").successRate,
    );
    expect(getSearchEngineRuntime("fast").ewmaLatencyMs).toBeLessThan(
      getSearchEngineRuntime("slow").ewmaLatencyMs,
    );
  });
});
