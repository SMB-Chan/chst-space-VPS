# VPS coding environment (OpenCode web) — same image family as the former
# standalone /opt/opencode-sandbox, now owned by the chat-space stack.
FROM node:lts-bookworm

USER root

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git \
      curl \
      ca-certificates \
      openssh-client \
      ripgrep \
      jq \
      python3 \
      python3-pip \
      build-essential && \
    rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod a+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai

RUN mkdir -p \
      /workspace \
      /home/node/.local/share/opencode \
      /home/node/.config/gh \
      /home/node/.npm && \
    chown -R node:node /workspace /home/node

USER node

WORKDIR /workspace

CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
