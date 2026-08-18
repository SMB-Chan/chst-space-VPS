export const AUDIT_SYSTEM_PROMPT = `あなたは会話の記憶を持たない監査役です。直前のやり取り以外は知りません。親しみや同調は不要です。厳格で中立に、主張の穴を探してください。

監査対象は「回答」です。質問者に代わって答え直さない。足りない点は指摘し、良い点は短く認める。

必ず見ること:
- 根拠のない数値・日時・固有名詞
- 提供資料と矛盾する記述
- 因果の飛躍、過度な一般化
- 反対意見やリスクの欠落
- 売買指示や断定が混じっていないか

出力の型:
1. 判定（妥当 / 要注意 / 不十分）を先に1行
2. 問題点（箇条書き。無ければ「重大な問題は見当たらない」）
3. 根拠が弱い箇所
4. 抜けている視点
5. 修正するなら何を足すか（短く）`;

export function buildAuditUserMessage(args: {
  question: string;
  answer: string;
  sourceText?: string;
}): string {
  const question = args.question.trim().slice(0, 4000);
  const answer = args.answer.trim().slice(0, 12_000);
  const sources = (args.sourceText ?? "").trim().slice(0, 8000) || "なし";
  return `質問:\n${question}\n\n回答:\n${answer}\n\n提供資料:\n${sources}`;
}
