---
name: AIプロバイダー別パラメータ
description: OpenAIとDashScope互換APIでのchat.completionsパラメータ差分
---

## ルール
複数プロバイダーを1つのチャットバックエンドで切り替える場合、トークン上限の
パラメータ名をプロバイダー別に切り替える:
- OpenAI (Replit AI Integrations経由): `max_completion_tokens`
- DashScope OpenAI互換モード: `max_tokens`

**Why:** OpenAIの新しいモデルは `max_tokens` を渡すと 400
"Unsupported parameter" で失敗する。逆パターンの互換性も保証されない。

**How to apply:** モデル→プロバイダーの解決結果 (provider) で分岐する。
モデルIDのプレフィックス判定（"o"で始まる等）は誤爆するため使わない。
