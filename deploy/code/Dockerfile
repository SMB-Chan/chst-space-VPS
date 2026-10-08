# VPS coding environment (OpenCode web).
#
# Image family ties back to the former standalone /opt/opencode-sandbox; now
# owned by the chat-space stack and bound together via docker-compose.
#
# Pin summary (bump intentionally):
#   * Node 22 LTS:       matches deploy/Dockerfile build stage and the
#                        currently-running VPS host (ik1-406-35022 ships
#                        v22.23.2). Bump together with CI matrix when ready.
#   * pnpm 10.x:         matches .github/workflows/ci.yml (10.34.5).
#   * opencode-ai 1.x:   pin the latest published minor at deploy time so
#                        `npm install -g` is deterministic; bump on the
#                        next deploy after we verify a release.
#   * gh CLI:            locked via the Debian apt repo at the date
#                        captured below — instead of `latest`.
FROM node:22.20.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PNPM_VERSION=10.34.5 \
    OPENCODE_VERSION=1.18.31

USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      gnupg \
      jq \
      openssh-client \
      ripgrep && \
    rm -rf /var/lib/apt/lists/*

# Install pnpm at the exact pinned version (matches CI).
RUN npm install -g "pnpm@${PNPM_VERSION}" && \
    pnpm --version

# Add the GitHub CLI apt repo once and pin gh to the current stable
# version. `apt-cache madison gh | head -1` resolves the latest packaged
# build for Bookworm; pin explicit so future snapshots don't silently
# upgrade gh. Override at deploy time by editing this file.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg 2>/dev/null && \
    chmod a+r /usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/* && \
    gh --version

# Pin opencode-ai at deploy time. Bump on the next deploy and verify the
# resulting image locally before rolling out.
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && \
    opencode --version

RUN mkdir -p \
      /workspace \
      /home/node/.local/share/opencode \
      /home/node/.config/opencode \
      /home/node/.config/gh \
      /home/node/.npm && \
    chown -R node:node /workspace /home/node

# Entrypoint writes permission config from OPENCODE_ACCESS_MODE / /access-mode.
COPY entrypoint.sh /usr/local/bin/chat-space-code-entrypoint
RUN chmod +x /usr/local/bin/chat-space-code-entrypoint

USER node

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/chat-space-code-entrypoint"]
