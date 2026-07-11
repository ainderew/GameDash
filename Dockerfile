# Frontend image for the shared VPS: builds the Vite SPA inside the pnpm
# workspace, then serves the static bundle with nginx. The container listens on
# port 80 and is published on a loopback port that the host nginx proxies to
# (see docker-compose.vps.yml + deploy/gamedash.nginx.conf).
#
#   docker compose -f docker-compose.vps.yml up -d --build

# --- build: compile @friendslop/web (pulls in @friendslop/shared) ---
FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

# Manifests first so `pnpm install` is cached until a dependency changes. EVERY workspace
# package the web build pulls in must be listed, or `pnpm install` won't install its deps:
# web → @friendslop/sim → miniplex. Missing packages/sim here is what broke the build with
# "Cannot find module 'miniplex'" (the whole ECS type surface collapsed off that one miss).
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/sim/package.json ./packages/sim/package.json
RUN pnpm install --frozen-lockfile

# Full source, then build only the web app.
COPY . .
# Realtime endpoint baked into the SPA at build time. Defaults to the same-origin prod WSS
# (also the client's built-in fallback in transport.ts); overridable per environment.
ARG VITE_REALTIME_URL="wss://gamedash.workdash.site/realtime"
ENV VITE_REALTIME_URL=$VITE_REALTIME_URL
RUN pnpm --filter web build

# --- runtime: static SPA served by nginx ---
FROM nginx:alpine AS runtime
COPY deploy/nginx-static.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
