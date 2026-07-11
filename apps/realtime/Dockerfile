# Realtime room-server image for the shared VPS. Multi-stage: a pnpm workspace build that
# esbuild-bundles the server (+ @friendslop/sim, @friendslop/shared, ws, zod) into ONE
# self-contained ESM file, then a bare node:22-alpine runtime that runs it as a non-root
# user with no node_modules at all.
#
# Build context is the REPO ROOT (the server needs the sim/shared workspace sources):
#   docker build -f apps/realtime/Dockerfile -t gamedash-realtime .
#
# The container listens on 8090 (REALTIME_PORT) and is published on a loopback port that the
# host nginx proxies with a WebSocket upgrade (docker-compose.vps.yml + gamedash.nginx.conf).

# --- build: bundle @friendslop/realtime into a single file ---
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

# Manifests first so `pnpm install` layer-caches until a dependency changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/realtime/package.json ./apps/realtime/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/sim/package.json ./packages/sim/package.json
# Only the realtime app needs its deps built to bundle; --filter keeps the install lean.
RUN pnpm install --frozen-lockfile --filter @friendslop/realtime...

# Sources needed by the bundle: the app + the two workspace packages it imports.
COPY apps/realtime ./apps/realtime
COPY packages/shared ./packages/shared
COPY packages/sim ./packages/sim
RUN pnpm --filter @friendslop/realtime build

# --- runtime: bare alpine + the single bundle, non-root ---
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# node:alpine ships an unprivileged `node` user (uid 1000) — run as it, never root.
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/realtime/dist ./dist
USER node
EXPOSE 8090
# Liveness is also checked by the compose healthcheck hitting /healthz.
CMD ["node", "dist/index.js"]
