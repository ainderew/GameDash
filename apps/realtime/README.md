# @friendslop/realtime — session room server

Node WebSocket server for real-time shared-world co-op (`feature-plans/multiplayer/`).
Hand-rolled rooms/protocol on `ws` (Decision #3 — no Colyseus). Each session (party of ≤4
behind a 6-char join code) owns ONE isolated authoritative `@friendslop/sim` world stepped at
a fixed **30 Hz**; clients send binary input intents and the server broadcasts binary snapshots
at **20 Hz** plus reliable JSON events. The server owns every gameplay outcome.

## Architecture

```
                  ws://…/realtime  (JSON control + binary hot path)
browser client ──────────────────────────────────────────────► index.ts (HTTP + ws upgrade)
  prediction        InputCmd  ▲  │ ▼  Snapshot (20 Hz) + events        │
  + interpolation   (30 Hz)   │  │    + Impulse (server forces)        ▼
                              │  │                              ClientConnection (per socket)
                              │  │     hello/version · create/join · pong · zone cmds
                              │  │     rate-limited · schema-validated · panic-safe
                              │  ▼
                              SessionManager ──stepAll(30Hz)/broadcastAll(20Hz)──► Session[]
                                 MAX_SESSIONS cap · idle GC · per-room try/catch     │
                                 metrics (tick p50/p99, bytes/s, queue depth)        ▼
                                                                          @friendslop/sim world
                                                                          (stepSim — same code
                                                                           the client predicts with)
```

Key modules:

- `index.ts` — HTTP (`/healthz`, `/metrics`) + ws upgrade on `/realtime`; the 30 Hz sim loop,
  20 Hz snapshot loop, 2 s heartbeat, ~1 Hz roster broadcast, GC sweep, periodic metrics log,
  and the **SIGTERM drain** (notify sessions → 10 s grace → exit).
- `session.ts` — `Session` (one authoritative world, the relic state machine, the
  expedition-gate **countdown**, zone transitions) + `SessionManager` (create/join/resume,
  `MAX_SESSIONS`, idle GC, panic-safe `stepAll`/`broadcastAll`, aggregate metrics).
- `connection.ts` — per-socket protocol handler: version handshake, schema-validated JSON,
  length-validated binary, and the **per-connection rate limiter** (msgs/s + bytes/s).
- `metrics.ts` — tick-duration ring → p50/p99/max/overruns for the KPI.
- `botClient.ts` / `bot.ts` / `soak.ts` — headless prediction bots for tests + soak.

### Endpoints

- `ws://localhost:8090/realtime` — protocol v2 (see `packages/shared/src/net/`).
- `GET /healthz` — `{ ok, protocol, uptimeMs, sessions, players, connections }`.
- `GET /metrics` — `{ protocol, sessions, players, connections, maxSessions,
  snapshotBytesPerSec, eventQueueDepth, tickMs:{p50,p99,max,mean,overruns} }`.

### Environment

| Var | Default | Meaning |
|---|---|---|
| `REALTIME_PORT` (or `PORT`) | `8090` | listen port |
| `MAX_SESSIONS` | `200` | concurrent-session cap; further creates get `server_full` |
| `IDLE_SESSION_TIMEOUT_MS` | `600000` | populated-but-silent sessions are reaped after this |

## Module resolution (why this runs without a build step in dev)

`@friendslop/sim` sources import `@shared/*` via tsconfig path aliases. This app's
`tsconfig.json` declares the same `@shared/*` / `@sim/*` paths, and **tsx resolves tsconfig
paths natively**, so `pnpm dev` executes the sim/shared TypeScript directly — no build
artifacts. Vitest gets the same aliases from `vitest.config.ts`. The **production** build
(`pnpm --filter @friendslop/realtime build`) is `build.mjs`: esbuild bundles the server + those
workspace sources + `ws`/`zod` into a single self-contained `dist/index.js` (run with
`node dist/index.js`), which is what the Docker image ships.

## Local two-tab dev

```sh
pnpm dev:mp        # web (vite :5173) + realtime (:8090) concurrently
```

1. Open `http://localhost:5173` in **two** tabs (or two browsers).
2. Tab 1: **Play Together → Create Party**. Copy the 6-char code; **Enter Hub**.
3. Tab 2: **Play Together →** paste the code **→ Join Party → Enter Hub**. Both tabs share the
   hub — walk around and each sees the other move (20 Hz snapshots + ~100 ms interpolation), with
   name tags and live pings on the PingCard/PartyHUD.
4. Walk to the **Expedition Gate** and press **E**: a shared 5 s countdown broadcasts to both
   tabs (press E again to cancel); at zero the server flips the whole party into the expedition.
5. On a hunt wipe, the **Return to Hub** button sends the party back. Close a tab mid-session and
   the other sees it go link-dead; reopening within the resume window rejoins seamlessly.

Artificial latency: `?net=150ms±30,loss1%` on a tab's URL (see `apps/web/src/net/transport.ts`).

## Headless checks (no browser)

```sh
pnpm --filter @friendslop/realtime test    # unit + integration (prediction, combat, relic,
                                            #   hardening, zone flow)
pnpm --filter @friendslop/realtime bot      # single real-socket KPI bot (server must be up)
SOAK_MS=60000 pnpm --filter @friendslop/realtime soak   # scaled fleet soak (in-process)
```

The **soak** (`soak.ts`) runs 4 sessions × 4 bots (combat + relic-relay) at wall-clock 30 Hz for
`SOAK_MS` (default 10 min), asserting zero crashes, a flat memory slope, and tick **p99 < 15 ms**.
Run with `node --expose-gc` (via `NODE_OPTIONS=--expose-gc`) for a cleaner memory trend.

## Protocol version bump procedure

The wire is versioned by `PROTOCOL_VERSION` in `packages/shared/src/net/constants.ts`. The
server rejects a `hello` whose version differs (closes with 4400; the client surfaces
"update available"). **Bump it on every breaking wire change** — a changed binary layout
(`input.ts` / `snapshot.ts`), a new/renamed/removed control message, or changed field semantics.

1. Edit `PROTOCOL_VERSION` (e.g. `2 → 3`) and update its comment with the reason.
2. Update the codecs/schemas in `packages/shared/src/net/` and their round-trip tests.
3. `pnpm -r typecheck && pnpm -r test`.
4. Ship web + realtime **together** (see runbook) — CI stamps the realtime image
   `:proto-N` + an `org.gamedash.protocol` label so the running protocol is visible. Because the
   SPA and server deploy from the same commit, versions never skew for long; a client on the old
   bundle during the rollout window gets the friendly "update available" and refreshes.

## Deploy runbook

See `DEPLOYMENT.md` for the full picture. In short: GitHub Actions builds & pushes
`ghcr.io/ainderew/gamedash-realtime:latest` (`apps/realtime/Dockerfile` → esbuild bundle on
`node:22-alpine`, non-root), then SSHes the droplet and restarts the container on loopback
`127.0.0.1:3003:8090` alongside the web container. The host nginx `location /realtime`
(`deploy/gamedash.nginx.conf`) upgrades WSS traffic to it, so clients dial
`wss://gamedash.workdash.site/realtime` (same origin as the SPA — no CORS). A realtime redeploy
`docker stop -t 15`s the old container: the server catches SIGTERM, tells live sessions "server
restarting", and exits within its 10 s grace so clients reconnect + resume cleanly.

Manual:

```sh
docker compose -f docker-compose.vps.yml up -d --build realtime   # build+run locally/on host
docker build -f apps/realtime/Dockerfile -t gamedash-realtime .    # image only (context = repo root)
curl -s localhost:3003/metrics | jq                                 # once running behind the loopback
```
