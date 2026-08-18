# Chat-Space（AI Chat Space）

ファイルを添付して内容について質問できる、個人向けの AI チャットスペースです。

複数のモデル（OpenAI / Qwen など）を切り替え、Web 検索とドキュメント・画像添付に対応しています。会話は Clerk アカウントごとに保存されます。

元リポジトリ: [Replit Chat-Space](https://replit.com/@ibn5100/Chat-Space)

## できること

- OpenAI と Alibaba Cloud（DashScope）のモデル切替、推論レベル
- ストリーミング応答（SSE）
- Web 検索（DuckDuckGo、API キー不要）と参照元カード
- 画像・テキストファイルの添付
- 会話履歴の保存・削除、メモリ一括消去
- プライベートセッション（サーバーに残さない）
- PWA（ホーム画面追加）と既定モデルの端末保存
- 金融の質問で「金融分析」スキルを自動適用（最新データ検索 + 分析フォーマット）
- 中立監査モード（別モデルが点検し、使用中のモデルが最終報告へ書き直す）

## スタック

| 層 | 技術 |
| --- | --- |
| フロント | Vite, React 19, wouter, TanStack Query, Clerk, Tailwind |
| API | Express 5 |
| DB | PostgreSQL + Drizzle ORM |
| 検証 | Zod, drizzle-zod |
| ワークスペース | pnpm workspaces, TypeScript 5.9 |

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
```

テストは Vitest です。`artifacts/api-server` と `artifacts/ai-chat-space` が対象です。

## 必要な環境変数

詳細は [`.env.example`](./.env.example) を見てください。

- `DATABASE_URL` — Postgres
- `CLERK_PUBLISHABLE_KEY` / `VITE_CLERK_PUBLISHABLE_KEY` — 認証
- `AI_INTEGRATIONS_OPENAI_BASE_URL` / `AI_INTEGRATIONS_OPENAI_API_KEY` — OpenAI 互換エンドポイント
- `DASHSCOPE_API_KEY` — Qwen 等を使う場合（任意）
- Token Plan の DashScope はリージョン共通 URL ではなく、専用エンドポイントが必要です

## ライセンス

MIT
