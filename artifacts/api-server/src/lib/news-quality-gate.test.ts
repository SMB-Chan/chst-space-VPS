import { describe, expect, it } from "vitest";
import {
  assessNewsRetrieval,
  buildNewsFastPathQueries,
  filterNewsResults,
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

  it("rewrites news queries with a concrete JST date and bounds fan-out", () => {
    expect(
      buildNewsFastPathQueries(
        "今日のニュースについて分かるか？",
        new Date("2026-09-07T16:30:00.000Z"),
      ),
    ).toEqual([
      "2026-09-08 日本 国内 主要ニュース 公式 報道",
      "2026-09-08 国際 主要ニュース 公式 報道",
      "2026-09-08 最新ニュース 主要報道",
    ]);
  });
});
