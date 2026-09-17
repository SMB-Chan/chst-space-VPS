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

## Coding environment (OpenCode)

The standalone `/opt/opencode-sandbox` stack was folded into this project as
the `code` service (`chat-space:code`, `127.0.0.1:4096`).

- Workspace: `<repo>/code-workspace` (mounted at `/workspace`)
- Basic auth: `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD` in `deploy/.env`
- Nginx front (optional): `deploy/code/nginx-oc-picker.conf` →
  `/etc/nginx/conf.d/oc-picker.conf`, still listening on `127.0.0.1:8096`
- Picker asset: copy `deploy/code/picker.js` to `/opt/oc-picker/picker.js`

Build/run:

```bash
sudo docker build -f deploy/code/Dockerfile -t chat-space:code deploy/code
cd deploy && sudo docker compose up -d code
```


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
```
