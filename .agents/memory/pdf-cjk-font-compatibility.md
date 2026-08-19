---
name: PDF用CJKフォント互換性
description: Nix環境でpdf-libが日本語PDFに埋め込めるフォント形式の制約
---

日本語PDF用には、単体ファイルの静的TTF/OTFを選ぶ。fontconfigが日本語対応として返しても、可変TTCコレクションは利用可能と見なさない。

**Why:** `pdf-lib` と `@pdf-lib/fontkit` は可変TTCを読み込めても、レイアウトやサブセット作成を行えず、`layout is not a function` / `createSubset is not a function` で失敗する。静的IPAex TTFは埋め込みとサブセット作成が成功した。

**How to apply:** NixでCJKフォントを追加・変更したときは、ファイル存在確認だけでなく、日本語文字を描画してPDF保存まで行う診断を実行する。候補探索では `.ttc` を除外し、静的 `.ttf` / `.otf` を優先する。

**2026-08-20 追記:** フォントの charset に ASCII(0x21-0x7E) が含まれることも必ず確認する。サーバーイメージ向けの DroidSansFallbackFull ビルドはラテン文字・数字のグリフを一切持たず、日本語PDF内の数字がすべて豆腐になった（`fc-query --format '%{charset}'` で `20-7e` があるか確認）。同梱フォントは IPA Gothic（ASCII+CJK両対応、サブセット埋め込み可、IPAフォントライセンスv1.0）に切替済み。Droid系では pdf-lib のサブセット作成も壊れていたが、IPA Gothic では `subset: true` が正常動作し、PDF サイズも MB 級から KB 級に戻った。