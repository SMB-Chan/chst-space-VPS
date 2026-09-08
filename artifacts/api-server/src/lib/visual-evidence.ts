import { logger } from "./logger";

export type VisualElementType = "map" | "chart" | "figure" | "canvas" | "image";

export interface VisualCandidate {
  elementType: VisualElementType;
  caption?: string;
  alt?: string;
  imageDataUrl: string;
}

export interface WebVisualEvidence {
  sourceUrl: string;
  sourceTitle: string;
  elementType: VisualElementType;
  caption?: string;
  alt?: string;
  imageDataUrl: string;
  transcript?: string;
}

export type VisualTranscriber = (args: {
  imageDataUrls: string[];
  question: string;
  signal?: AbortSignal;
}) => Promise<string>;

const VISUAL_REQUEST_RE =
  /地図|マップ|路線図|フロアマップ|アクセスマップ|ルート案内|位置関係|場所|所在地|グラフ|チャート|推移(?:図)?|統計(?:図)?|構成比|円グラフ|棒グラフ|折れ線グラフ|相関図|システム図|構成図|アーキテクチャ図|回路図|設計図|フローチャート|インフォグラフィック|図解|天気図|雨雲レーダー|衛星画像|maps?|floor\s*plans?|charts?|graphs?|diagrams?|infographics?|flowcharts?|schematics?|radar/i;

const VISUAL_META_RE =
  /(?:意味|定義|語源|翻訳|英訳|和訳|単語|由来|とは|アルゴリズム|mean(?:s|ing)?|definition|etymology|algorithm).{0,24}(?:地図|マップ|グラフ|チャート|diagram|graph|chart|map)|(?:地図|マップ|グラフ|チャート|diagram|graph|chart|map).{0,24}(?:意味|定義|語源|翻訳|英訳|和訳|単語|由来|とは|アルゴリズム|mean(?:s|ing)?|definition|etymology|algorithm)/i;

/**
 * Checks whether the user query would benefit from extracting visual information
 * (maps, charts, diagrams, weather radar, etc.) from web pages.
 */
export function isVisualSearchRequest(question: string): boolean {
  const normalized = question.replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  if (!VISUAL_REQUEST_RE.test(normalized)) return false;
  if (VISUAL_META_RE.test(normalized)) return false;
  return true;
}

/**
 * Transcribes visual evidence items using the supplied transcriber (e.g. Vision Bridge).
 * Keeps factual details (axes, values, labels, locations, legends) so both the
 * primary answering model and the audit model can fact-check against it.
 */
export async function transcribeVisualEvidence(
  candidates: Array<
    VisualCandidate & { sourceUrl: string; sourceTitle: string }
  >,
  question: string,
  transcriber?: VisualTranscriber,
  signal?: AbortSignal,
): Promise<WebVisualEvidence[]> {
  if (candidates.length === 0) return [];
  if (!transcriber) {
    return candidates.map((item) => ({
      ...item,
      transcript:
        item.caption || item.alt
          ? `（視覚要素の補助情報: ${[item.caption, item.alt].filter(Boolean).join(" / ")}）`
          : undefined,
    }));
  }

  const results: WebVisualEvidence[] = [];
  for (const item of candidates.slice(0, 2)) {
    if (signal?.aborted) break;
    try {
      const transcript = await transcriber({
        imageDataUrls: [item.imageDataUrl],
        question: `このWebページ画像（${item.sourceTitle}）の図・地図・表の客観的事実、数値、ラベル、位置関係を書き起こしてください。ユーザー質問: ${question}`,
        signal,
      });
      results.push({
        ...item,
        transcript: transcript.trim() || item.caption || item.alt,
      });
    } catch (error) {
      logger.warn(
        { sourceUrl: item.sourceUrl, error: String(error) },
        "Failed to transcribe visual evidence item; falling back to metadata",
      );
      results.push({
        ...item,
        transcript: item.caption || item.alt,
      });
    }
  }

  return results;
}

/**
 * Formats visual evidence into readable Markdown context for the main LLM.
 */
export function formatVisualEvidenceForContext(
  evidences: WebVisualEvidence[],
): string {
  if (evidences.length === 0) return "";
  const blocks: string[] = ["【Webページ掲載の図・地図・図表情報】"];

  for (let i = 0; i < evidences.length; i++) {
    const item = evidences[i];
    const index = i + 1;
    const typeLabel =
      item.elementType === "map"
        ? "地図・位置案内"
        : item.elementType === "chart"
          ? "グラフ・統計図"
          : item.elementType === "figure"
            ? "図解・図表"
            : item.elementType === "canvas"
              ? "動的描画要素"
              : "関連画像";

    blocks.push(
      `[図表${index}] 出典: ${item.sourceTitle} (${item.sourceUrl})`,
      `- 種別: ${typeLabel}`,
      item.caption ? `- キャプション: ${item.caption}` : "",
      item.alt ? `- 代替テキスト: ${item.alt}` : "",
      item.transcript
        ? `- 視覚的書き起こし内容:\n${item.transcript}`
        : "- （視覚的書き起こしなし）",
      "",
    );
  }

  return blocks.filter(Boolean).join("\n").trim();
}

/**
 * Formats visual evidence specifically for the audit model's source verification.
 * Emphasizes concrete data points, numbers, and map entities.
 */
export function formatVisualEvidenceForAudit(
  evidences: WebVisualEvidence[],
): string {
  if (evidences.length === 0) return "";
  const lines: string[] = ["【視覚証拠データ（図・地図等）】"];

  for (let i = 0; i < evidences.length; i++) {
    const item = evidences[i];
    lines.push(
      `[視覚${i + 1}] 出典: ${item.sourceTitle}`,
      `  種別: ${item.elementType}`,
      item.caption ? `  キャプション: ${item.caption}` : "",
      item.transcript
        ? `  読み取り事実: ${item.transcript.replace(/\n+/g, " ").slice(0, 500)}`
        : "",
    );
  }

  return lines.filter(Boolean).join("\n");
}
