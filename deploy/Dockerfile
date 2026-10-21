# Debian 12 (bookworm). `node:24-slim` tracks this image today; pin bookworm
# so security updates stay on the deb12 line (perl-base, gnutls, ...).
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

# Full install is required to build (vite, esbuild, typescript). A second
# production install then drops devDependencies, including vite, esbuild,
# and tinypool. `pnpm prune --prod` does not remove those from the pnpm
# store. NODE_ENV stays unset until the build finishes; production mode is
# set only for the running server, which does not load the dev-only
# pino-pretty transport.
RUN pnpm install --frozen-lockfile && pnpm build \
    && find . -name node_modules -type d -prune -exec rm -rf {} + \
    && CI=true pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production

EXPOSE 5000

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
