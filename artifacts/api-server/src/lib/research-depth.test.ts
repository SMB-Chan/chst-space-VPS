import { describe, expect, it } from "vitest";
import {
  buildForcedGapSearch,
  buildResearchGapInstruction,
  classifyResearchDepth,
  hasSufficientResearchCoverage,
  researchCoverage,
  researchDepthPolicy,
  selectDeepPageFetches,
} from "./research-depth";

describe("research depth policy", () => {
  it("keeps simple lookups quick and promotes analytical requests to deep", () => {
    expect(classifyResearchDepth("東京の天気は？")).toBe("quick");
    expect(
      classifyResearchDepth("この問題の背景と原因を詳しく調査して比較して"),
    ).toBe("deep");
    expect(classifyResearchDepth("OpenAIの最近の発表を教えて")).toBe(
      "standard",
    );
  });

  it("requires broader evidence only for deep research", () => {
    const deep = researchDepthPolicy("根拠を含めて徹底的に調査して");
    const sparse = researchCoverage({
      sources: [
        { title: "A", url: "https://a.example/1" },
        { title: "B", url: "https://b.example/2" },
      ],
      successfulSearches: 1,
      fetchedPages: 0,
    });
    expect(deep.depth).toBe("deep");
    expect(hasSufficientResearchCoverage(deep, sparse)).toBe(false);
    expect(buildResearchGapInstruction(deep, sparse)).toContain(
      "調査はまだ不十分",
    );

    const enough = researchCoverage({
      sources: [
        { title: "A1", url: "https://a.example/1" },
        { title: "B1", url: "https://b.example/1" },
        { title: "C1", url: "https://c.example/1" },
        { title: "A2", url: "https://a.example/2" },
        { title: "B2", url: "https://b.example/2" },
        { title: "C2", url: "https://c.example/2" },
      ],
      successfulSearches: 2,
      fetchedPages: 2,
    });
    expect(hasSufficientResearchCoverage(deep, enough)).toBe(true);
  });

  it("selects bounded page fetches from distinct domains", () => {
    const calls = selectDeepPageFetches({
      sources: [
        { title: "A1", url: "https://a.example/1" },
        { title: "A2", url: "https://a.example/2" },
        { title: "B1", url: "https://b.example/1" },
      ],
      fetchedUrls: new Set(),
      remainingToolCalls: 2,
    });
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => JSON.parse(call.arguments).url)).toEqual([
      "https://a.example/1",
      "https://b.example/1",
    ]);
  });

  it("builds sanitized, bounded gap searches without repeating queries", () => {
    const coverage = {
      sourceCount: 2,
      domainCount: 2,
      successfulSearches: 1,
      fetchedPages: 2,
    };
    const first = buildForcedGapSearch({
      question: "AI規制の現状を詳しく調査して",
      coverage,
      forcedRound: 0,
      seenQueries: new Set(),
    });
    expect(first?.name).toBe("web_search");
    const parsed = JSON.parse(first?.arguments ?? "{}");
    expect(parsed.fetchContent).toBe(true);
    expect(parsed.query.length).toBeLessThanOrEqual(500);

    const repeated = buildForcedGapSearch({
      question: "AI規制の現状を詳しく調査して",
      coverage,
      forcedRound: 0,
      seenQueries: new Set([parsed.query]),
    });
    expect(repeated?.arguments).not.toBe(first?.arguments);
  });

  it("refuses to construct a forced query from secret-looking input", () => {
    const forced = buildForcedGapSearch({
      question: "api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890 を調査して",
      coverage: {
        sourceCount: 0,
        domainCount: 0,
        successfulSearches: 0,
        fetchedPages: 0,
      },
      forcedRound: 0,
      seenQueries: new Set(),
    });
    expect(forced).toBeUndefined();
  });
});
