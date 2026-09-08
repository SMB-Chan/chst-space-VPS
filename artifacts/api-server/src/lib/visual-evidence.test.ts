import { describe, expect, it, vi } from "vitest";

import {
  formatVisualEvidenceForAudit,
  formatVisualEvidenceForContext,
  isVisualSearchRequest,
  transcribeVisualEvidence,
  type VisualCandidate,
  type WebVisualEvidence,
} from "./visual-evidence";

describe("isVisualSearchRequest", () => {
  it("detects map, route, and location queries", () => {
    expect(isVisualSearchRequest("東京タワーの周辺地図を見せて")).toBe(true);
    expect(
      isVisualSearchRequest("渋谷駅から原宿駅までのルート案内と路線図"),
    ).toBe(true);
    expect(isVisualSearchRequest("羽田空港のフロアマップ")).toBe(true);
    expect(isVisualSearchRequest("show me the map of Kyoto")).toBe(true);
  });

  it("detects graph, chart, and statistics diagram queries", () => {
    expect(isVisualSearchRequest("日本の人口推移グラフを確認したい")).toBe(
      true,
    );
    expect(isVisualSearchRequest("売上構成比の円グラフ")).toBe(true);
    expect(isVisualSearchRequest("show me the performance chart")).toBe(true);
  });

  it("rejects purely theoretical or definitional requests", () => {
    expect(isVisualSearchRequest("地図の歴史について教えて")).toBe(true);
    expect(isVisualSearchRequest("マップの定義とは？")).toBe(false);
    expect(isVisualSearchRequest("グラフ理論のアルゴリズムとは？")).toBe(false);
    expect(isVisualSearchRequest("what is the definition of a map")).toBe(
      false,
    );
  });

  it("rejects ordinary queries", () => {
    expect(isVisualSearchRequest("明日の天気を教えて")).toBe(false);
    expect(isVisualSearchRequest("おすすめのラーメン屋")).toBe(false);
    expect(isVisualSearchRequest("TypeScriptの型定義の方法")).toBe(false);
  });
});

describe("transcribeVisualEvidence", () => {
  const candidates: Array<
    VisualCandidate & { sourceUrl: string; sourceTitle: string }
  > = [
    {
      sourceUrl: "https://example.com/map",
      sourceTitle: "東京観光マップ",
      elementType: "map",
      caption: "浅草周辺地図",
      alt: "浅草駅と浅草寺の位置関係",
      imageDataUrl: "data:image/png;base64,mapdata123",
    },
    {
      sourceUrl: "https://example.com/chart",
      sourceTitle: "人口統計2026",
      elementType: "chart",
      caption: "年代別推移",
      imageDataUrl: "data:image/png;base64,chartdata456",
    },
  ];

  it("transcribes candidates with vision bridge when available", async () => {
    const transcriber = vi
      .fn()
      .mockResolvedValueOnce(
        "浅草寺は浅草駅から北に約300mの位置にあり、雷門を通る直進ルートです。",
      )
      .mockResolvedValueOnce("65歳以上人口は30%に達し、2020年比で2%増加。");

    const result = await transcribeVisualEvidence(
      candidates,
      "浅草の場所と人口推移",
      transcriber,
    );
    expect(result).toHaveLength(2);
    expect(result[0].transcript).toContain("浅草寺は浅草駅から北に約300m");
    expect(result[1].transcript).toContain("65歳以上人口は30%");
  });

  it("falls back to metadata when vision bridge is unavailable", async () => {
    const result = await transcribeVisualEvidence(
      candidates,
      "浅草の場所",
      undefined,
    );
    expect(result).toHaveLength(2);
    expect(result[0].transcript).toContain("浅草周辺地図");
    expect(result[0].transcript).toContain("浅草駅と浅草寺の位置関係");
  });

  it("handles transcription failure gracefully", async () => {
    const transcriber = vi.fn().mockRejectedValue(new Error("Vision timeout"));

    const result = await transcribeVisualEvidence(
      [candidates[0]],
      "浅草の場所",
      transcriber,
    );
    expect(result).toHaveLength(1);
    expect(result[0].transcript).toBe("浅草周辺地図");
  });
});

describe("formatVisualEvidenceForContext and formatVisualEvidenceForAudit", () => {
  const evidences: WebVisualEvidence[] = [
    {
      sourceUrl: "https://example.com/map",
      sourceTitle: "店舗案内",
      elementType: "map",
      caption: "アクセスマップ",
      imageDataUrl: "data:image/png;base64,...",
      transcript: "駅から東へ直進200m、交差点の右角に店舗。",
    },
  ];

  it("formats context properly with markdown headings and details", () => {
    const formatted = formatVisualEvidenceForContext(evidences);
    expect(formatted).toContain("【Webページ掲載の図・地図・図表情報】");
    expect(formatted).toContain(
      "[図表1] 出典: 店舗案内 (https://example.com/map)",
    );
    expect(formatted).toContain("- 種別: 地図・位置案内");
    expect(formatted).toContain("- 視覚的書き起こし内容:\n駅から東へ直進200m");
  });

  it("formats audit text concisely for fact-checking", () => {
    const formatted = formatVisualEvidenceForAudit(evidences);
    expect(formatted).toContain("【視覚証拠データ（図・地図等）】");
    expect(formatted).toContain("[視覚1] 出典: 店舗案内");
    expect(formatted).toContain("読み取り事実: 駅から東へ直進200m");
  });
});
