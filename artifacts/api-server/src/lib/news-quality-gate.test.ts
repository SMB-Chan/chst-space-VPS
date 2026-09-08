import { describe, expect, it } from "vitest";
import {
  assessNewsRetrieval,
  filterNewsResults,
  scoreNewsRelevance,
  type NewsRelevanceContext,
} from "./news-quality-gate";
import type { SearchResult } from "./search-parse";

function result(
  url: string,
  title: string,
  publishedAt: string | null = "2026-09-08T00:00:00.000Z",
): SearchResult {
  return {
    url,
    title,
    snippet: `${title} 最新の報道`,
    publishedAt,
  };
}

describe("news retrieval quality gate", () => {
  it("rejects search portals, errors, and product pages", () => {
    const candidates = [
      result("https://www.duckduckgo.com/", "DuckDuckGo"),
      result("https://www.meesho.com/error", "Meesho error page"),
      result("https://www.meesho.com/product/123", "商品 価格 ₹999"),
    ];

    expect(filterNewsResults(candidates)).toEqual([]);
    expect(
      assessNewsRetrieval({
        results: candidates,
        now: new Date("2026-09-08T04:00:00.000Z"),
      }),
    ).toMatchObject({
      quality: "poor",
      taskSuccess: "failed",
      acceptedSourceCount: 0,
    });
  });

  it("requires fresh results from multiple independent domains", () => {
    const results = [
      result("https://www.reuters.com/world/article-a", "速報: World news"),
      result(
        "https://www.bbc.com/news/article-b",
        "Breaking news: World update",
      ),
      result(
        "https://www.nhk.or.jp/news/article-c",
        "国内ニュース: 最新の発表",
      ),
    ];

    expect(
      assessNewsRetrieval({
        results,
        now: new Date("2026-09-08T04:00:00.000Z"),
      }),
    ).toMatchObject({
      quality: "good",
      taskSuccess: "succeeded",
      acceptedSourceCount: 3,
      freshSourceCount: 3,
      independentDomainCount: 3,
      officialOrMajorSourceCount: 3,
    });
  });

  it("accepts Google News RSS wrappers when publisher metadata is present", () => {
    const results = [
      {
        ...result(
          "https://news.google.com/rss/articles/one",
          "速報: World news",
        ),
        articleUrl: null,
        publisherName: "Reuters",
        publisherUrl: "https://www.reuters.com/world",
      },
      {
        ...result(
          "https://news.google.com/rss/articles/two",
          "Breaking news: World update",
        ),
        articleUrl: null,
        publisherName: "BBC",
        publisherUrl: "https://www.bbc.com/news",
      },
    ];

    expect(filterNewsResults(results)).toHaveLength(2);
    expect(
      assessNewsRetrieval({
        results,
        now: new Date("2026-09-08T04:00:00.000Z"),
      }),
    ).toMatchObject({
      quality: "good",
      independentDomainCount: 2,
      freshSourceCount: 2,
    });
  });

  it("deduplicates a resolved article seen through multiple result shapes", () => {
    const direct = result(
      "https://www.reuters.com/world/article-a",
      "速報: World news",
    );
    const wrapper = {
      ...result(
        "https://news.google.com/rss/articles/one",
        "速報: World news mirror",
      ),
      articleUrl: direct.url,
      publisherName: "Reuters",
      publisherUrl: "https://www.reuters.com/world",
    };

    expect(
      assessNewsRetrieval({
        results: [direct, wrapper],
        now: new Date("2026-09-08T04:00:00.000Z"),
      }),
    ).toMatchObject({
      acceptedSourceCount: 1,
      independentDomainCount: 1,
    });
  });

  it("deduplicates an unresolved Google News wrapper by publisher and title", () => {
    const direct = {
      ...result("https://www.reuters.com/world/article-a", "速報: World news"),
    };
    const wrapper = {
      ...result("https://news.google.com/rss/articles/one", "速報: World news"),
      articleUrl: null,
      publisherName: "Reuters",
      publisherUrl: "https://www.reuters.com/world",
    };

    expect(
      assessNewsRetrieval({
        results: [direct, wrapper],
        now: new Date("2026-09-08T04:00:00.000Z"),
      }),
    ).toMatchObject({
      acceptedSourceCount: 1,
      independentDomainCount: 1,
    });
  });

  it("preserves the initial circuit queries and one alternate query", () => {
    const report = assessNewsRetrieval({
      results: [
        result("https://www.reuters.com/world/article-a", "速報: World news"),
        result(
          "https://www.bbc.com/news/article-b",
          "Breaking news: World update",
        ),
      ],
      queries: ["q1", "q2", "q3", "q4"],
      now: new Date("2026-09-08T04:00:00.000Z"),
    });

    expect(report.queries).toEqual(["q1", "q2", "q3", "q4"]);
  });

  it("recognizes major publisher subdomains without trusting lookalikes", () => {
    const accepted = result(
      "https://jp.reuters.com/world/article-a",
      "World update",
    );
    const lookalike = result(
      "https://reuters.com.example.net/world/article-b",
      "World update",
    );

    const report = assessNewsRetrieval({
      results: [accepted, lookalike],
      now: new Date("2026-09-08T04:00:00.000Z"),
    });
    expect(report.officialOrMajorSourceCount).toBe(1);
  });

  it("rejects encyclopedic article-form pages unrelated to the news question", () => {
    const context: NewsRelevanceContext = {
      question: "今日の日本のニュースを教えて",
      dateAnchor: "2026-09-09",
      temporalScope: "today",
      mode: "headlines",
    };
    const candidates = [
      result(
        "https://ja.wikipedia.org/wiki/2026%E5%B9%B4",
        "2026年",
        "2026-09-09T00:00:00.000Z",
      ),
      result(
        "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup",
        "2026 FIFA World Cup",
        "2026-09-09T00:00:00.000Z",
      ),
      result(
        "https://en.wikipedia.org/wiki/History_of_Singapore",
        "History of Singapore",
        "2026-09-09T00:00:00.000Z",
      ),
    ];

    expect(filterNewsResults(candidates, context)).toEqual([]);
    const report = assessNewsRetrieval({
      results: candidates,
      context,
      now: new Date("2026-09-09T04:00:00.000Z"),
    });
    expect(report).toMatchObject({
      quality: "poor",
      acceptedSourceCount: 0,
      taskSuccess: "failed",
    });
    expect(report.rejected.every((item) => item.reason === "not-news")).toBe(
      true,
    );
  });

  it("keeps major publisher news that matches the date and headline intent", () => {
    const context: NewsRelevanceContext = {
      question: "今日の日本のニュースを教えて",
      dateAnchor: "2026-09-09",
      temporalScope: "today",
      mode: "headlines",
    };
    const results = [
      result(
        "https://www.nhk.or.jp/news/html/20260909/k10010000001.html",
        "速報: 国内の主要発表",
        "2026-09-09T01:00:00.000Z",
      ),
      result(
        "https://www.nikkei.com/article/DGXZQOUA09001/",
        "ニュース: 経済の最新動向",
        "2026-09-09T02:00:00.000Z",
      ),
    ];

    expect(filterNewsResults(results, context)).toHaveLength(2);
    expect(
      assessNewsRetrieval({
        results,
        context,
        now: new Date("2026-09-09T04:00:00.000Z"),
      }),
    ).toMatchObject({
      quality: "good",
      acceptedSourceCount: 2,
      freshSourceCount: 2,
    });
  });

  it("scores low relevance for off-topic news even when the URL looks like an article", () => {
    const context: NewsRelevanceContext = {
      question: "OpenAIの最新ニュース",
      dateAnchor: "2026-09-09",
      topic: "OpenAI",
      temporalScope: "today",
      mode: "topic",
    };
    const offTopic = result(
      "https://www.example-news.com/news/local-festival-guide",
      "地域のお祭りガイド",
      "2026-09-09T03:00:00.000Z",
    );
    const scores = scoreNewsRelevance(offTopic, context);
    expect(scores.topic).toBeLessThan(0.3);
    expect(scores.combined).toBeLessThan(0.38);
    expect(
      assessNewsRetrieval({
        results: [offTopic],
        context,
        now: new Date("2026-09-09T04:00:00.000Z"),
      }).rejected[0]?.reason,
    ).toBe("low-relevance");
  });
});
