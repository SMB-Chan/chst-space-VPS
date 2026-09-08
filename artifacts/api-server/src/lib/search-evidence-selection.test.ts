import { describe, expect, it } from "vitest";
import type { ScoredSearchResult } from "./search-enhance";
import { selectEvidenceAwareFetchCandidates } from "./search-evidence-selection";
import { planSearchQueries } from "./search-query-planner";
import type { SearchEvidenceDimension } from "./search-task-profile";

function result(
  host: string,
  id: string,
  score: number,
  dimensions: SearchEvidenceDimension[] = [],
): ScoredSearchResult {
  return {
    title: id,
    url: `https://${host}/${id}`,
    snippet: `${id} snippet`,
    score,
    evidence:
      dimensions.length > 0
        ? {
            dimensions: Object.fromEntries(
              dimensions.map((dimension) => [dimension, 1]),
            ),
            queryRoles: ["primary"],
            providerNames: ["test"],
          }
        : undefined,
  };
}

describe("selectEvidenceAwareFetchCandidates", () => {
  it("preserves ranked order when no plan is supplied", () => {
    const results = [
      result("a.example", "a", 10),
      result("b.example", "b", 9),
      result("c.example", "c", 8),
    ];

    expect(selectEvidenceAwareFetchCandidates(results, undefined, 2)).toEqual([
      results[0],
      results[1],
    ]);
  });

  it("keeps required primary-source and counterevidence lanes inside the fetch budget", () => {
    const plan = planSearchQueries(
      "この主張は本当か？ 公式資料と反証も含めて検証して",
    );
    const results = [
      result("same.example", "rank-1", 100),
      result("same.example", "rank-2", 99),
      result("same.example", "rank-3", 98),
      result("same.example", "rank-4", 97),
      result("same.example", "rank-5", 96),
      result("official.example", "official", 50, ["primary_source"]),
      result("critique.example", "counter", 40, ["counterevidence"]),
    ];

    const selected = selectEvidenceAwareFetchCandidates(results, plan, 5);
    expect(selected.map((item) => item.title)).toContain("official");
    expect(selected.map((item) => item.title)).toContain("counter");
    expect(
      new Set(selected.map((item) => new URL(item.url).hostname)).size,
    ).toBeGreaterThanOrEqual(2);
    expect(selected).toHaveLength(5);
  });

  it("uses a separate domain when independence is required", () => {
    const plan = planSearchQueries("ReactとVueのSDK設計を比較して");
    const results = [
      result("same.example", "rank-1", 100),
      result("same.example", "rank-2", 99),
      result("same.example", "comparison", 80, ["comparison"]),
      result("independent.example", "independent", 70),
    ];

    const selected = selectEvidenceAwareFetchCandidates(results, plan, 3);
    expect(selected.map((item) => item.title)).toContain("comparison");
    expect(selected.map((item) => item.title)).toContain("independent");
  });

  it("prioritizes a required evidence lane even under a one-page budget", () => {
    const plan = planSearchQueries("LLM hallucination 研究 論文");
    const results = [
      result("general.example", "rank-1", 100),
      result("paper.example", "paper", 30, ["academic"]),
    ];

    const selected = selectEvidenceAwareFetchCandidates(results, plan, 1);
    expect(selected.map((item) => item.title)).toEqual(["paper"]);
  });

  it("never exceeds the fetch budget while trying to satisfy independence", () => {
    const plan = planSearchQueries("ReactとVueを比較して");
    const results = [
      result("same.example", "rank-1", 100),
      result("other.example", "rank-2", 90),
    ];

    expect(selectEvidenceAwareFetchCandidates(results, plan, 1)).toHaveLength(
      1,
    );
  });

  it("falls back to relevance order when retrieval provenance is unavailable", () => {
    const plan = planSearchQueries(
      "この主張は本当か？ 公式資料と反証も含めて検証して",
    );
    const results = [
      result("a.example", "a", 10),
      result("b.example", "b", 9),
      result("c.example", "c", 8),
    ];

    expect(selectEvidenceAwareFetchCandidates(results, plan, 2)).toEqual([
      results[0],
      results[1],
    ]);
  });
});
