---
name: Incremental Markdown safety boundaries
description: Compatibility rules for freezing streamed Markdown blocks without changing CommonMark/GFM meaning.
---

ストリーミングMarkdownは、空行で閉じたことが確認できるブロックだけを固定し、未確定末尾を既存の全文Markdown rendererへ渡す。リスト・引用・フェンスは後続入力との結合可能性が残る限り末尾側に保持する。reference definition、reference-style link、HTMLは過去の構造を変え得るため、検出時はストリーミング中でも全文描画へfallbackする。分割したブロック間の改行テキストは最終DOM相当性のため保持する。

**Why:** CommonMark/GFMの後続入力依存を推測で分割すると、見出し・リスト・引用・参照リンクの意味やcitation変換が通常描画とずれるため。

**How to apply:** 新しいMarkdown構文やrenderer最適化を追加するときは、まず危険構文をfallback側へ置き、incremental結果と全文結果の代表ケース差分、および確定ブロックの再render抑制をテストする。