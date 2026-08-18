---
name: Web検索の実装方式
description: チャットAIのWeb検索はモデル非依存の前段検索方式を採用
---
ルール: AIのWeb検索はtool callingでなく前段方式（検索要否判定→検索→systemメッセージ注入）。
**Why:** OpenAIとDashScopeでtool calling対応差があり、モデル非依存にする必要があった。DuckDuckGo HTMLエンドポイントは検索APIキー不要。
**How to apply:** 検索機能を拡張する際もこの方式を維持。取得コンテンツは信頼できないデータとして区切り、サーバー側フェッチはSSRF対策（接続層でのプライベートアドレス遮断）必須。undiciのAgentをdispatcherに使う場合はNode組み込みfetchでなくundiciのfetchを使う（バージョン不一致で失敗する）。
