---
name: Web検索の実装方式
description: チャットAIのWeb検索はモデル非依存の前段検索方式と独自Search Coreを採用
---
ルール: AIのWeb検索はtool callingでなく前段方式（ヒューリスティック / 判定LLM → 検索 → systemメッセージ注入）を維持する。

検索基盤はSearXNG等の外部プロジェクトのコードをコピー・翻訳移植せず、公開されているアーキテクチャ・アルゴリズム・設計思想を参考にChat-Space向けに独自実装する。特に provider abstraction、並列fan-out、provider health、403/429/CAPTCHA/timeout時のcooldown、coverage判定、URL重複排除、domain diversity、weighted Reciprocal Rank Fusion をSearch Coreの責務とする。CAPTCHA突破、fingerprint偽装、IP偽装などのbot防御突破は実装しない。ブロックされたproviderは一定時間休止し、健全なproviderへフォールバックする。

**Why:** OpenAIとDashScopeでtool calling対応差があり、モデル非依存にする必要がある。また単一のHTML検索エンジンへ依存するとdatacenter IPへの403/429/CAPTCHAで検索全体が停止しやすい。複数providerを障害分離し、検索順位を融合する方が可用性・速度・保守性を高められる。外部AGPL実装のソースを取り込まず独自実装にすることで、Chat-Spaceの構成・ライセンス・TypeScript基盤へ適合させやすい。

**How to apply:** 検索機能を拡張する際も前段検索方式とSearch Core境界を維持する。API provider（SearXNG互換endpoint / Tavily / Exa / Brave等）はadapterとして扱い、Search Core自体は特定providerへ依存させない。初期fan-outはAPIコストとの兼ね合いで設定可能にし、coverage不足時のみ追加providerを並列実行する。DuckDuckGo HTML等は最終fallbackとして扱う。取得コンテンツは信頼できないデータとして区切り、サーバー側フェッチはSSRF対策（接続層でのプライベートアドレス遮断）必須。undiciのAgentをdispatcherに使う場合はNode組み込みfetchでなくundiciのfetchを使う（バージョン不一致で失敗する）。
