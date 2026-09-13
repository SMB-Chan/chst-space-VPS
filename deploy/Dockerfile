FROM node:24-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g pnpm@9

WORKDIR /app
COPY . .

ENV VITE_AUTH_MODE=local

RUN pnpm install --frozen-lockfile && pnpm build

EXPOSE 5000

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
