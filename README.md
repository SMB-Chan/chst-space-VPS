# Chat-Space（AI Chat Space）

ファイルを添付して内容について質問できる、個人向けの AI チャットスペースです。

複数のモデル（OpenAI / Qwen など）を切り替え、Web 検索とドキュメント・画像添付に対応しています。会話は Clerk アカウントごとに保存されます。

元リポジトリ: [Replit Chat-Space](https://replit.com/@ibn5100/Chat-Space)

## できること

- OpenAI と Alibaba Cloud（DashScope）のモデル切替、推論レベル
- ストリーミング応答（SSE）
- Web 検索（DuckDuckGo、API キー不要）と参照元カード
- 画像・テキストファイルの添付
- 文書・音声の解析: PDF / ZIP / Word（docx）/ Excel（xlsx）/ PowerPoint（pptx）と音声（MP3 / WAV / M4A / OGG / FLAC / WebM）をサーバー側で決定論的にテキスト抽出（音声は設定済みプロバイダで文字起こし）して会話に渡します。ファイル由来のコードは実行しません
- 添付制限: 最大5件、画像・文書・音声1件10MB、テキスト1件1MB、テキスト合計2MB、全添付合計20MB（SVG・旧形式 .doc/.xls/.ppt 非対応）
- 長期会話の過去画像は最新の履歴を優先し、合計10MiB・最大4枚まで再送（現在のユーザーメッセージ画像はこの履歴枠の対象外）
- 会話履歴とユーザー単位の長期メモリをPostgreSQLへ保存し、設定画面から一括消去
- プライベートセッション（サーバーに残さず、長期メモリも参照・更新しない。PDF / Office生成は通常会話のみ）
- PWA（ホーム画面追加）と既定モデルの端末保存
- 金融の質問で「金融分析」スキルを自動適用（最新データ検索 + 分析フォーマット）
- 中立監査モード（別モデルが点検し、使用中のモデルが最終報告へ書き直す）
- 翻訳モード（自動（日⇄英 / 日⇄韓 / 日⇄中）と各固定方向。送るだけで翻訳。会話履歴を使って用語・文体・ニュアンスを維持し、「もっとカジュアルに」などの調整指示も受け付ける。中国語は簡体字・本土表現）
- 画像非対応モデル（DeepSeek / GLM）でも画像添付を利用可能にする vision ブリッジ（画像対応モデルが内容をテキスト転記してから回答・監査）
- LLM 生成 PDF / Word / Excel / PowerPoint のダウンロード（入力欄の形式ボタン、または「PDFでまとめて」などの自然言語でも指定可能）
- 生成ファイルを画像化し、Vision 対応 LLM がレイアウトを確認・修正する自己改善サイクル（最大2回の反復）

## スタック

| 層             | 技術                                                    |
| -------------- | ------------------------------------------------------- |
| フロント       | Vite, React 19, wouter, TanStack Query, Clerk, Tailwind |
| API            | Express 5                                               |
| DB             | PostgreSQL + Drizzle ORM                                |
| 検証           | Zod, drizzle-zod                                        |
| ワークスペース | pnpm workspaces, TypeScript 6.0                         |

## 構成

```
artifacts/ai-chat-space/   # フロント（@workspace/ai-chat-space）
artifacts/api-server/      # API（@workspace/api-server）
lib/db/                    # Drizzle スキーマ
lib/api-spec/              # OpenAPI → Orval のソース
lib/api-zod/               # 生成 Zod スキーマ
lib/api-client-react/      # 生成 React Query フック
```

## セットアップ

Node.js 22+ と pnpm、Postgres が必要です。

```bash
cp .env.example .env
# .env を編集して DATABASE_URL / Clerk / OpenAI キーを入れる

pnpm install
pnpm --filter @workspace/db run push   # スキーマを Postgres に反映（開発用）
```

### 起動

ターミナルを 2 つ使います。

```bash
# API（デフォルト :5000）
pnpm --filter @workspace/api-server run dev

# フロント（ローカルは PORT=5173 BASE_PATH=/）
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/ai-chat-space run dev
```

Vite は `/api` を `API_PROXY_TARGET`（未設定なら `http://127.0.0.1:5000`）へプロキシします。

### その他のコマンド

```bash
pnpm run typecheck
pnpm run test
pnpm run build
pnpm --filter @workspace/api-spec run codegen   # OpenAPI からフック / Zod を再生成
pnpm --filter @workspace/api-server run test:ssrf
pnpm run check:api-routes              # OpenAPI と Express の経路契約を照合
```

テストは Vitest です。`artifacts/api-server` と `artifacts/ai-chat-space` が対象です。

## 必要な環境変数

詳細は [`.env.example`](./.env.example) を見てください。

- `DATABASE_URL` — Postgres
- `CLERK_PUBLISHABLE_KEY` / `VITE_CLERK_PUBLISHABLE_KEY` — 認証
- `FRONTEND_URL` — APIへアクセスできるブラウザOrigin。カンマ区切り可。本番のクロスOrigin構成では必須
- `AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY` — OpenAI 互換エンドポイント（OpenAI凍結中は省略可）
- `AI_STREAM_MAX_ATTEMPTS` / `AI_STREAM_RETRY_BASE_MS` / `AI_STREAM_RETRY_MAX_MS` — ストリーム開始時の一時的な接続障害に対する最大試行回数とバックオフ（既定5回・750ms・6000ms。DashScopeの後半試行は思考と出力上限を軽量化。応答本文の送信後は二重表示防止のため再試行しない）
- `Xiaomi_Mimo_KEY` / `XIAOMI_API_KEY` — Xiaomi MiMo（前者を優先）。`XIAOMI_BASE_URL` の既定は `https://token-plan-sgp.xiaomimimo.com/v1`。同じキーで音声合成（`mimo-v2.5-tts` / `mimo-v2.5-tts-voicedesign`）と音声認識（`mimo-v2.5-asr`）も有効になる
- `DISABLE_OPENAI_MODELS` / `DISABLE_DASHSCOPE_MODELS` / `DISABLE_XIAOMI_MODELS` — `true` でモデル一覧・チャット・補助画像処理・音声認識／音声合成・Alibaba専門能力を凍結。現在の共有起動設定では OpenAI と DashScope が `true`。解除は `false` に変更してサーバーを再起動
- `DASHSCOPE_API_KEY` — Qwen 等を使う場合（任意）
- `ALIBABA_SPECIALIST_API_KEY` / `ALIBABA_SPECIALIST_WORKSPACE_ID` — 通常のAlibaba Model Studioワークスペース資格情報（任意。画像生成・画像編集・Qwen Audio TTS／Realtimeのカスタムバックエンド専門能力用。Token Plan Personal/Teamキーは使用せず、未設定時はcatalog-only）
- `ALIBABA_SPECIALIST_HTTP_BASE_URL` / `ALIBABA_SPECIALIST_TTS_WS_URL` / `ALIBABA_SPECIALIST_REALTIME_WS_URL` — 専門能力用の許可済みHTTPS/WSSエンドポイント（任意。詳細は[`.env.example`](./.env.example)）
- `AI_REQUESTS_PER_MINUTE` — チャット・メディア生成・リアルタイムセッション発行に対する、ユーザー単位・PostgreSQL共有のAIリクエスト上限（既定20/60秒、0で無効）
- `AI_MAX_CONCURRENT_REQUESTS` — ユーザー単位・全Autoscaleインスタンス共有の同時AI生成上限（既定2、0で無効）
- `AI_CONCURRENCY_LEASE_TTL_MS` — 同時実行leaseの失効時間（既定90000ms。実行中はheartbeat更新）
- `TRANSCRIBE_MODEL` — 音声添付の文字起こしモデル（任意。既定は `gpt-4o-mini-transcribe`、利用不可なら `whisper-1`、DashScope 設定時は Qwen ASR／paraformer-v2、Xiaomi MiMo 設定時は `mimo-v2.5-asr` の順に自動フォールバック。MiMo は wav と mp3 のみ受け付けるため、ほかの形式は ffmpeg で変換する）
- Token Plan の DashScope はリージョン共通 URL ではなく、専用エンドポイントが必要です

## モデル共通の記憶

通常チャットのモデル間で、ユーザーの好み・決定事項・進捗・出典付き知識を共有します。訂正履歴、失効と完全削除、期限切れの自動廃棄、文字数上限付きのコンテキスト取得に対応します。外部アプリ向けの認証付き `/api/memories` APIも利用できます。仕様と利用例は [共有記憶サービス](./docs/shared-memory.md) を参照してください。

## 安全性と運用上の注意

- 添付は本文と分離した構造化JSONで送信し、サーバー側で画像data URL・base64の正規形・画像シグネチャとUTF-8テキストを検証してからモデル入力へ変換します。`CS_ATTACHMENTS_V1:` はDB・表示互換用です。
- 文書・音声添付はクライアント申告のMIMEではなく実バイトのマジックナンバーで種別判定し、信頼済みパーサーでテキスト抽出（音声は文字起こし）した結果のみを保存・モデル入力にします。抽出結果はプロンプトインジェクション対策としてメッセージごとに乱数化した境界で「信頼できないデータ」として包みます。
- ZIPはセントラルディレクトリ事前検査と展開バイト数の実測で二重に上限をかけ（計64MB・1000エントリ・テキスト抽出は50件/各4MB）、パス走査・絶対パス・入れ子アーカイブは抽出対象から除外します。
- 大容量JSONパーサーはチャット送信経路だけに限定し、認証とPostgreSQL共有AI利用量ガードを先に実行します。
- AI利用量ガードは認証ユーザー単位でPostgreSQLを共有状態として使い、固定request windowと期限付きconcurrency leaseを全Autoscaleインスタンス間で共有します。DB側の利用量判定が利用不能な場合はAI生成をfail-closedします。
- 長期メモリの全操作は認証ユーザーIDを必須とし、PostgreSQL上でも`user_id`条件で分離します。プライベートセッションではメモリツール自体をモデルへ公開しません。会話へ渡すメモリは、内部の指示に従わない「信頼できない参考データ」として明示的に包みます。
- 旧`data/llm-memory/memories.db`は所有ユーザーを特定できないため自動移行せず、新実装からは読み込みません。既存環境ではバックアップ要否を判断したうえで、運用者が安全に廃棄してください。
- Web取得はDNS再束縛を含むSSRF防御を行い、展開後の本文をページ1MB・検索結果2MBで打ち切ります。
- 現行の画像添付は互換性のため会話メッセージ内へdata URLとして保存されます。モデルへの過去画像再送は最新10MiB・4枚に制限しています。より大規模な添付保存が必要になった場合は参照型ストレージへの移行を検討します。
- PDF / Office 等の生成binaryは現在PostgreSQLへtransactionalに保存し、既定50MiB/userの共通生成ファイルquotaで制限しています。保持・削除・object storageへの移行条件は [`docs/generated-binary-storage-policy.md`](./docs/generated-binary-storage-policy.md) を参照してください。

## ライセンス

MIT
