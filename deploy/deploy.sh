#!/bin/bash
# Chat-Space VPS deploy (git-pull based).
#
# Layout: this script lives in <repo>/deploy and is run from anywhere on
# the VPS host.
#
# Steps:
#   1. git pull the repo (the clone root is the parent of deploy/)
#   2. build the app (and coding-environment) images with content-addressable
#      tags so we can roll back individually
#   3. apply schema changes: `drizzle-kit migrate` when lib/db/drizzle has a
#      migration journal; otherwise the API server's boot-time ensure-schema
#      (idempotent CREATE/ALTER ... IF NOT EXISTS) does it. Never push-force
#      by default — that path can silently drop columns/tables in production
#   4. (re)start services via `docker compose up -d`
#
# The compose project name is pinned to "chat-space" so the postgres volume
# (chat-space_chatpg) and network (chat-space_default) survive redeploys.
# Hosts whose database lives in a different volume (e.g. after a manual
# migration) point at it from deploy/compose.override.yaml (gitignored; see
# compose.override.example.yaml). The deploy refuses to start the database
# on a volume that does not exist yet, so a missing override can never
# silently boot the app on a fresh, empty database.
#
# Usage on the VPS host:
#
#   sudo bash deploy/deploy.sh
#
# Optional environment overrides:
#   IMAGE_TAG=<sha-or-tag>   pin the rebuilt images to a specific tag
#                            (default: timestamped tag, e.g. 20260101T030000Z)
#   SKIP_BUILD=1             skip `docker build` (reuse existing local images)
#   SKIP_PULL=1              skip `git pull --ff-only`
#   ALLOW_DESTRUCTIVE_PUSH=1 run `drizzle-kit push --force` (only on the
#                            initial greenfield bootstrap of an empty DB)
#   ALLOW_NEW_DB_VOLUME=1    allow creating a brand-new (empty) postgres
#                            volume (first install only)
#   VERBOSE=1                `set -x` for debugging
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
COMPOSE_DIR="$SCRIPT_DIR"
IMAGE_TAG="${IMAGE_TAG:-$(date -u +%Y%m%dT%H%M%SZ)}"
LOG_DIR="${LOG_DIR:-/var/log/chat-space}"

[[ "${VERBOSE:-0}" == "1" ]] && set -x

log()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[deploy]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

mkdir -p "$LOG_DIR"

[[ -d "$REPO_ROOT/.git" ]] || fail "Repo not found at $REPO_ROOT (.git missing)."
cd "$REPO_ROOT"

# ---- 0. Sanity checks ---------------------------------------------------
command -v docker        >/dev/null || fail "docker not installed on host."
command -v sudo          >/dev/null || fail "sudo not available."
docker compose version   >/dev/null 2>&1 || fail "docker compose plugin missing."

# Refuse to deploy with uncommitted local changes — silent overwrites of
# production schema are the single most common cause of "I lost data
# after deploy" reports.
# A git error (e.g. "dubious ownership" when root runs this on a clone owned
# by another uid) must not read as "clean".
GIT_STATUS="$(git status --porcelain)" \
  || fail "git status failed. If git reports dubious ownership, run: git config --global --add safe.directory $REPO_ROOT"
if [[ -n "$GIT_STATUS" ]]; then
  fail "Local working tree has uncommitted changes. Commit or stash before deploying."
fi

# ---- 1. Pull latest ----------------------------------------------------
if [[ "${SKIP_PULL:-0}" != "1" ]]; then
  log "git pull --ff-only"
  git pull --ff-only | tee -a "$LOG_DIR/deploy.log"
fi

# ---- 2. Build images ---------------------------------------------------
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  # The frontend bundle must match AUTH_MODE (local | password | clerk).
  # Read only that key from deploy/.env; default "local" keeps single-user
  # VPS deployments unchanged.
  AUTH_MODE_VALUE="$(sed -n 's/^AUTH_MODE=//p' "$SCRIPT_DIR/.env" 2>/dev/null | tail -n1 | tr -d '"\r' || true)"
  AUTH_MODE_VALUE="${AUTH_MODE_VALUE:-local}"
  log "Building app image (tag $IMAGE_TAG, VITE_AUTH_MODE=$AUTH_MODE_VALUE)"
  sudo docker build -f deploy/Dockerfile \
    --build-arg "VITE_AUTH_MODE=$AUTH_MODE_VALUE" \
    -t "chat-space:app" -t "chat-space:app-$IMAGE_TAG" . | tee -a "$LOG_DIR/deploy.log"
  log "Building coding-environment image (tag $IMAGE_TAG)"
  sudo docker build -f deploy/code/Dockerfile \
    -t "chat-space:code" -t "chat-space:code-$IMAGE_TAG" deploy/code \
    | tee -a "$LOG_DIR/deploy.log"
fi

# ---- 3. Workspace + access-mode setup ---------------------------------
log "Ensuring code-workspace, filebrowser DB, and access-mode file exist"
mkdir -p "$REPO_ROOT/code-workspace"
# code-workspace is bind-mounted into chat-space-code (running as `node`,
# uid 1000) and chat-space-files (filebrowser, uid 1000). Owning the
# directory as 1000 up front prevents root-owned files leaking in from
# container-init.
chown -R 1000:1000 "$REPO_ROOT/code-workspace" 2>/dev/null || \
  warn "Could not chown code-workspace to 1000:1000 — files created by the container will be owned by root."

mkdir -p "$SCRIPT_DIR/filebrowser"
chown -R 1000:1000 "$SCRIPT_DIR/filebrowser" 2>/dev/null || true

# Default OpenCode access mode is "ask" (safest). Operators who opt into
# autonomous coding override with deploy/.env (OPENCODE_ACCESS_MODE) or by
# editing the access-mode file.
if [ ! -f "$SCRIPT_DIR/code-access-mode" ]; then
  printf 'ask\n' > "$SCRIPT_DIR/code-access-mode"
  warn "Initialized deploy/code-access-mode='ask'. Set OPENCODE_ACCESS_MODE in deploy/.env to enable autonomous coding."
fi

# ---- 4. Bring up the database ------------------------------------------
cd "$COMPOSE_DIR"
# Resolve the postgres volume exactly as compose will (compose.yaml plus an
# optional compose.override.yaml) and make sure it already exists.
COMPOSE_CONFIG="$(sudo docker compose config)" \
  || fail "'docker compose config' failed; check deploy/compose*.yaml and deploy/.env."
DB_VOLUME="$(printf '%s\n' "$COMPOSE_CONFIG" | awk '
  /^[^ ]/       { top = ($0 == "volumes:"); vol = 0; next }
  top && /^  [^ ]/ { vol = ($0 == "  chatpg:"); next }
  top && vol && /^    name:/ && !found { name = $2; found = 1 }
  END { print name }
')"
[[ -n "$DB_VOLUME" ]] || fail "Could not resolve the chatpg volume name from 'docker compose config'."
if ! sudo docker volume inspect "$DB_VOLUME" >/dev/null 2>&1; then
  if [[ "${ALLOW_NEW_DB_VOLUME:-0}" == "1" ]]; then
    warn "Postgres volume '$DB_VOLUME' does not exist; creating a NEW EMPTY database (ALLOW_NEW_DB_VOLUME=1)."
  else
    fail "Postgres volume '$DB_VOLUME' does not exist. If your data lives in another volume, point at it from deploy/compose.override.yaml (see compose.override.example.yaml). For a first install, rerun with ALLOW_NEW_DB_VOLUME=1."
  fi
fi
log "Postgres volume: $DB_VOLUME"
log "Starting db"
sudo docker compose up -d db
log "Waiting for db to accept connections"
for _ in $(seq 1 30); do
  if sudo docker compose exec -T db pg_isready -U chat -d chat_space >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
sudo docker compose exec -T db pg_isready -U chat -d chat_space >/dev/null 2>&1 \
  || fail "Database did not become ready in time."

# ---- 5. Apply schema changes ------------------------------------------
# We deliberately do NOT call `push --force`. That command drops columns
# and tables non-interactively; in production that is a data-loss path.
# When migrations have been authored (`pnpm --filter @workspace/db run
# generate` writes lib/db/drizzle/meta/_journal.json), apply them with
# `drizzle-kit migrate`. Without a journal `migrate` just fails, and the API
# server's boot-time ensure-schema applies the (additive) schema instead.
# Only the initial bootstrap of an empty DB should run push --force, and
# even then only with ALLOW_DESTRUCTIVE_PUSH=1.
if [[ "${ALLOW_DESTRUCTIVE_PUSH:-0}" == "1" ]]; then
  warn "ALLOW_DESTRUCTIVE_PUSH=1 set: running drizzle-kit push --force"
  sudo docker compose run --rm app \
    sh -c "pnpm --filter @workspace/db run push-force" | tee -a "$LOG_DIR/deploy.log"
elif [[ -f "$REPO_ROOT/lib/db/drizzle/meta/_journal.json" ]]; then
  log "Applying schema migrations (drizzle-kit migrate)"
  sudo docker compose run --rm app \
    sh -c "pnpm --filter @workspace/db run migrate" | tee -a "$LOG_DIR/deploy.log"
else
  log "No drizzle migrations; the app applies its schema at boot (ensure-schema)"
fi

# ---- 6. (Re)start the full stack --------------------------------------
log "Bringing up the rest of the stack"
sudo docker compose up -d
sudo docker compose ps

# ---- 7. Health probe --------------------------------------------------
log "Probing /api/healthz (up to 30s)"
HEALTH_URL="http://127.0.0.1:8080/api/healthz"
healthy=0
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 2 "$HEALTH_URL" >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" == "1" ]]; then
  log "healthz OK"
else
  warn "healthz did not respond within 30s — check 'sudo docker compose logs app'."
fi

# ---- 8. Done -----------------------------------------------------------
log "Done."
log "Image tags: chat-space:app-$IMAGE_TAG, chat-space:code-$IMAGE_TAG"
log "Roll back with:  sudo docker tag chat-space:app-<previous-tag> chat-space:app"
log "              (and chat-space:code-<previous-tag> chat-space:code), then"
log "              cd $COMPOSE_DIR && sudo docker compose up -d --force-recreate --no-deps app code"
