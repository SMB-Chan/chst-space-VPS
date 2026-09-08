import { describe, expect, it } from "vitest";
import { planSearchQueries } from "./search-query-planner";

describe("planSearchQueries", () => {
  it("always keeps the sanitized original query first", () => {
    const plan = planSearchQueries("  LLM ハルシネーション 研究  ");
    expect(plan.queries[0]).toMatchObject({
      query: "LLM ハルシネーション 研究",
      role: "primary",
    });
    expect(plan.taskProfile.task).toBe("research");
  });

  it("uses a strict hard cap", () => {
    const plan = planSearchQueries("GitHub API 研究 最新", {
      maxQueries: 99,
      suggestedQueries: [
        { query: "GitHub API research latest papers", role: "cross_language" },
        { query: "GitHub API official documentation", role: "official" },
        { query: "GitHub API benchmark", role: "research" },
      ],
    });
    expect(plan.maxQueries).toBe(4);
    expect(plan.queries.length).toBeLessThanOrEqual(4);
  });

  it("adds a weather official-source angle without redundant freshness noise", () => {
    const plan = planSearchQueries("倉敷市 明日 天気");
    expect(plan.queries.some((item) => item.role === "official")).toBe(true);
    expect(plan.queries.some((item) => /気象庁/.test(item.query))).toBe(true);
    expect(plan.queries.some((item) => item.role === "freshness")).toBe(false);
    expect(plan.taskProfile.dimensions).toContain("primary_source");
  });

  it("does not append latest when the query already names a current time window", () => {
    const japanese = planSearchQueries("AIニュース 今週");
    const english = planSearchQueries("AI news this week");

    expect(japanese.queries.some((item) => item.role === "freshness")).toBe(
      false,
    );
    expect(english.queries.some((item) => item.role === "freshness")).toBe(
      false,
    );
  });

  it("adds research and technical angles only when relevant", () => {
    const research = planSearchQueries("LLM hallucination 研究 benchmark");
    expect(research.queries.some((item) => item.role === "research")).toBe(
      true,
    );

    const technical = planSearchQueries("open source SDK GitHub");
    expect(technical.queries.some((item) => item.role === "technical")).toBe(
      true,
    );

    const general = planSearchQueries("倉敷市 観光 おすすめ");
    expect(
      general.queries.some(
        (item) => item.role === "research" || item.role === "technical",
      ),
    ).toBe(false);
  });

  it("does not inject freshness into historical queries", () => {
    const plan = planSearchQueries("2024年 当時のAIニュース");
    expect(plan.taskProfile.temporalNeed).toBe("historical");
    expect(plan.queries.some((item) => item.role === "freshness")).toBe(false);
  });

  it("uses the extra query budget for fact-check dimensions", () => {
    const plan = planSearchQueries(
      "この主張は本当か？ 公式資料と反証も含めて検証して",
    );

    expect(plan.maxQueries).toBe(4);
    expect(plan.taskProfile.task).toBe("fact_check");
    expect(plan.queries.some((item) => item.role === "official")).toBe(true);
    expect(
      plan.queries.some(
        (item) =>
          item.role === "counterevidence" &&
          /反証|counterevidence/i.test(item.query),
      ),
    ).toBe(true);
  });

  it("adds a comparison lane while keeping the original query first", () => {
    const plan = planSearchQueries("ReactとVueのSDK設計を比較して");

    expect(plan.queries[0]?.query).toBe("ReactとVueのSDK設計を比較して");
    expect(plan.taskProfile.dimensions).toContain("comparison");
    expect(
      plan.queries.some(
        (item) =>
          item.role === "comparison" && /benchmark|比較/.test(item.query),
      ),
    ).toBe(true);
  });

  it("sanitizes optional planner suggestions and rejects secret-like variants", () => {
    const plan = planSearchQueries("OpenAI API latest", {
      suggestedQueries: [
        { query: "OpenAI API official docs", role: "official" },
        { query: "api_key=sk-abcdefghijklmnopqrstuvwxyz012345" },
      ],
    });
    expect(plan.queries.some((item) => item.query.includes("sk-"))).toBe(false);
    expect(plan.queries.some((item) => item.role === "official")).toBe(true);
  });

  it("returns no plan when the base query is unsafe", () => {
    const plan = planSearchQueries(
      "password=supersecretvalue012345678901234567890123",
    );
    expect(plan.queries).toEqual([]);
  });

  it("deduplicates equivalent suggestions", () => {
    const plan = planSearchQueries("OpenAI latest", {
      suggestedQueries: [
        { query: "OpenAI official docs", role: "official" },
        { query: "OpenAI   official   docs", role: "official" },
      ],
    });
    expect(
      plan.queries
        .filter((item) => item.role === "official")
        .map((item) => item.query),
    ).toEqual(["OpenAI official docs"]);
  });
});
