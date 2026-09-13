# Google 連携（カレンダー / Gmail / ドライブ）

Chat-Space に Google 製サービスとの連携を追加した実装メモ。AUTH_MODE=local の単一運用（さくらVPS + Tailscale）を想定している。

## 提供機能

LLM が自動で呼び出す専門ツール（`artifacts/api-server/src/lib/google-tools.ts`）:

| ツール | 機能 |
| --- | --- |
| `google_calendar_list_calendars` | カレンダー一覧 |
| `google_calendar_list_events` | 予定の期間検索 |
| `google_calendar_create_event` | 予定の作成 |
| `google_calendar_update_event` | 予定の部分更新 |
| `google_calendar_delete_event` | 予定の削除 |
| `gmail_search_messages` | Gmail 検索（Gmail 検索構文） |
| `gmail_read_message` | メール本文の取得 |
| `google_drive_search_files` | ドライブのファイル検索 |

チャットで「来週の予定は？」「この内容で予定を入れて」「○○ からのメールを探して」などと言うとツールが実行される。

## 構成

- OAuth: `artifacts/api-server/src/routes/google.ts`
  - `GET /api/google/status` — 連携状態
  - `GET /api/google/auth` — Google 同意画面へリダイレクト
  - `GET /api/google/callback` — 認可コード交換（無認可、state で userId を運ぶ）
  - `DELETE /api/google` — 連携解除
- トークン管理: `artifacts/api-server/src/lib/google-auth.ts`（refresh token を自動更新、invalid_grant で解除）
- トークン保存: `google_auth` テーブル（`lib/db/src/schema/google-auth.ts`、`ensure-schema.ts` にも冪等 DDL あり）
- 設定 UI: 設定ページ「Google 連携」カード（`artifacts/ai-chat-space/src/pages/settings.tsx`）

`googleapis` パッケージは使わず、REST を直接 fetch する（依存を増やさない方針）。

## セットアップ（Google Cloud Console）

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成し、
   **Calendar API / Gmail API / Drive API** を有効化。
2. OAuth 同意画面を「外部」で作成し、テストユーザーに自分のアカウントを追加。
3. 認証情報 → OAuth クライアント ID（ウェブアプリ）を作成。
4. 承認済みリダイレクト URI に `{FRONTEND_URL}/api/google/callback` を登録。
   VPS の場合 `https://sakura-dev.tailcf5af9.ts.net:8443/api/google/callback`。
5. VPS の `.env` に追記して再デプロイ:

```env
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxx
# FRONTEND_URL から自動導出されるので通常は不要
# GOOGLE_REDIRECT_URI=https://sakura-dev.tailcf5af9.ts.net:8443/api/google/callback
```

6. アプリの設定ページ →「Google 連携」→「Googleアカウントと連携する」で同意すると有効化される。

スコープ: `calendar`（読み書き）、`gmail.readonly`、`drive.readonly`、`openid`、`email`。
