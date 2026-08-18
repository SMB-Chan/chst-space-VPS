---
name: DashScope接続
description: Alibaba Cloud Model Studio (DashScope) 接続時のエンドポイント・キー検証の注意点
---

## ルール
このユーザーのAlibaba Cloud契約は「Token Plan」で、標準のリージョン共通URL
（dashscope-intl.aliyuncs.com など）ではなく専用エンドポイント
`https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` を使う。
ベースURLは環境変数 `DASHSCOPE_BASE_URL`（shared）で設定済み。

**Why:** 標準URLでは有効なAPIキーでも `invalid_api_key` (401) になり、キー不正と
区別がつかない。実際にはキーは正しく、エンドポイント違いが原因だった。

**How to apply:**
- Qwen/DashScopeの401はキー再発行を疑う前にベースURLを確認する。
- 利用可能なモデルはハードコードせず `GET {BASE_URL}/models` で確認する。
  Token Planではモデル名が標準の `qwen-max` 等と異なる（例: `qwen3.8-max`）。
- キー入力ミスの診断は値を表示せず、長さ・プレフィックス・文字種のみ検査する。
  過去に画面表示用の省略キー（`...`入り）が貼られたことがある。
