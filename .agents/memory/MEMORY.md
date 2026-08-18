# Memory Index

- [DashScope接続](dashscope-connection.md) — Token Plan契約はリージョン共通URLでなく専用エンドポイント必須。モデル一覧は /models で動的確認。
- [AIプロバイダー別パラメータ](ai-provider-params.md) — OpenAIはmax_completion_tokens、DashScope互換はmax_tokens。混在チャットでは切替必須。
- [Web検索の実装方式](web-search-approach.md) — tool callingでなく前段検索（DDG HTMLエンドポイント、キー不要）でモデル非依存に。
