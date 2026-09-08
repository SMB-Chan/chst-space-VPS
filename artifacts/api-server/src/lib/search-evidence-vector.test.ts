import { describe, expect, it } from "vitest";
import {
  annotateSearchResultsWithEvidence,
  assessSearchRetrievalEvidence,
  mergeSearchEvidenceMetadata,
  supplementalRolesForEvidenceDimensions,
} from "./search-evidence-vector";
import type { SearchResult } from "./search-parse";
import { planSearchQueries } from "./search-query-planner";

function result(host: string, path: string): SearchResult {
  return {
    title: path,
    url: `https://${host}/${path}`,
    snippet: `${path} snippet`,
  };
}

describe("search evidence vectors", () => {
  it("attaches query-lane and provider provenance without claiming factual sufficiency", () => {
    const [annotated] = annotateSearchResultsWithEvidence(
      [result("gov.example", "source")],
      { role: "official", providerName: "brave" },
    );

    expect(annotated.evidence).toEqual({
      dimensions: { primary_source: 1 },
      queryRoles: ["official"],
      providerNames: ["brave"],
    });
  });

  it("unions evidence provenance when the same URL is confirmed through multiple lanes", () => {
    const merged = mergeSearchEvidenceMetadata(
      {
        dimensions: { primary_source: 1 },
        queryRoles: ["official"],
        providerNames: ["brave"],
      },
      {
        dimensions: { counterevidence: 1 },
        queryRoles: ["counterevidence"],
        providerNames: ["exa", "brave"],
      },
    );

    expect(merged).toEqual({
      dimensions: { primary_source: 1, counterevidence: 1 },
      queryRoles: ["official", "counterevidence"],
      providerNames: ["brave", "exa"],
    });
  });

  it("recognizes primary-query temporal evidence but keeps official evidence as a real gap", () => {
    const plan = planSearchQueries("倉敷市 明日 天気");
    const primary = annotateSearchResultsWithEvidence(
      [result("weather-a.example", "one"), result("weather-b.example", "two")],
      {
        role: "primary",
        providerName: "provider-a",
        extraDimensions: plan.primaryEvidenceDimensions,
      },
    );

    const coverage = assessSearchRetrievalEvidence(plan, primary);
    expect(plan.primaryEvidenceDimensions).toContain("freshness");
    expect(coverage.coveredDimensions).toEqual(
      expect.arrayContaining(["freshness", "independence"]),
    );
    expect(coverage.missingRequiredDimensions).toEqual(["primary_source"]);
  });

  it("closes required retrieval gaps only after the targeted lane contributes evidence", () => {
    const plan = planSearchQueries(
      "この主張は本当か？ 公式資料と反証も含めて検証して",
    );
    const primary = annotateSearchResultsWithEvidence(
      [result("a.example", "one"), result("b.example", "two")],
      { role: "primary", providerName: "one" },
    );
    const official = annotateSearchResultsWithEvidence(
      [result("official.example", "source")],
      { role: "official", providerName: "two" },
    );
    const counter = annotateSearchResultsWithEvidence(
      [result("counter.example", "source")],
      { role: "counterevidence", providerName: "three" },
    );

    const coverage = assessSearchRetrievalEvidence(plan, [
      ...primary,
      ...official,
      ...counter,
    ]);
    expect(coverage.missingRequiredDimensions).toEqual([]);
  });

  it("maps only searchable evidence gaps back to bounded supplemental roles", () => {
    expect(
      supplementalRolesForEvidenceDimensions([
        "primary_source",
        "counterevidence",
        "independence",
      ]),
    ).toEqual(new Set(["official", "counterevidence"]));
  });
});
