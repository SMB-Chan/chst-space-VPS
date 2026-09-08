import { describe, expect, it } from "vitest";
import { buildSearchTaskProfile } from "./search-task-profile";

describe("buildSearchTaskProfile", () => {
  it("treats current news as fresh independent retrieval", () => {
    const profile = buildSearchTaskProfile("今日のニュースについて分かるか？");

    expect(profile).toMatchObject({
      intent: "news",
      task: "latest",
      temporalNeed: "realtime",
      recommendedMaxQueries: 3,
    });
    expect(profile.dimensions).toEqual(
      expect.arrayContaining(["freshness", "independence"]),
    );
    expect(profile.lanes[0]?.kind).toBe("freshness");
  });

  it("builds primary and counterevidence lanes for fact checking", () => {
    const profile = buildSearchTaskProfile(
      "この主張は本当か？ 公式資料と反証も含めて検証して",
    );

    expect(profile).toMatchObject({
      task: "fact_check",
      recommendedMaxQueries: 4,
    });
    expect(profile.dimensions).toEqual(
      expect.arrayContaining([
        "primary_source",
        "independence",
        "counterevidence",
      ]),
    );
    expect(profile.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "primary_source", required: true }),
        expect.objectContaining({ kind: "counterevidence", required: true }),
        expect.objectContaining({ kind: "independent" }),
      ]),
    );
  });

  it("keeps historical research out of the freshness dimension", () => {
    const profile = buildSearchTaskProfile("2024年当時のRAG研究論文を調べて");

    expect(profile).toMatchObject({
      task: "research",
      temporalNeed: "historical",
      recommendedMaxQueries: 4,
    });
    expect(profile.dimensions).toContain("academic");
    expect(profile.dimensions).toContain("primary_source");
    expect(profile.dimensions).not.toContain("freshness");
  });

  it("profiles technical comparisons without forcing freshness", () => {
    const profile = buildSearchTaskProfile("ReactとVueのSDK設計を比較して");

    expect(profile.task).toBe("comparison");
    expect(profile.temporalNeed).toBe("timeless");
    expect(profile.dimensions).toEqual(
      expect.arrayContaining(["technical", "comparison", "independence"]),
    );
    expect(profile.recommendedMaxQueries).toBe(4);
  });

  it("uses primary and freshness requirements for weather", () => {
    const profile = buildSearchTaskProfile("今日の倉敷市の天気は？");

    expect(profile).toMatchObject({
      intent: "weather",
      task: "weather",
      temporalNeed: "realtime",
    });
    expect(profile.dimensions).toEqual(
      expect.arrayContaining(["primary_source", "freshness"]),
    );
    expect(profile.lanes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "primary_source", required: true }),
        expect.objectContaining({ kind: "freshness", required: true }),
      ]),
    );
  });
});
