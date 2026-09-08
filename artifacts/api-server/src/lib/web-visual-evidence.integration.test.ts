import { describe, expect, it } from "vitest";
import {
  formatVisualEvidenceForAudit,
  formatVisualEvidenceForContext,
  isVisualSearchRequest,
  type WebVisualEvidence,
} from "./visual-evidence";
import {
  AUDIT_SYSTEM_PROMPT,
  buildAuditUserMessage,
  compactAuditSourceText,
} from "./audit";

describe("web visual evidence & audit integration", () => {
  describe("isVisualSearchRequest detection", () => {
    it("identifies queries asking for maps, charts, diagrams, and radar", () => {
      expect(isVisualSearchRequest("渋谷駅の構内図と出口マップを教えて")).toBe(
        true,
      );
      expect(isVisualSearchRequest("2026年GDP推移グラフの数値を分析して")).toBe(
        true,
      );
      expect(
        isVisualSearchRequest("このシステムの構成図・アーキテクチャ図を見たい"),
      ).toBe(true);
      expect(isVisualSearchRequest("関東の雨雲レーダーと今後の推移")).toBe(
        true,
      );
    });

    it("filters out definitions, meta-explanations, and ordinary text queries", () => {
      expect(isVisualSearchRequest("マインドマップとは何ですか？")).toBe(false);
      expect(isVisualSearchRequest("フローチャートの定義と語源")).toBe(false);
      expect(isVisualSearchRequest("TypeScriptのinterfaceとtypeの違い")).toBe(
        false,
      );
    });
  });

  describe("formatVisualEvidenceForContext & formatVisualEvidenceForAudit", () => {
    const mockEvidences: WebVisualEvidence[] = [
      {
        sourceUrl: "https://example.com/tokyo-station",
        sourceTitle: "東京駅ガイド",
        elementType: "map",
        caption: "八重洲口・丸の内口アクセスマップ",
        alt: "周辺地図",
        imageDataUrl: "data:image/jpeg;base64,mockdata",
        transcript:
          "八重洲北口改札の北側に新幹線改札口、丸の内中央口前にタクシー乗り場がある。",
      },
      {
        sourceUrl: "https://example.com/growth-chart",
        sourceTitle: "年度別売上推移",
        elementType: "chart",
        caption: "2024-2026年売上高推移",
        imageDataUrl: "data:image/jpeg;base64,mockdata2",
        transcript:
          "X軸は2024〜2026年、Y軸は百万円単位。2024年: 120百万円、2025年: 185百万円、2026年: 240百万円。",
      },
    ];

    it("formats visual evidence into Markdown for main LLM reasoning", () => {
      const context = formatVisualEvidenceForContext(mockEvidences);
      expect(context).toContain("【Webページ掲載の図・地図・図表情報】");
      expect(context).toContain("[図表1] 出典: 東京駅ガイド");
      expect(context).toContain("- 種別: 地図・位置案内");
      expect(context).toContain("八重洲北口改札の北側に新幹線改札口");
      expect(context).toContain("[図表2] 出典: 年度別売上推移");
      expect(context).toContain("- 種別: グラフ・統計図");
      expect(context).toContain("2026年: 240百万円");
    });

    it("formats concise objective facts for audit model verification", () => {
      const auditText = formatVisualEvidenceForAudit(mockEvidences);
      expect(auditText).toContain("【視覚証拠データ（図・地図等）】");
      expect(auditText).toContain("[視覚1] 出典: 東京駅ガイド");
      expect(auditText).toContain("種別: map");
      expect(auditText).toContain("八重洲北口改札の北側に新幹線改札口");
      expect(auditText).toContain("[視覚2] 出典: 年度別売上推移");
      expect(auditText).toContain("2026年: 240百万円");
    });

    it("wires visual evidence into buildAuditUserMessage via <visual_data> and instructs audit model", () => {
      const visualAuditText = formatVisualEvidenceForAudit(mockEvidences);
      const auditPrompt = buildAuditUserMessage({
        question: "東京駅の八重洲口から新幹線への行き方を教えて",
        answer:
          "八重洲北口改札の北側に新幹線改札口があります。また2026年の売上は240百万円でした。",
        sourceText: "東京駅の概要テキスト...",
        visualText: visualAuditText,
      });

      expect(auditPrompt).toContain("<visual_data>");
      expect(auditPrompt).toContain("八重洲北口改札の北側に新幹線改札口");
      expect(auditPrompt).toContain("</visual_data>");
      expect(AUDIT_SYSTEM_PROMPT).toContain(
        "提供資料（Webテキストおよび図・地図・グラフ等の視覚データ書き起こし）と矛盾する記述",
      );
      expect(AUDIT_SYSTEM_PROMPT).toContain(
        "根拠のない数値・日時・固有名詞・地図上の位置関係",
      );
    });

    it("ensures compactAuditSourceText prioritizes visual blocks when answer mentions visual elements", () => {
      const longText = "A".repeat(8000);
      const visualBlock =
        "【Webページ掲載の図・地図・図表情報】\n[図表1] 出典: 地図\n八重洲北口と丸の内出口の位置関係";
      const fullSource = `${longText}\n\n${visualBlock}\n\n${longText}`;
      const answer = "図表1の地図によると、八重洲北口と丸の内出口の位置関係は…";

      const compacted = compactAuditSourceText(fullSource, answer);
      expect(compacted).toContain("【Webページ掲載の図・地図・図表情報】");
      expect(compacted).toContain("八重洲北口と丸の内出口の位置関係");
    });
  });
});
