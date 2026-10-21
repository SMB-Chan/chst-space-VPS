# Node 24, the same major as the previous `node:24-slim` tag and as CI
# (`node-version: 24`). `24-bookworm-slim` is that major's current Debian 12
# image (24.22.0 as of 2026-10-14) and keeps tracking later 24.x patches.
# Bookworm is pinned so apt security updates stay on deb12 (perl-base, gnutls).
# The code image stays on Node 22; it is the VPS coding environment, not this app.
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# Apply bookworm security updates at build time, then install runtime tools.
# Node's bundled npm vendors a vulnerable undici 6.x; npm 10.9.9 vendors
# tar 7.5.22 and does not vendor undici. pnpm matches CI (10.34.5).
RUN apt-get update && \
    apt-get upgrade -y --no-install-recommends && \
    apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/* && \
    npm install -g npm@10.9.9 && \
    tar_version="$(node -p "require('$(npm root -g)/npm/node_modules/tar/package.json').version")" && \
    test "$tar_version" = "7.5.22" && \
    npm install -g pnpm@10.34.5

WORKDIR /app
COPY . .

# Frontend build auth mode; deploy.sh passes AUTH_MODE from deploy/.env.
# `local` (single operator), `password` (multi-user), or `clerk`.
ARG VITE_AUTH_MODE=local
ENV VITE_AUTH_MODE=${VITE_AUTH_MODE}

# Full install is required to build (vite, typescript). A second production
# install then drops devDependencies such as vite, tinypool, and vitest.
# `pnpm prune --prod` does not remove those from the pnpm store.
# drizzle-kit stays: it is a production dependency of @workspace/db, so
# `pnpm --filter @workspace/db run migrate` and `push-force` (deploy.sh)
# keep working. That pulls drizzle-kit's own tools (tsx, esbuild) and not
# the frontend toolchain. NODE_ENV stays unset until the build finishes;
# production mode is set only for the running server, which does not load
# the dev-only pino-pretty transport.
RUN pnpm install --frozen-lockfile && pnpm build \
    && find . -name node_modules -type d -prune -exec rm -rf {} + \
    && CI=true pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production

EXPOSE 5000

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
