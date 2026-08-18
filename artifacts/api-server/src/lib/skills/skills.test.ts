import { describe, expect, it } from "vitest";
import { composeSkillSearchQuery, matchSkills } from "./index";

describe("matchSkills", () => {
  it("activates finance analysis on market questions", () => {
    const hits = matchSkills("トヨタの株価と今期決算を分析して");
    expect(hits.map((s) => s.id)).toContain("finance-analysis");
  });

  it("stays off for unrelated chat", () => {
    expect(matchSkills("今日の東京の天気は？")).toEqual([]);
    expect(matchSkills("この画像の内容を説明して")).toEqual([]);
  });
});

describe("composeSkillSearchQuery", () => {
  it("appends the finance search hint when forced", () => {
    const skills = matchSkills("NVDAのバリュエーションは高い？");
    const query = composeSkillSearchQuery("NVDAのバリュエーションは高い？", skills);
    expect(query).toContain("NVDA");
    expect(query).toContain("株価");
  });
});
