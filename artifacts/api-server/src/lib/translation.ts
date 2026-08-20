/**
 * Translation mode: when enabled, every user message is treated as text to
 * translate, so the user does not have to write "translate this to ..." each
 * time. The design leans on the LLM's strengths: the conversation history is
 * passed through as-is, so terminology, register, and nuance stay consistent
 * across turns, and inline adjustment requests ("もっとカジュアルに") are
 * understood as instructions about the previous translation.
 */

export type TranslationMode =
  | "auto"
  | "ja-en"
  | "en-ja"
  | "auto-ko"
  | "ja-ko"
  | "ko-ja"
  | "auto-zh"
  | "ja-zh"
  | "zh-ja";

const TRANSLATION_MODES: readonly TranslationMode[] = [
  "auto",
  "ja-en",
  "en-ja",
  "auto-ko",
  "ja-ko",
  "ko-ja",
  "auto-zh",
  "ja-zh",
  "zh-ja",
];

export function parseTranslationMode(raw: unknown): TranslationMode | undefined {
  return TRANSLATION_MODES.includes(raw as TranslationMode)
    ? (raw as TranslationMode)
    : undefined;
}

const DIRECTION_RULES: Record<TranslationMode, string> = {
  auto: "ユーザーの文章が日本語なら英語へ、日本語以外なら日本語へ翻訳する。",
  "ja-en": "ユーザーの文章をすべて日本語から英語へ翻訳する。",
  "en-ja": "ユーザーの文章をすべて英語から日本語へ翻訳する。",
  "auto-ko": "ユーザーの文章が日本語なら韓国語へ、韓国語なら日本語へ翻訳する。",
  "ja-ko": "ユーザーの文章をすべて日本語から韓国語へ翻訳する。",
  "ko-ja": "ユーザーの文章をすべて韓国語から日本語へ翻訳する。",
  "auto-zh":
    "ユーザーの文章が日本語なら中国語へ、中国語なら日本語へ翻訳する。中国語への翻訳では簡体字を使い、本土（中国大陸）の語彙・表現を優先する。",
  "ja-zh":
    "ユーザーの文章をすべて日本語から中国語へ翻訳する。中国語は簡体字を使い、本土（中国大陸）の語彙・表現を優先する。",
  "zh-ja": "ユーザーの文章をすべて中国語から日本語へ翻訳する。",
};

export function buildTranslationSystemPrompt(mode: TranslationMode): string {
  return `あなたはプロの翻訳者です。この会話では翻訳モードが有効になっています。

翻訳の方向:
- ${DIRECTION_RULES[mode]}

翻訳の方針:
- 直訳ではなく、意味とニュアンスを保った自然な訳文にする。
- 会話の履歴を参照し、用語・文体・敬語レベル・距離感を過去の訳文と一貫させる。
- 婉曲表現、皮肉、ユーモアなどのニュアンスは可能な限り維持する。
- 固有名詞・数値・日付・記号・箇条書きなどの書式は保持する。

出力の規則:
- 出力は訳文のみ。解説、注釈、「翻訳結果:」などの前置きは一切付けない。
- ユーザーの入力が翻訳対象ではなく訳文への調整指示（例:「もっとカジュアルに」「この用語を統一して」）の場合は、直前の訳文をその指示どおりに修正したものだけを返す。
- 原文が曖昧で訳が大きく分かれる場合だけ、訳文のあとに短い別訳を括弧で添えてよい。`;
}
