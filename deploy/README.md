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
    compose.override.yaml    # optional host-specific overrides (gitignored)
    compose.override.example.yaml
    deploy.sh                # git pull -> build -> schema -> up
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

### Database volume and schema

- If the database lives in a volume created outside this project (for example
  after a manual migration), point at it from `deploy/compose.override.yaml`
  (copy `compose.override.example.yaml`). `docker compose` merges it
  automatically and it is gitignored, so `git pull --ff-only` stays clean.
- `deploy.sh` resolves the postgres volume with `docker compose config` and
  refuses to continue when it does not exist, so a missing override can never
  boot the app on a fresh, empty database. First install only:
  `ALLOW_NEW_DB_VOLUME=1 ALLOW_DESTRUCTIVE_PUSH=1 sudo bash deploy/deploy.sh`.
- Schema: `drizzle-kit migrate` runs only when `lib/db/drizzle/meta/_journal.json`
  exists. Otherwise the API server applies the schema at boot (`ensure-schema`,
  idempotent `CREATE/ALTER ... IF NOT EXISTS`). `push --force` never runs
  unless `ALLOW_DESTRUCTIVE_PUSH=1`.

### One-time step for the ConoHa host (2026-10)

As of 2026-10 the ConoHa clone (`/opt/chat-space/src`) needs four one-time
fixes before `deploy.sh` can run:

1. The clone is owned by another uid, so root's git refuses it
   ("dubious ownership").
2. `origin` is an SSH URL but the host has no GitHub key. The repository is
   public, so an HTTPS remote pulls without any credentials.
3. Its database lives in the external volume `migration_chat_space_pg`,
   set by an uncommitted edit to `deploy/compose.yaml`. Move that edit into
   the gitignored override.
4. Remove the untracked `deploy/compose.yaml.bak.20261004`.

```bash
git config --global --add safe.directory /opt/chat-space/src
cd /opt/chat-space/src
git remote set-url origin https://github.com/SMB-Chan/chst-space-VPS.git
cp deploy/compose.yaml /root/compose.yaml.conoha-backup
cat > deploy/compose.override.yaml <<'YAML'
volumes:
  chatpg:
    external: true
    name: migration_chat_space_pg
YAML
git checkout -- deploy/compose.yaml
rm deploy/compose.yaml.bak.20261004
git pull --ff-only
(cd deploy && sudo docker compose config | grep -A2 '^  chatpg:')  # must show migration_chat_space_pg
git status --porcelain   # must print nothing
sudo bash deploy/deploy.sh
```

## マルチユーザー（パスワード認証）への移行

`AUTH_MODE=password` にすると、ユーザー名 + パスワードでログインする複数人向け
モードになります（既定は `local`：ログインなしの1人運用）。`/admin` から
ユーザー・プロバイダー・モデルを管理できます。

新しいテーブル（`app_users` / `app_sessions` / `llm_providers` / `llm_models`）は
API 起動時の `ensure-schema`（冪等な `CREATE TABLE IF NOT EXISTS`）で作成されます
（`deploy.sh` は `push --force` を実行しません。drizzle スキーマにも同じ定義があるため、
初回構築で `ALLOW_DESTRUCTIVE_PUSH=1` を使っても削除されません）。
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

   `deploy.sh` は `.env` の `AUTH_MODE` だけを読み、フロントエンドを
   `VITE_AUTH_MODE=password` でビルドします（未設定なら `local`）。
   ConoHa で初めて実行する場合は、先に上記「One-time step for the ConoHa host」を済ませてください。
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
