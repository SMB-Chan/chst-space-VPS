import { describe, expect, it } from "vitest";
import {
  buildEvidenceFacetGapSearch,
  buildEvidenceMatrixUserMessage,
  inferRequiredEvidenceFacets,
  parseEvidenceMatrixAssessment,
} from "./research-evidence-matrix";

describe("research evidence matrix", () => {
  it("infers only the semantic facets required by the question", () => {
    const facets = inferRequiredEvidenceFacets(
      "最新状況を調べ、なぜ起きたのか、影響と反対意見を含めて比較して",
    ).map((item) => item.facet);

    expect(facets).toEqual([
      "primary_source",
      "recency",
      "causal_background",
      "impact",
      "comparison",
      "counterevidence",
    ]);
  });

  it("downgrades unsupported covered claims and fills omitted required facets", () => {
    const requiredFacets = inferRequiredEvidenceFacets(
      "この問題を詳しく評価し、反対意見も調べて",
    );
    const parsed = parseEvidenceMatrixAssessment({
      raw: JSON.stringify({
        facets: [
          {
            facet: "primary_source",
            status: "covered",
            sourceIds: [],
            reason: "claimed without a source",
          },
        ],
      }),
      requiredFacets,
      sourceCount: 3,
    });

    expect(parsed).toBeDefined();
    expect(parsed?.complete).toBe(false);
    expect(
      parsed?.facets.find((facet) => facet.facet === "primary_source")?.status,
    ).toBe("partial");
    expect(
      parsed?.facets.find((facet) => facet.facet === "counterevidence")?.status,
    ).toBe("missing");
  });

  it("targets the first missing semantic facet with a sanitized bounded query", () => {
    const requiredFacets = inferRequiredEvidenceFacets(
      "この問題の影響と反対意見を詳しく調査して",
    );
    const assessment = parseEvidenceMatrixAssessment({
      raw: JSON.stringify({
        facets: requiredFacets.map((item) => ({
          facet: item.facet,
          status: item.facet === "impact" ? "missing" : "covered",
          sourceIds: item.facet === "impact" ? [] : [1],
          reason: "test",
        })),
      }),
      requiredFacets,
      sourceCount: 2,
    });
    expect(assessment).toBeDefined();

    const gap = buildEvidenceFacetGapSearch({
      question: "この問題の影響と反対意見を詳しく調査して",
      assessment: assessment!,
      seenQueries: new Set(),
      forcedRound: 0,
    });

    expect(gap?.facet).toBe("impact");
    expect(gap?.call.name).toBe("web_search");
    const args = JSON.parse(gap!.call.arguments) as {
      query: string;
      fetchContent: boolean;
    };
    expect(args.fetchContent).toBe(true);
    expect(args.query).toContain("影響");
    expect(args.query.length).toBeLessThanOrEqual(500);
  });

  it("refuses to generate a gap query from secret-like question text", () => {
    const requiredFacets = inferRequiredEvidenceFacets(
      "api_key=sk-abcdefghijklmnopqrstuvwxyz123456 について詳しく調査して",
    );
    const assessment = parseEvidenceMatrixAssessment({
      raw: JSON.stringify({ facets: [] }),
      requiredFacets,
      sourceCount: 0,
    });
    expect(assessment).toBeDefined();

    expect(
      buildEvidenceFacetGapSearch({
        question:
          "api_key=sk-abcdefghijklmnopqrstuvwxyz123456 について詳しく調査して",
        assessment: assessment!,
        seenQueries: new Set(),
        forcedRound: 0,
      }),
    ).toBeUndefined();
  });

  it("bounds evidence supplied to the semantic assessor", () => {
    const requiredFacets = inferRequiredEvidenceFacets("詳しく調査して");
    const message = buildEvidenceMatrixUserMessage({
      question: "詳しく調査して",
      requiredFacets,
      sources: Array.from({ length: 20 }, (_, index) => ({
        title: `source ${index}`,
        url: `https://example${index}.com/path`,
        publishedAt: null,
      })),
      evidenceParts: Array.from({ length: 20 }, () => "x".repeat(5_000)),
    });

    expect(message.length).toBeLessThan(17_000);
    expect(message).toContain("<required_facets>");
    expect(message).toContain("<source_data>");
  });
});
