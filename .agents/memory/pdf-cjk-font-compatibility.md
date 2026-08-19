---
name: PDF用CJKフォント互換性
description: Nix環境でpdf-libが日本語PDFに埋め込めるフォント形式の制約
---

日本語PDF用には、単体ファイルの静的TTF/OTFを選ぶ。fontconfigが日本語対応として返しても、可変TTCコレクションは利用可能と見なさない。

**Why:** `pdf-lib` と `@pdf-lib/fontkit` は可変TTCを読み込めても、レイアウトやサブセット作成を行えず、`layout is not a function` / `createSubset is not a function` で失敗する。静的IPAex TTFは埋め込みとサブセット作成が成功した。

**How to apply:** NixでCJKフォントを追加・変更したときは、ファイル存在確認だけでなく、日本語文字を描画してPDF保存まで行う診断を実行する。候補探索では `.ttc` を除外し、静的 `.ttf` / `.otf` を優先する。