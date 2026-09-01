import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FactualityCard, normalizeFactualityReport } from "./factuality-card";

describe("FactualityCard", () => {
  it("renders verdicts and claim-to-source links", () => {
    const report = {
      status: "mixed" as const,
      summary: "根拠あり1件、追加確認が必要1件です。",
      claims: [
        {
          claim: "A社は2026年に発表した",
          verdict: "supported" as const,
          sourceIds: [2],
          reason: "[2]が直接記載",
        },
        {
          claim: "売上は2倍になった",
          verdict: "unknown" as const,
          sourceIds: [],
          reason: "根拠なし",
        },
      ],
      modelId: "qwen3.8-max",
      corrected: true,
    };
    const html = renderToStaticMarkup(<FactualityCard report={report} />);

    expect(html).toContain("一部は追加確認が必要");
    expect(html).toContain("根拠あり");
    expect(html).toContain("確認不能");
    expect(html).toContain('href="#source-2"');
    expect(html).toContain("本文修正済み");
  });
});

describe("normalizeFactualityReport", () => {
  it("accepts JSON history and rejects invalid status values", () => {
    expect(
      normalizeFactualityReport(
        JSON.stringify({
          status: "verified",
          summary: "ok",
          claims: [],
          modelId: "model",
          corrected: false,
        }),
      ),
    ).toMatchObject({ status: "verified", modelId: "model" });
    expect(
      normalizeFactualityReport({
        status: "certain",
        summary: "bad",
        claims: [],
        modelId: "model",
      }),
    ).toBeNull();
  });
});
