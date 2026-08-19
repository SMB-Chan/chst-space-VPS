# Chat-Space 監査・修正報告

- 対象: `Chat-Space-main.zip`
- 監査・修正日: 2026-08-20
- 方式: ソース監査、OpenAPI/Express契約照合、TypeScript構文解析、依存なしで実行可能な中核ロジックのスモーク検証
- 変更規模: 46ファイル（本報告を含む）。OpenAPI生成物、テスト、文書を含む

## 結論

中核設計は有望です。特に、Web取得時の接続層SSRF防御、監査モデルから元モデルへ戻す再生成フロー、生成ファイルを画像化してVisionモデルで点検する流れは、単純な複数LLMチャットより一段進んでいます。

一方、添付形式とサーバー解釈、OpenAPIとExpress実装の間に回帰があり、画像添付と会話名変更が実運用上成立しない状態でした。本修正版では、この2件を最優先で修復し、同じ原因による再発を検出する契約テストを追加しました。併せて、大容量入力、AI利用コスト、外部ページ取得、CORS、外部変換ツールの停止リスクを抑えています。

## 修正した重大問題

### P0-1: 画像・テキスト添付プロトコルの不整合

#### 問題

フロントは添付を `CS_ATTACHMENTS_V1:` 形式へ埋め込んでいましたが、サーバーはその形式を解釈せず、メッセージ全体が単独の画像data URLである場合しかVision入力へ変換していませんでした。さらに、従来のZod本文上限が10万文字だったため、一般的なbase64画像はサーバー入口で拒否される状態でした。

#### 修正

- 新規API送信は本文と添付を分離した構造化JSONへ変更
- `message-content.ts` を追加し、添付処理を一元化
- 複数画像、複数テキスト、画像とテキストの混在に対応
- Vision対応モデルではOpenAI互換の `text` / `image_url` content partsへ変換
- 画像非対応モデルにはフロントとサーバーの両方で明示的に送信を拒否
- `CS_ATTACHMENTS_V1:` はDB保存・表示互換形式として維持
- 旧 `[Image: ...]` / `[File: ...]` と単独data URLも読み取り互換を維持
- malformed/oversizedな過去添付が会話全体を壊さないフォールバックを追加
- プライベートセッションでは過去の添付payloadを毎ターン再送せず、質問とファイル名だけを履歴化
- プライベートセッションでのPDF/Office生成を無効化し、非永続セッションとの意味的不整合を解消

#### 添付制限

- 最大5件
- 画像1件10MB
- テキスト1件1MB
- テキスト合計2MB
- 全添付合計20MB
- 対応画像: JPEG / PNG / GIF / WebP
- SVGは拒否
- base64の正規形を検査
- 宣言MIMEとPNG/JPEG/GIF/WebPのファイルシグネチャを照合
- 添付ファイル名の制御文字除去と255文字上限

### P0-2: OpenAPIとExpress実装の乖離

#### 問題

フロントとOpenAPIには会話名変更の `PATCH /openai/conversations/{id}` がありましたが、Express実装が存在しませんでした。また、実装済みAPIの一部がOpenAPIに記録されておらず、契約がsource of truthとして機能していませんでした。

#### 修正

- `PATCH /openai/conversations/:conversationId` を実装
- `GET /openai/conversations/:conversationId/messages` を実装
- 会話作成をHTTP 201へ統一
- 会話名を1〜80文字へ統一し、所有者確認付きで更新
- `/openai/models`
- `/openai/ephemeral/messages`
- `DELETE /openai/messages`
- `/openai/assets/{assetId}`
- 構造化添付、ファイル形式、モデル一覧、削除入力をOpenAPIへ反映
- Orval由来のReact QueryクライアントとZod生成物を同期
- サーバーのtransport検証を生成Zodへ寄せ、独自Zodとの二重契約を解消
- `scripts/check-openapi-routes.mjs` を追加
- Express/OpenAPIの経路差分をCIで検出できるVitestを追加

## 追加の防御・安定化

### 大容量入力とAI利用量

- 通常JSON上限を256KB、添付付きAI POSTだけ30MBに分離
- 30MB parserの前にClerk認証を実行
- 大容量parserとAI利用量制限をPOSTだけへ限定し、メッセージ一覧GETを誤って消費対象にしないよう修正
- 1ユーザー・1プロセスあたり、既定20件/分
- 同時AI生成は既定2件
- `AI_REQUESTS_PER_MINUTE` / `AI_MAX_CONCURRENT_REQUESTS` で変更可能
- SSEの `finish` / `close` で同時実行枠を確実に解放
- 429時に `Retry-After` を返す

### Web検索・外部ページ取得

- 既存のDNS事前検査とUndici接続層検査を維持
- URL内のユーザー名・パスワードを拒否
- リダイレクトごとにURLと接続先を再検証
- リダイレクト、非成功応答、非テキスト応答のbodyを破棄
- `response.text()` による全量読込を廃止
- 展開後レスポンスをページ1MB、検索HTML 2MBで打ち切り
- HTTP本文の途中停止にも既存のend-to-end timeoutを適用
- 権威性判定をURL全体の部分一致からhostname単位へ変更
- `evil.example/?next=reuters.com` のようなスコア偽装を防止
- 固定された「2024年以降」判定を廃止し、実行年と前年を基準に更新

### CORS

- `FRONTEND_URL` をカンマ区切りのOrigin allowlistとして処理
- 不正なURLエントリは無視
- 開発時かつ未設定の場合のみ従来どおり寛容
- 本番で未設定の場合、クロスOriginブラウザアクセスをfail closed
- Originなしの同一Origin・サーバー間リクエストは許可

### 生成ファイルとダウンロード

- LibreOffice / pdftocairoの未消費stdout pipeを廃止し、pipe buffer停止を防止
- stderr保持を64KBへ制限
- 既存のtimeoutと強制killを維持
- artifact/assetに `Cache-Control: private, no-store`
- `X-Content-Type-Options: nosniff`
- HTML artifactに `Content-Security-Policy: sandbox`
- ID解析を厳密な正のsafe integerへ変更
- message asset IDの復元も正のsafe integerだけを受理

## 追加した主なテスト

- 構造化複数添付の解析とmultimodal変換
- 旧添付形式の後方互換
- 画像非対応モデル向けのpayload除外
- 添付のみメッセージの既定質問
- 空メッセージ拒否
- SVG拒否
- decoded byte上限
- base64/MIME/画像シグネチャ不一致の拒否
- malformedな保存添付からの安全な履歴復旧
- フロント表示でbase64を露出しないこと
- プライベート履歴のpayload除去
- OpenAPI生成Zodの添付・形式・タイトル・削除境界
- OpenAPIとExpressの経路一致
- hostnameスコア偽装防止
- 動的な年次recency評価
- bounded response body
- CORS allowlist
- AI毎分・同時実行制限
- 413公開エラー文言

## この環境で実行した検証

| 検証 | 結果 |
| --- | --- |
| 全TypeScript/TSXの構文解析 | PASS — 207ファイル、構文診断0 |
| OpenAPI YAML解析 | PASS — 14 operations |
| OpenAPIとExpress経路照合 | PASS — `/openai` 13 operations |
| OpenAPI operationIdと生成client/Zodの対応 | PASS — 14 operations |
| 中核ロジック実行スモーク | PASS |
| 依存の少ない中核7モジュールのstrict TypeScript検査 | PASS |
| 秘密鍵らしき文字列の静的走査 | 検出なし |
| 実 `.env`、`node_modules`、`dist`、`.tsbuildinfo` 等 | 混入なし |

スモーク検証では、構造化添付、画像シグネチャ、base64非露出、旧形式互換、検索ドメイン偽装防止、動的recency、応答サイズ打切り、CORS、同時実行制限、大容量ミドルウェアのPOST限定を実行しました。

## この環境では実行できなかった検証

この実行環境にはプロジェクトの `node_modules` と `pnpm` 実体がなく、Corepackからの取得もregistryへ到達できなかったため、次は未実行です。

- 全Vitestスイート
- ワークスペース全体の `pnpm run typecheck`
- Vite/APIの本番ビルド
- Orvalによる実コード生成
- `test:ssrf` のesbuild bundle実行
- PostgreSQL、Clerk、OpenAI/DashScopeを接続したend-to-end検証

したがって、本報告は「全依存を伴うリリース認定」ではなく、静的監査と依存なしで実行できる中核ロジックの検証済み修正版です。

## ローカルで必ず実行する最終確認

```bash
corepack enable
pnpm install --frozen-lockfile

# OpenAPIをsource of truthから再生成
pnpm --filter @workspace/api-spec run codegen

# 手動同期した生成物と再生成結果に意図しない差がないか確認
git diff -- lib/api-client-react/src/generated lib/api-zod/src/generated

pnpm run check:api-routes
pnpm run typecheck
pnpm run test
pnpm --filter @workspace/api-server run test:ssrf
pnpm run build
```

API codegen後に生成物へ大きな差分が出た場合は、手動同期版を正とせず、OpenAPIとOrval設定を修正して再生成結果を採用してください。

## 残る設計上の課題

### 1. 画像data URLのDB保存

現行互換性を優先し、画像は `messages.content` 内へdata URLとして残しています。会話取得レスポンス、バックアップ、DB容量が大きくなります。本番化では次へ移行すべきです。

- 添付テーブル
- オブジェクトストレージ
- messageにはattachment IDと表示メタデータだけを保存
- 短寿命の署名URLまたはサーバーproxyでモデルへ渡す
- ユーザー単位の保存容量quota

### 2. 永続会話での過去添付再送

プライベートセッションは過去payloadを除去しましたが、永続会話では互換性のため過去添付を復元します。多数の画像がある会話では、モデルcontext、API費用、DB読込が増大します。次の段階で「直近N画像・合計M MB」などの履歴予算を導入すべきです。

### 3. rate limitは1プロセス内

複数APIインスタンスでは上限がインスタンス数倍になります。Redis、API gateway、Cloudflare等の共有制限が必要です。

### 4. ファイル生成の表現力

現行スキーマはPDF/Officeを安全に生成できますが、PPTXはtitle+bullets、Excelはheaders+rows中心です。Vision監査が高度なレイアウト改善を要求しても、renderer schemaが表現できません。共通Document ASTへ、heading、paragraph、table、image、chart、callout、columns、layoutを導入する価値があります。

### 5. DuckDuckGo HTMLへの依存

APIキー不要という利点がある一方、HTML構造変更やbot対策で検索が壊れます。検索provider interfaceを設け、DDG HTML、公式検索API、組織内検索を交換可能にすると保守性が上がります。

### 6. 大規模ファイル生成の保存先

生成assetもPostgreSQLのbase64 textへ保存しています。小規模利用には簡潔ですが、Office/PDFを多用する場合はオブジェクトストレージと保存期限へ移行すべきです。

## 主要変更ファイル

- `artifacts/ai-chat-space/src/lib/attachments.ts`
- `artifacts/ai-chat-space/src/pages/chat.tsx`
- `artifacts/ai-chat-space/src/components/chat/message-input.tsx`
- `artifacts/ai-chat-space/src/components/chat/message-feed.tsx`
- `artifacts/api-server/src/lib/message-content.ts`
- `artifacts/api-server/src/routes/openai/index.ts`
- `artifacts/api-server/src/app.ts`
- `artifacts/api-server/src/middlewares/aiUsageGuard.ts`
- `artifacts/api-server/src/lib/bounded-body.ts`
- `artifacts/api-server/src/lib/web-search.ts`
- `artifacts/api-server/src/lib/search-enhance.ts`
- `artifacts/api-server/src/lib/file-preview.ts`
- `lib/api-spec/openapi.yaml`
- `lib/api-client-react/src/generated/*`
- `lib/api-zod/src/generated/*`
- `scripts/check-openapi-routes.mjs`
- `README.md`
- `.env.example`

## 配布判断

現状は、元ZIPより明確に安全で、添付・会話名変更・API契約の主要回帰を修復した状態です。ただし、依存を導入した環境での全テスト・型検査・ビルドを通すまでは、本番へ直接投入せず、候補版として扱うのが妥当です。
