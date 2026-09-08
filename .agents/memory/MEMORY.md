# Memory Index

- [DashScope接続](dashscope-connection.md) — Token Plan契約はリージョン共通URLでなく専用エンドポイント必須。モデル一覧は /models で動的確認。
- [AIプロバイダー別パラメータ](ai-provider-params.md) — OpenAIはmax_completion_tokens、DashScope互換はmax_tokens。混在チャットでは切替必須。
- [Web検索の実装方式](web-search-approach.md) — tool callingでなく前段検索（DDG HTMLエンドポイント、キー不要）でモデル非依存に。
- [SSE+楽観的UIの二重表示](sse-optimistic-ui-duplication.md) — 「二重送信」報告はまずDBで送信2件か表示2件か切り分け。再取得完了を待ってからストリーミング状態をクリア。
- [画像添付のマルチモーダル変換](image-attachments-multimodal.md) — 保存は文字列形式、送信直前にstructured contentへ変換。vision可否はフロントとサーバー両方で管理。
- [PDF用CJKフォント互換性](pdf-cjk-font-compatibility.md) — fontconfigで見つかる可変TTCはpdf-lib非互換。単体の静的TTF/OTFを使う。
- [マージ後セットアップ](post-merge-setup.md) — frozen install後にDBライブラリの生成型を再ビルドし、依存変更時はlockfileも同期する。
- [公開ビルドのセキュリティ検査](deployment-security-scan.md) — 公開ログが二度目のSecurity Scanで終わる場合はOSV監査で依存脆弱性を特定し、frozen installまで再確認する。
- [動的検索schedulerのテスト分離](search-scheduler-test-isolation.md) — 順位学習状態を持つschedulerは各テスト後にruntimeとhealthをリセットし、順序依存を防ぐ。
- [Incremental Markdownの安全境界](streaming-markdown-incremental.md) — 空行で確定したブロックだけ固定し、参照定義・参照リンク・HTMLは全文描画へ戻す。
- [Web回復の安全境界](web-recovery-guardrails.md) — 通常回答限定・1ターン1回・失敗時は初稿保持で、翻訳監査と検索回復を分離する。
- [Gitバックアップ履歴](git-backup-history.md) — 自動バックアップcommitが作業ブランチの親に現れることがあるため、履歴だけでなくtreeとstatusで成果物を確認する。
