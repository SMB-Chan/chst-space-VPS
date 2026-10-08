# Chat-Space VPS deployment

Self-contained deployment assets for running Chat-Space on the Sakura VPS with
Docker Compose: PostgreSQL, the app, and a self-hosted SearXNG metasearch
provider.

## Layout

The repository root is the application source. This `deploy/` directory holds
the runtime assets:

```
<repo>/                      # git clone of SMB-Chan/chst-space-VPS
  deploy/
    Dockerfile               # builds the app image (context = repo root)
    compose.yaml             # db + searxng + app + code (project name pinned: chat-space)
    deploy.sh                # git pull -> build -> migrate -> up
    .env                     # real secrets (gitignored, created on the VPS)
    .env.example             # template
    searxng/settings.yml     # committed config (JSON enabled, no secret)
    code/Dockerfile          # OpenCode web coding environment image
    code/nginx-oc-picker.conf
  code-workspace/            # OpenCode project clones (gitignored, VPS only)
```

The compose project name is pinned to `chat-space` so the postgres volume
`chat-space_chatpg` and network `chat-space_default` are stable across
redeploys regardless of the directory compose is invoked from.

## Coding environment (OpenCode + file browser)

The standalone `/opt/opencode-sandbox` and `/opt/filebrowser` stacks were folded
into this project:

| Service | Container | Port | Purpose |
| --- | --- | --- | --- |
| `code` | `chat-space-code` | `127.0.0.1:4096` | OpenCode web |
| `files` | `chat-space-files` | `127.0.0.1:8091` | filebrowser over `code-workspace` |

- Workspace: `<repo>/code-workspace` (mounted at `/workspace` and `/srv`)
- Basic auth (OpenCode): `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`
- Nginx front (optional): `deploy/code/nginx-oc-picker.conf` →
  `/etc/nginx/conf.d/oc-picker.conf`, still listening on `127.0.0.1:8096`
- Picker asset: copy `deploy/code/picker.js` to `/opt/oc-picker/picker.js`
- filebrowser DB: `deploy/filebrowser/` (gitignored)

### Access modes (autonomous coding)

`OPENCODE_ACCESS_MODE` or `deploy/code-access-mode` (`ask` | `auto` | `full`):

| Mode | Behavior |
| --- | --- |
| `ask` | edit/bash require approval |
| `auto` | auto-approve (`--auto`); deny catastrophic bash; block `.env` reads |
| `full` | `permission: allow` — everything |

Settings →「開発環境」から変更できます。反映は `docker compose restart code`。

Build/run:

```bash
sudo docker build -f deploy/code/Dockerfile -t chat-space:code deploy/code
cd deploy && sudo docker compose up -d code files
```

Settings →「開発環境」からも開けます（ホスト名 `:8091` / `:4096`）。


## Prerequisites (VPS)

- Docker + Compose v2, `sudo` for the deploy user
- A git deploy key with read access to `SMB-Chan/chst-space-VPS`
- `deploy/.env` populated (copy from `.env.example`; include the full app
  runtime config plus `DB_PASSWORD`, `SEARXNG_SECRET`, `SEARXNG_BASE_URL`)

## Deploy

```bash
bash <repo>/deploy/deploy.sh
```

This pulls the latest `main`, rebuilds `chat-space:app`, ensures the DB schema,
and recreates the services.

## SearXNG notes

- `searxng/settings.yml` enables `search.formats: [html, json]`; without JSON
  the app's `format=json` queries are rejected.
- The secret is injected from `SEARXNG_SECRET` (not stored in git).
- The app reaches it at `SEARXNG_BASE_URL` over the internal compose network;
  no host port is published.

## Rollback

```bash
cd <repo> && git checkout <previous-sha>
sudo docker build -f deploy/Dockerfile -t chat-space:app .
cd deploy && sudo docker compose up -d

## マルチユーザー（パスワード認証）への移行

`AUTH_MODE=password` にすると、ユーザー名 + パスワードでログインする複数人向け
モードになります（既定は `local`：ログインなしの1人運用）。`/admin` から
ユーザー・プロバイダー・モデルを管理できます。

新しいテーブル（`app_users` / `app_sessions` / `llm_providers` / `llm_models`）は
`deploy.sh` の `push-force` と API 起動時の `ensure-schema` の両方で作成されます。
組み込みのプロバイダー・モデルは起動のたびに既存行を上書きせず投入されるため、
`AUTH_MODE=local` のままデプロイしても挙動は変わりません。

1. **DB をバックアップする**

   ```bash
   cd <repo>/deploy
   sudo docker compose exec -T db pg_dump -U chat chat_space > ~/chat_space-$(date +%Y%m%d).sql
   ```

2. **`deploy/.env` を編集する**

   ```ini
   AUTH_MODE=password
   BOOTSTRAP_ADMIN_USERNAME=admin
   BOOTSTRAP_ADMIN_PASSWORD=<十分に長いパスワード>
   # BOOTSTRAP_ADMIN_USER_ID は通常未設定のままにします。
   ```

   最初の管理者のユーザーIDは `BOOTSTRAP_ADMIN_USER_ID` → `LOCAL_USER_ID` →
   `local-user` の順で決まります。未設定なら、これまで local モードで使っていた
   会話・メモリ・設定がそのまま最初の管理者に引き継がれます。
   管理者が1人もいないときだけ作成され、既に管理者がいれば何もしません。

3. **`deploy.sh` を実行する**

   ```bash
   bash <repo>/deploy/deploy.sh
   ```

   `deploy.sh` は `.env` の `AUTH_MODE` を読み、フロントエンドを
   `VITE_AUTH_MODE=password` でビルドします（未設定なら `local`）。
   起動ログに `Created the first admin account from BOOTSTRAP_ADMIN_*` が出れば成功です。

4. **HTTPS でログインする**

   `NODE_ENV=production` ではセッション Cookie に `Secure` が付くため、
   `https://` でアクセスしてください（`AUTH_COOKIE_SECURE` で上書き可能）。
   ログイン後、設定 →「パスワード変更」で初期パスワードを変更し、
   `/admin` →「ユーザー」から利用者を追加します。

5. **`BOOTSTRAP_ADMIN_PASSWORD` を `.env` から削除する**。管理者が存在する限り
   使われませんが、実行中コンテナの環境変数からも消すため
   `cd <repo>/deploy && sudo docker compose up -d app` でコンテナを作り直します。

管理者をコマンドで追加・昇格する場合（パスワードはプロンプトで入力、
または `CHAT_SPACE_ADMIN_PASSWORD` 環境変数で渡します）：

```bash
cd <repo>/deploy
sudo docker compose exec -it app node artifacts/api-server/dist/create-admin.mjs --username <name>
```

**ロールバック**：`.env` を `AUTH_MODE=local` に戻して `deploy.sh` を再実行します。
追加したテーブルは残りますが、local モードでは参照されません。
