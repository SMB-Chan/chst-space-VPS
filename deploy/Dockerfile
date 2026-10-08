FROM node:24-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm@9

WORKDIR /app
COPY . .

# Frontend build auth mode; deploy.sh passes AUTH_MODE from deploy/.env.
# `local` (single operator), `password` (multi-user), or `clerk`.
ARG VITE_AUTH_MODE=local
ENV VITE_AUTH_MODE=${VITE_AUTH_MODE}

RUN pnpm install --frozen-lockfile && pnpm build

EXPOSE 5000

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
