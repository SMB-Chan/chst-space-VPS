---
name: 画像添付のマルチモーダル変換
description: チャットの画像添付をAIモデルへ送る際の形式変換と、モデル別の画像対応可否の扱い
---

## ルール
画像添付はフロントで `[Image: 名前]\n\n<data URL>\n\n---\n\nUser question: <質問>` 形式の
文字列としてDBに保存される。モデルへ送る直前にサーバー側で正規表現で分解し、
vision対応モデルには `content` 配列（text + image_url パーツ）へ変換する。
文字列のままbase64を送ると、OpenAI/Qwenともに画像として認識されない。

**Why:** 「Alibaba Cloudモデルが画像を読めない」という報告の原因は、
base64データURLを通常テキストとして送信していたこと。structured contentに
変換すれば Qwen3.x 系・GPT系・o4-mini はすべて画像を読める（Token Planエンドポイントで検証済み）。
DeepSeek V4 Pro と GLM-5.2 は画像非対応（送信は通るが画像を無視して当てずっぽうで回答するため危険）。

**How to apply:**
- vision可否は `supportsVision` フラグでフロント（送信前ブロック＋エラー表示）と
  サーバー（400応答）の両方で管理。モデル追加時は両方更新する。
- 画像を含む質問をWeb検索判定に渡すときは、質問テキスト部分のみを渡す
  （base64を検索パイプラインに流さない）。
- DashScopeは極小画像（幅・高さ10px以下）を invalid_parameter_error で拒否する。
  検証には10px超のテスト画像を使うこと。
- 送信前ブロック時はUI側で入力・添付を保持する（onSendがfalseを返すプロトコル）。
