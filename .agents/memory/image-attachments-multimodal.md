---
name: 画像添付のマルチモーダル変換
description: 構造化添付、保存互換形式、サイズ制限、モデル別の画像対応可否
---

## 現行プロトコル

新規送信は本文と添付を分離する。フロントは次のJSONを送る。

```json
{
  "content": "ユーザーの質問",
  "attachments": [
    { "kind": "image", "name": "sample.png", "content": "data:image/png;base64,..." },
    { "kind": "file", "name": "notes.md", "content": "UTF-8 text" }
  ]
}
```

サーバーの `message-content.ts` が検証し、Vision対応モデルには `text` と
`image_url` のstructured contentへ変換する。base64を通常テキストとしてモデルや
Web検索判定へ流してはならない。

DB・楽観的UIでは後方互換のため `CS_ATTACHMENTS_V1:` 形式を使う。旧
`[Image: ...]` / `[File: ...]` 形式も読み取り専用で維持する。プロトコルを変更する際は、
フロント送信、サーバーパーサー、履歴復元、表示パーサー、OpenAPI、生成型、テストを
同時に更新する。

## 制限と安全策

- 画像: JPEG / PNG / GIF / WebP。SVGは受け付けない。
- 最大5件、画像1件10MB、テキスト1件1MB、添付合計20MB、テキスト合計2MB。
- 対象POSTだけ30MB JSON parserを使い、認証とAI利用量ガードを先に通す。
- `kind` を正とし、互換フィールド `isBase64` と矛盾する入力は拒否する。base64の正規形とPNG/JPEG/GIF/WebPのシグネチャも照合する。
- テキスト添付は信頼できないデータとして明示し、添付内の命令を上位指示として扱わない。
- プライベートセッションの過去添付は、各ターンでbase64を再送し続けない。質問と名前だけを履歴へ残す。
- vision可否はモデル一覧の `supportsVision` をフロント（送信前）とサーバー（400応答）の両方で確認する。
- DashScopeは極小画像を拒否する場合があるため、検証画像は十分な寸法を持たせる。
