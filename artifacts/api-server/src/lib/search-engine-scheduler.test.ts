import { afterEach, describe, expect, it } from "vitest";
import {
  ADAPTIVE_ROLE_COVERAGE_FLOOR,
  ADAPTIVE_ROLE_MAX_CORRECTION,
  ADAPTIVE_ROLE_MIN_SAMPLES,
  getSearchEngineRoleRuntime,
  getSearchEngineRuntime,
  rankSearchEngines,
  recordSearchEngineRoleContribution,
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

  it("applies a role-aware contribution boost only after enough samples", () => {
    const baseline = provider("baseline", {
      kind: "general",
      queryAffinity: () => 0.62,
    });
    const adaptive = provider("adaptive", {
      kind: "general",
      queryAffinity: () => 0.62,
    });

    for (let i = 0; i < ADAPTIVE_ROLE_MIN_SAMPLES - 1; i += 1) {
      recordSearchEngineRoleContribution("adaptive", "official", {
        contributionCount: ADAPTIVE_ROLE_COVERAGE_FLOOR,
        finalTopKSize: ADAPTIVE_ROLE_COVERAGE_FLOOR,
        successful: true,
      });
    }
    expect(
      rankSearchEngines("neutral query", [baseline, adaptive], "official").map(
        (item) => item.name,
      ),
    ).toEqual(["baseline", "adaptive"]);
    expect(getSearchEngineRoleRuntime("adaptive", "official").correction).toBe(
      0,
    );

    recordSearchEngineRoleContribution("adaptive", "official", {
      contributionCount: ADAPTIVE_ROLE_COVERAGE_FLOOR,
      finalTopKSize: ADAPTIVE_ROLE_COVERAGE_FLOOR,
      successful: true,
    });
    expect(
      rankSearchEngines("neutral query", [baseline, adaptive], "official").map(
        (item) => item.name,
      ),
    ).toEqual(["adaptive", "baseline"]);
    expect(getSearchEngineRoleRuntime("adaptive", "official").correction).toBe(
      ADAPTIVE_ROLE_MAX_CORRECTION,
    );
  });

  it("learns zero quality without excluding an engine and can reset", () => {
    for (let i = 0; i < ADAPTIVE_ROLE_MIN_SAMPLES + 3; i += 1) {
      recordSearchEngineRoleContribution("quiet", "research", {
        contributionCount: 0,
        finalTopKSize: 10,
        successful: true,
      });
    }

    const quiet = getSearchEngineRoleRuntime("quiet", "research");
    expect(quiet.samples).toBe(ADAPTIVE_ROLE_MIN_SAMPLES + 3);
    expect(quiet.contributionQuality).toBe(0);
    expect(quiet.correction).toBe(0);

    resetSearchEngineRuntimeForTests();
    expect(getSearchEngineRoleRuntime("quiet", "research")).toMatchObject({
      samples: 0,
      contributionCount: 0,
      contributionQuality: 0,
      correction: 0,
    });
  });

  it("ignores failed executions and decays old quality on later successes", () => {
    for (let i = 0; i < ADAPTIVE_ROLE_MIN_SAMPLES; i += 1) {
      recordSearchEngineRoleContribution("recent", "technical", {
        contributionCount: ADAPTIVE_ROLE_COVERAGE_FLOOR,
        finalTopKSize: ADAPTIVE_ROLE_COVERAGE_FLOOR,
        successful: true,
      });
    }
    const initial = getSearchEngineRoleRuntime("recent", "technical");
    expect(initial.contributionQuality).toBe(1);
    expect(initial.correction).toBe(ADAPTIVE_ROLE_MAX_CORRECTION);

    for (let i = 0; i < ADAPTIVE_ROLE_MIN_SAMPLES; i += 1) {
      recordSearchEngineRoleContribution("recent", "technical", {
        contributionCount: 0,
        finalTopKSize: 10,
        successful: true,
      });
    }
    const decayed = getSearchEngineRoleRuntime("recent", "technical");
    expect(decayed.samples).toBe(ADAPTIVE_ROLE_MIN_SAMPLES * 2);
    expect(decayed.contributionQuality).toBeLessThan(1);
    expect(decayed.correction).toBeLessThan(ADAPTIVE_ROLE_MAX_CORRECTION);

    recordSearchEngineRoleContribution("recent", "technical", {
      contributionCount: ADAPTIVE_ROLE_COVERAGE_FLOOR,
      finalTopKSize: ADAPTIVE_ROLE_COVERAGE_FLOOR,
      successful: false,
    });
    expect(getSearchEngineRoleRuntime("recent", "technical").samples).toBe(
      ADAPTIVE_ROLE_MIN_SAMPLES * 2,
    );
  });

  it("keeps role observations independent", () => {
    for (let i = 0; i < ADAPTIVE_ROLE_MIN_SAMPLES; i += 1) {
      recordSearchEngineRoleContribution("isolated", "official", {
        contributionCount: ADAPTIVE_ROLE_COVERAGE_FLOOR,
        finalTopKSize: ADAPTIVE_ROLE_COVERAGE_FLOOR,
        successful: true,
      });
    }

    expect(getSearchEngineRoleRuntime("isolated", "official").correction).toBe(
      ADAPTIVE_ROLE_MAX_CORRECTION,
    );
    expect(getSearchEngineRoleRuntime("isolated", "primary")).toMatchObject({
      samples: 0,
      correction: 0,
    });
  });

  it("does not treat sparse successful results as maximum quality", () => {
    for (let i = 0; i < ADAPTIVE_ROLE_MIN_SAMPLES; i += 1) {
      recordSearchEngineRoleContribution("sparse", "freshness", {
        contributionCount: 1,
        finalTopKSize: 1,
        successful: true,
      });
    }

    const sparse = getSearchEngineRoleRuntime("sparse", "freshness");
    expect(sparse.contributionQuality).toBe(1 / ADAPTIVE_ROLE_COVERAGE_FLOOR);
    expect(sparse.correction).toBeLessThan(ADAPTIVE_ROLE_MAX_CORRECTION);
  });
});
