# @friendslop/realtime — session room server

Node WebSocket server for real-time multiplayer (Phase 2 of `feature-plans/multiplayer/`).
Hand-rolled rooms/protocol on `ws` (Decision #3 — no Colyseus). Serves:

- `ws://localhost:8090/realtime` — protocol v1 (JSON control messages, see
  `packages/shared/src/net/`): hello/version handshake, create/join session by 6-char
  code (≤4 players), 2 s heartbeat with RTT EWMA + clock sync, ~1 Hz roster broadcast,
  and the **temporary** 15 Hz hub transform relay (`src/relay.ts` — Phase 3 deletes it).
- `http://localhost:8090/healthz` — `{ ok, uptimeMs, sessions, players, connections }`.

Port: `REALTIME_PORT` env (default `8090`).

## Module resolution (why this runs without a build step)

`@friendslop/sim` sources import `@shared/*` via tsconfig path aliases. This app's
`tsconfig.json` declares the same `@shared/*` / `@sim/*` paths, and **tsx resolves
tsconfig paths natively**, so `pnpm dev` executes the sim/shared TypeScript sources
directly — no build artifacts, and the web/vite setup is untouched. Vitest gets the
same aliases from `vitest.config.ts`. (The `./net` subpath export on
`@friendslop/shared` exists for published/bundled consumers; server code uses the
`@shared/net/*` alias for consistency with the sim.)

## Two-tab local testing

1. From the repo root run both servers:

   ```sh
   pnpm dev:mp        # web (vite :5173) + realtime (:8090) concurrently
   ```

   Or individually: `pnpm --filter web dev` and `pnpm --filter @friendslop/realtime dev`.

2. Open `http://localhost:5173` in **two** browser tabs (or two browsers).
3. Tab 1: **Multiplayer → Create Session**. You land in the hub; the PingCard
   (bottom-right) shows the 6-char session code.
4. Tab 2: **Multiplayer →** enter the code **→ Join**. Both tabs now share the hub:
   walk/jump around and each tab sees the other's avatar moving smoothly
   (15 Hz relay + 100 ms interpolation), with a name tag and live pings on both
   PingCards (green < 60 ms, yellow < 120 ms, red ≥ 120 ms).
5. Close one tab: the other sees the avatar despawn within ~5 s and its PingCard row
   disappear. Rejoining with the same code works.

Artificial latency: use the browser devtools network throttling on one tab and watch
its ping color change on both PingCards.

## Headless integration check (no browser)

With the server running:

```sh
pnpm --filter @friendslop/realtime devbot
```

Connects two fake clients, creates/joins a session, relays transforms both ways,
asserts ping measurement, teleport clamping, and disconnect notification. Exit code 0
= all checks passed.

## Tests

```sh
pnpm --filter @friendslop/realtime test
```

Session lifecycle (join/leave/full/bad-code/GC/resume), handshake (version mismatch),
malformed-message resilience, RTT EWMA, and relay clamps.
