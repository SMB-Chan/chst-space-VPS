#!/usr/bin/env bash
# Sakura VPS (Ubuntu 24.04) host bootstrap for Chat-Space development.
#
# Usage (on the VPS as root):
#   DEV_USER=you \
#   SSH_PUBKEY='ssh-ed25519 AAAA...your key...' \
#   bash sakura-dev-bootstrap.sh
#
# This script does NOT run `tailscale up` or close TCP/22.
# After it finishes, authenticate Tailscale, confirm SSH over the tailnet,
# then close public SSH yourself.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

DEV_USER="${DEV_USER:-}"
SSH_PUBKEY="${SSH_PUBKEY:-}"
SWAP_SIZE="${SWAP_SIZE:-4G}"
CODE_SERVER_BIND="${CODE_SERVER_BIND:-127.0.0.1:8080}"
HOSTNAME_HINT="${HOSTNAME_HINT:-sakura}"

log() { printf '\n[%s] %s\n' "$(date -Is)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_root() {
  [[ "$(id -u)" -eq 0 ]] || die "root で実行してください (sudo -i)"
}

require_ubuntu_2404() {
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" && "${VERSION_ID:-}" == "24.04" ]] \
    || die "Ubuntu 24.04 専用です (detected: ${ID:-unknown} ${VERSION_ID:-unknown})"
}

require_inputs() {
  [[ -n "$DEV_USER" ]] || die "DEV_USER を指定してください"
  [[ "$DEV_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "DEV_USER が不正です: $DEV_USER"
  [[ "$DEV_USER" != "root" ]] || die "DEV_USER に root は使えません"
  [[ -n "$SSH_PUBKEY" ]] || die "SSH_PUBKEY を指定してください"
  [[ "$SSH_PUBKEY" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh.com) ]] \
    || die "SSH_PUBKEY は ssh-ed25519 / ssh-rsa / ecdsa 形式である必要があります"
}

run_remote() {
  local url="$1"
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "$url" -o "$tmp"
  bash "$tmp"
  rm -f "$tmp"
}

as_user() {
  sudo -H -u "$DEV_USER" -- "$@"
}

ensure_swap() {
  if swapon --show --noheadings | awk '{print $1}' | grep -qx /swapfile; then
    log "swapfile は既に有効です"
    return
  fi
  if [[ -f /swapfile ]]; then
    log "既存 /swapfile を有効化します"
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
  else
    log "4GB swap を作成します ($SWAP_SIZE)"
    fallocate -l "$SWAP_SIZE" /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
  fi
  grep -qE '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
}

ensure_packages() {
  log "ベースパッケージを更新・導入します"
  apt-get update -y
  apt-get upgrade -y
  apt-get install -y \
    ca-certificates curl gnupg git tmux ufw sudo unzip jq \
    rsync htop vim-tiny
}

ensure_user() {
  if id -u "$DEV_USER" >/dev/null 2>&1; then
    log "ユーザー $DEV_USER は既に存在します"
  else
    log "ユーザー $DEV_USER を作成します"
    adduser --disabled-password --gecos "" "$DEV_USER"
  fi
  usermod -aG sudo "$DEV_USER"
  echo "$DEV_USER ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${DEV_USER}"
  chmod 440 "/etc/sudoers.d/90-${DEV_USER}"
  visudo -cf "/etc/sudoers.d/90-${DEV_USER}" >/dev/null

  local home ssh_dir keys cfg
  home="$(getent passwd "$DEV_USER" | cut -d: -f6)"
  ssh_dir="$home/.ssh"
  keys="$ssh_dir/authorized_keys"
  cfg="$ssh_dir/config"

  install -d -m 700 -o "$DEV_USER" -g "$DEV_USER" "$ssh_dir"
  touch "$keys"
  chmod 600 "$keys"
  chown "$DEV_USER:$DEV_USER" "$keys"
  grep -Fqx "$SSH_PUBKEY" "$keys" || echo "$SSH_PUBKEY" >> "$keys"

  if [[ ! -f "$cfg" ]]; then
    cat > "$cfg" <<'EOF'
Host *
  ForwardAgent no
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
EOF
    chmod 600 "$cfg"
    chown "$DEV_USER:$DEV_USER" "$cfg"
  elif ! grep -q '^[[:space:]]*ForwardAgent no' "$cfg"; then
    printf '\nHost *\n  ForwardAgent no\n' >> "$cfg"
  fi

  install -d -m 755 -o "$DEV_USER" -g "$DEV_USER" "$home/projects"
}

harden_ssh() {
  log "sshd を hardening します (公開22は残す / Agent Forwarding 無効)"
  cat > /etc/ssh/sshd_config.d/99-sakura-hardening.conf <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowAgentForwarding no
X11Forwarding no
EOF
  sshd -t
  systemctl reload ssh
}

enable_ufw() {
  log "UFW を有効化します (TCP/22 は構築直後は開放のまま)"
  ufw --force reset >/dev/null
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp comment 'public SSH (close after Tailscale SSH works)'
  ufw --force enable
  ufw status verbose
}

install_docker() {
  log "Docker Engine を公式 apt リポジトリから導入します (Ubuntu 24.04)"
  apt-get remove -y docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc >/dev/null 2>&1 || true
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  usermod -aG docker "$DEV_USER"
  log "WARNING: docker グループは実質 root 相当です。隔離境界にはしないでください。"
}

install_node22() {
  log "Node.js 22 を導入します"
  run_remote https://deb.nodesource.com/setup_22.x
  apt-get install -y nodejs
  corepack enable
  as_user bash -lc 'corepack prepare pnpm@latest --activate'
  node -v
  npm -v
}

install_tailscale() {
  log "Tailscale を導入します (認証は手動)"
  run_remote https://tailscale.com/install.sh
  systemctl enable --now tailscaled
}

install_code_server() {
  local home config_dir config_file password
  home="$(getent passwd "$DEV_USER" | cut -d: -f6)"
  config_dir="$home/.config/code-server"
  config_file="$config_dir/config.yaml"

  log "code-server を導入し ${CODE_SERVER_BIND} のみに bind します"
  run_remote https://code-server.dev/install.sh

  install -d -m 700 -o "$DEV_USER" -g "$DEV_USER" "$config_dir"
  if [[ -f "$config_file" ]] && grep -q '^password:' "$config_file"; then
    password="$(awk '/^password:/ {print $2; exit}' "$config_file")"
  else
    password="$(openssl rand -base64 24 | tr -d '\n')"
  fi
  cat > "$config_file" <<EOF
bind-addr: ${CODE_SERVER_BIND}
auth: password
password: ${password}
cert: false
EOF
  chown -R "$DEV_USER:$DEV_USER" "$home/.config"
  chmod 600 "$config_file"

  systemctl enable --now "code-server@${DEV_USER}"
  echo "$password" > "$home/.config/code-server/PASSWORD.txt"
  chown "$DEV_USER:$DEV_USER" "$home/.config/code-server/PASSWORD.txt"
  chmod 600 "$home/.config/code-server/PASSWORD.txt"
  log "code-server password は $home/.config/code-server/PASSWORD.txt に保存しました"
}

configure_tmux() {
  local home bashrc
  home="$(getent passwd "$DEV_USER" | cut -d: -f6)"
  bashrc="$home/.bashrc"
  touch "$bashrc"
  chown "$DEV_USER:$DEV_USER" "$bashrc"
  if ! grep -q 'tmain()' "$bashrc"; then
    cat >> "$bashrc" <<'EOF'

# tmux: do not auto-attach (conflicts with Remote SSH). Use tmain instead.
tmain() { tmux new-session -A -s main; }
EOF
  fi
}

install_opencode() {
  log "OpenCode v2 を導入します"
  as_user bash -lc 'curl -fsSL https://opencode.ai/v2/install | bash'
}

print_next_steps() {
  local home
  home="$(getent passwd "$DEV_USER" | cut -d: -f6)"
  cat <<EOF

============================================================
bootstrap 完了。次は対話的に Tailscale だけ認証してください。
============================================================

1) Tailscale 参加
   sudo tailscale up --hostname=${HOSTNAME_HINT}
   tailscale status
   tailscale serve --bg 8080
   tailscale serve status

2) 手元の Mac/Linux から Tailscale SSH を確認
   ssh ${DEV_USER}@${HOSTNAME_HINT}

3) 成功したら初めて公開 SSH を閉じる
   sudo ufw delete allow 22/tcp
   sudo ufw status verbose
   # さくらコントロールパネルのパケットフィルターでも 22 を閉じる

4) code-server
   Serve が表示する https://....ts.net を Android から開く
   パスワード: ${home}/.config/code-server/PASSWORD.txt
   bind: ${CODE_SERVER_BIND}  (公開インターネットには出していません)
   Tailscale Serve は tailnet 内向けです。Funnel とは別機能です。

5) アプリデプロイ時のポート
   deploy/compose.yaml はアプリを 127.0.0.1:8080 に出します。
   code-server と同じポートなので、アプリ公開時は
   127.0.0.1:5000:5000 などに変更してください。

注意:
- Docker グループは実質 root 相当。完全な隔離境界ではない。
- エージェント隔離が必要なら、人間用 ${DEV_USER} と
  エージェント用非 sudo ユーザーを分け、rootless Docker か
  専用 sandbox だけをエージェントへ与えること。
- このスクリプトは公開 22 を閉じません。締め出し防止のため。

EOF
}

require_root
require_ubuntu_2404
require_inputs
ensure_swap
ensure_packages
ensure_user
harden_ssh
enable_ufw
install_docker
install_node22
install_tailscale
install_code_server
configure_tmux
install_opencode
print_next_steps
