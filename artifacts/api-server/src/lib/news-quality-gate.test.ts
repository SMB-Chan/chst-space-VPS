import { describe, expect, it } from "vitest";
import { assessNewsRetrieval, filterNewsResults } from "./news-quality-gate";
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
});
