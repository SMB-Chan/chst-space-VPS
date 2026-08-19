# Memory Index

- [DashScope接続](dashscope-connection.md) — Token Plan契約はリージョン共通URLでなく専用エンドポイント必須。モデル一覧は /models で動的確認。
- [AIプロバイダー別パラメータ](ai-provider-params.md) — OpenAIはmax_completion_tokens、DashScope互換はmax_tokens。混在チャットでは切替必須。
- [Web検索の実装方式](web-search-approach.md) — tool callingでなく前段検索（DDG HTMLエンドポイント、キー不要）でモデル非依存に。
- [SSE+楽観的UIの二重表示](sse-optimistic-ui-duplication.md) — 「二重送信」報告はまずDBで送信2件か表示2件か切り分け。再取得完了を待ってからストリーミング状態をクリア。
- [画像添付のマルチモーダル変換](image-attachments-multimodal.md) — 保存は文字列形式、送信直前にstructured contentへ変換。vision可否はフロントとサーバー両方で管理。
- [PDF用CJKフォント互換性](pdf-cjk-font-compatibility.md) — fontconfigで見つかる可変TTCはpdf-lib非互換。単体の静的TTF/OTFを使う。
- [マージ後セットアップ](post-merge-setup.md) — frozen install後にDBライブラリの生成型を再ビルドし、依存変更時はlockfileも同期する。
