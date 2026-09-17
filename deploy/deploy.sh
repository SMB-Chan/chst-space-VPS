#!/bin/bash
# Chat-Space VPS deploy (git-pull based).
# Layout: this script lives in <repo>/deploy and is run from anywhere.
#   1. git pull the repo (the clone root is the parent of deploy/)
#   2. build the app (and coding-environment) images
#   3. ensure schema, then (re)start services
# The compose project name is pinned to "chat-space" so the postgres volume
# (chat-space_chatpg) and network (chat-space_default) survive redeploys.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

cd "$REPO_ROOT"
git pull --ff-only

sudo docker build -f deploy/Dockerfile -t chat-space:app .
sudo docker build -f deploy/code/Dockerfile -t chat-space:code deploy/code

# Coding workspace (OpenCode projects) — create once, owned by deploy user.
mkdir -p "$REPO_ROOT/code-workspace"

cd "$SCRIPT_DIR"
sudo docker compose up -d db
until sudo docker compose exec -T db pg_isready -U chat -d chat_space >/dev/null 2>&1; do sleep 2; done
sudo docker compose run --rm app sh -c "pnpm --filter @workspace/db run push-force"
sudo docker compose up -d
sudo docker compose ps

