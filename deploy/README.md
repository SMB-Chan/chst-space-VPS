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
