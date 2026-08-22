# Chat-Space（AI Chat Space）

ファイルを添付して内容について質問できる、個人向けの AI チャットスペース。会話は Clerk アカウントごとに保存される。

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — API サーバー（未設定時ポート 5000）
- `PORT=5173 BASE_PATH=/ pnpm --filter @workspace/ai-chat-space run dev` — フロント（ローカル）
- `pnpm run typecheck` — 全パッケージの型チェック
- `pnpm run build` — 型チェック + 全パッケージのビルド
- `pnpm --filter @workspace/api-spec run codegen` — OpenAPI からフック / Zod を再生成
- `pnpm --filter @workspace/db run push` — DB スキーマ反映（開発のみ）
- `pnpm run test` — Vitest（API + フロントの単体テスト）
- `pnpm --filter @workspace/api-server run test:ssrf` — SSRF ガードの単体テスト
- 必須 env: `DATABASE_URL`, Clerk キー, `AI_INTEGRATIONS_OPENAI_*`。任意: `DASHSCOPE_API_KEY`
- 一覧は `.env.example` を参照

## Stack

- pnpm workspaces, Node.js 22+, TypeScript 5.9
- フロント: Vite, React 19, wouter, TanStack Query, Clerk, Tailwind
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle of the API)

## Where things live

- `artifacts/ai-chat-space` — チャット UI
- `artifacts/api-server` — Express API（会話 CRUD + SSE ストリーム + Web 検索前段）
- Replit 付属の `mockup-sandbox` は未使用のため削除済み
- `lib/db/src/schema` — `conversations` / `messages`（ソースオブトゥルース）
- `lib/api-spec/openapi.yaml` — API 契約
- `artifacts/api-server/src/lib/ai-clients.ts` — モデル一覧とプロバイダ解決
- `artifacts/api-server/src/lib/web-search.ts` — DDG 検索と SSRF ガード

## Architecture decisions

- Web 検索は tool calling ではなく、応答前の独立ステップ（モデル非依存、キー不要）。初回検索のあと、資料が不足かをモデルに判定させて最大1回だけ追加検索する（bounded 反復検索）。
- 検索バックエンドは `TAVILY_API_KEY` / `EXA_API_KEY` / `BRAVE_SEARCH_API_KEY` があれば API を優先（この順）、なければ DDG の HTML スクレイプにフォールバック。
- 新規添付は本文と構造化JSONで分離し、DBでは互換形式に保存して、送信直前にmultimodal contentへ変換する。
- OpenAI は `max_completion_tokens`、DashScope 互換は `max_tokens`。混在会話では切替必須。
- DashScope Token Plan はリージョン共通 URL ではなく専用エンドポイントが必要。
- 会話は `userId` で隔離。未認証は 401。

## Product

- 複数モデル切替（OpenAI / Qwen / DeepSeek / GLM）
- SSE ストリーミング、楽観的 UI
- Web 検索と参照元カード
- 画像・テキスト添付
- ユーザーごとの会話履歴
- 中立監査のあと、使用中モデルが指摘を読んで最終報告を確定する

## User preferences

- UI 文言は日本語を正とする。

## Gotchas

- Token Plan の DashScope は専用エンドポイント必須。モデル ID は `/openai/models` とフロントのフォールバック一覧を揃える。
- `messages` にカラムを足したら `pnpm --filter @workspace/db run push`。API 起動時にも欠けている監査カラム等を `ADD COLUMN IF NOT EXISTS` で補う。
- 「二重送信」報告は、まず DB に 2 件あるのか表示が 2 件なのかを切り分ける。再取得完了を待ってからストリーミング状態をクリアする。
- ローカルでは Vite が `/api` を `API_PROXY_TARGET`（デフォルト `http://127.0.0.1:5000`）へプロキシする。
- URL 本文取得は素の HTML 抽出が主。読めないページは `__NEXT_DATA__` / JSON-LD の埋め込み本文 → ローカル headless Chromium（Playwright、`WEB_FETCH_PLAYWRIGHT_FALLBACK=0` で無効化）→ r.jina.ai プロキシ（`WEB_FETCH_RENDER_FALLBACK=1` で有効化、URL が第三者へ送られる）の順にフォールバックする。Playwright のブラウザは `pnpm --filter @workspace/api-server exec playwright install chromium` で導入。
- `.env` はコミットしない。`.env.example` だけを更新する。

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
