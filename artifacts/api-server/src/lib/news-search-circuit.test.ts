import { describe, expect, it } from "vitest";
import {
  buildNewsFastPathQueries,
  buildNewsSearchCircuit,
  isNewsFastPathQuestion,
} from "./news-search-circuit";

const NOW = new Date("2026-09-07T16:30:00.000Z");

describe("news search circuit", () => {
  it("builds a bounded broad-headline circuit with a concrete JST date", () => {
    expect(buildNewsSearchCircuit("今日のニュースをまとめて", NOW)).toEqual({
      kind: "news",
      mode: "headlines",
      temporalScope: "today",
      dateAnchor: "2026-09-08",
      queries: [
        "2026-09-08 日本 国内 主要ニュース 公式 報道",
        "2026-09-08 国際 主要ニュース 公式 報道",
        "2026-09-08 最新ニュース 主要報道",
      ],
    });
    expect(
      buildNewsFastPathQueries("今日のニュースについて分かるか？", NOW),
    ).toEqual([
      "2026-09-08 日本 国内 主要ニュース 公式 報道",
      "2026-09-08 国際 主要ニュース 公式 報道",
      "2026-09-08 最新ニュース 主要報道",
    ]);
  });

  it("preserves a topic instead of replacing it with generic headlines", () => {
    const circuit = buildNewsSearchCircuit("OpenAIの最新ニュースを教えて", NOW);

    expect(circuit).toMatchObject({
      mode: "topic",
      topic: "OpenAI",
      dateAnchor: "2026-09-08",
    });
    expect(circuit?.queries).toHaveLength(3);
    expect(circuit?.queries.every((query) => query.includes("OpenAI"))).toBe(
      true,
    );
    expect(circuit?.queries[0]).toBe("2026-09-08 OpenAI ニュース");
  });

  it("anchors yesterday prompts to the previous JST calendar date", () => {
    expect(buildNewsSearchCircuit("昨日の日銀ニュース", NOW)).toMatchObject({
      mode: "topic",
      temporalScope: "yesterday",
      dateAnchor: "2026-09-07",
      topic: "日銀",
    });
  });

  it("accepts a recent explicit date but leaves old news to historical search", () => {
    expect(
      buildNewsSearchCircuit("2026年9月7日の主要ニュース", NOW),
    ).toMatchObject({
      dateAnchor: "2026-09-07",
      temporalScope: "yesterday",
    });
    expect(buildNewsSearchCircuit("2024年のOpenAIニュース", NOW)).toBeNull();
    expect(isNewsFastPathQuestion("2024年のOpenAIニュース", NOW)).toBe(false);
    expect(buildNewsFastPathQueries("2024年のOpenAIニュース", NOW)).toEqual([]);
  });

  it("supports English topic prompts and ignores meta questions about the word", () => {
    const circuit = buildNewsSearchCircuit(
      "latest news about TypeScript 7",
      NOW,
    );
    expect(circuit).toMatchObject({
      mode: "topic",
      topic: "TypeScript 7",
    });
    expect(circuit?.queries[0]).toBe("2026-09-08 TypeScript 7 latest news");
    expect(buildNewsSearchCircuit('What does the word "news" mean?', NOW)).toBe(
      null,
    );
  });
});
