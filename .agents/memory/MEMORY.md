# Memory Index

- [DashScope接続](dashscope-connection.md) — Token Plan契約はリージョン共通URLでなく専用エンドポイント必須。モデル一覧は /models で動的確認。
- [AIプロバイダー別パラメータ](ai-provider-params.md) — OpenAIはmax_completion_tokens、DashScope互換はmax_tokens。混在チャットでは切替必須。
- [Web検索の実装方式](web-search-approach.md) — tool callingでなく前段検索（DDG HTMLエンドポイント、キー不要）でモデル非依存に。
- [SSE+楽観的UIの二重表示](sse-optimistic-ui-duplication.md) — 「二重送信」報告はまずDBで送信2件か表示2件か切り分け。再取得完了を待ってからストリーミング状態をクリア。
- [画像添付のマルチモーダル変換](image-attachments-multimodal.md) — 保存は文字列形式、送信直前にstructured contentへ変換。vision可否はフロントとサーバー両方で管理。
- [PDF用CJKフォント互換性](pdf-cjk-font-compatibility.md) — fontconfigで見つかる可変TTCはpdf-lib非互換。単体の静的TTF/OTFを使う。
- [マージ後セットアップ](post-merge-setup.md) — frozen install後にDBライブラリの生成型を再ビルドし、依存変更時はlockfileも同期する。
- [GitHub API書き込み制限](github-api-rate-limit.md) — GitHub連携のgit-data更新は毎秒制限があるため、blob作成を並列化せず間隔を空ける。
- [Qwen Realtime transport](qwen-realtime-transport.md) — Qwen Audio RealtimeはWorkspace WSS、PTT null、16kHz入力/24kHz出力、短命チケット中継を前提にする。
- [起動時ヘルスチェック](startup-readiness.md) — DBスキーマ初期化前にlistenし、準備中は503、完了後に200を返してデプロイ監視の起動レースを避ける。
- [添付解析workerのbuild](attachment-worker-build.md) — logging pluginの追加entrypointと衝突するため、terminable workerは別bundleとして明示出力する。
- [Git履歴のAPI復元](github-history-reconstruction.md) — GitHub Git Data APIではblob/treeを先に揃え、親treeとcommit metadataを厳密に渡してSHA一致を検証する。
