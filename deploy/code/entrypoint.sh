#!/bin/sh
# Chat-space OpenCode entrypoint — writes permission config from access mode.
# Modes: ask | auto | full
#   ask  — edit/bash need approval (safe default for shared tails)
#   auto — auto-approve except catastrophic shell / .env reads (autonomous coding)
#   full — allow everything (trusted single-operator)
set -eu

MODE="${OPENCODE_ACCESS_MODE:-auto}"
if [ -f /access-mode ]; then
  file_mode="$(tr -d '[:space:]' < /access-mode || true)"
  if [ -n "$file_mode" ]; then
    MODE="$file_mode"
  fi
fi

case "$MODE" in
  ask|auto|full) ;;
  *)
    echo "unknown OPENCODE_ACCESS_MODE='$MODE', falling back to auto" >&2
    MODE=auto
    ;;
esac

CONFIG_DIR="/home/node/.config/opencode"
mkdir -p "$CONFIG_DIR"

if [ "$MODE" = "full" ]; then
  cat > "$CONFIG_DIR/opencode.jsonc" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "share": "disabled",
  "permission": "allow",
  "snapshot": true
}
EOF
  EXTRA_ARGS=""
elif [ "$MODE" = "ask" ]; then
  cat > "$CONFIG_DIR/opencode.jsonc" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "share": "disabled",
  "snapshot": true,
  "permission": {
    "*": "ask",
    "read": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "glob": "allow",
    "grep": "allow"
  }
}
EOF
  EXTRA_ARGS=""
else
  # auto — autonomous coding: permission allow except catastrophic bash / .env
  # (opencode serve has no --auto flag; allow-deny rails are the equivalent)
  cat > "$CONFIG_DIR/opencode.jsonc" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "share": "disabled",
  "snapshot": true,
  "permission": {
    "*": "allow",
    "read": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "*.env.example": "allow"
    },
    "bash": {
      "*": "allow",
      "rm -rf /": "deny",
      "rm -rf /*": "deny",
      "rm -rf ~": "deny",
      "rm -rf $HOME": "deny",
      "mkfs *": "deny",
      "dd if=*": "deny"
    },
    "external_directory": "allow",
    "doom_loop": "ask"
  }
}
EOF
  EXTRA_ARGS=""
fi

echo "opencode access mode: $MODE"
echo "serving on 0.0.0.0:4096"
# shellcheck disable=SC2086
exec opencode serve --hostname 0.0.0.0 --port 4096 $EXTRA_ARGS
