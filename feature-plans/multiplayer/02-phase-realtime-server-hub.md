# Phase 2 — Realtime Server + Shared Hub Presence

> **Goal:** a walking skeleton of the whole stack. `apps/realtime` exists, sessions can be created/joined with a code, and two browsers see each other's characters moving around the social hub.
>
> **Depends on:** Phase 1. **Blocks:** 3, 4, 5, 6.

## Scope honesty

Hub presence in this phase uses **client-published transforms relayed by the server** (with server-side sanity clamps), *not* the full input-authoritative pipeline — that lands in Phase 3 and replaces the relay. This is deliberate throwaway-ish work (~1 file) that gets multiplayer visible early and builds the remote-player rendering path (interpolation, avatars, name tags) that Phase 3 keeps unchanged. The hub has no gameplay stakes, so temporary trust is acceptable *only here*.

## Tasks

### Task 1: `packages/shared/src/net/` — protocol module
- **Files:** `net/messages.ts` (typed control messages: `hello`, `welcome`, `joinSession`, `sessionState`, `playerJoined/Left`, `transformUpdate` (temp), `ping/pong`, `error`), `net/constants.ts` (`PROTOCOL_VERSION`, tick rates, interp delay), `net/ids.ts` (`PlayerId`, `SessionCode` helpers).
- JSON envelope for everything in this phase (binary comes in Phase 3). Zod schemas for inbound validation on the server (zod is already a server dep).
- Export via a `./net` subpath like the existing `./schema` split (`packages/shared/package.json`).

### Task 2: `apps/realtime` workspace — room server
- **Files:** `apps/realtime/package.json` (deps: `ws`, `@friendslop/shared`, `@friendslop/sim`, `zod`; dev: `tsx` for `pnpm dev`, `tsup`/`esbuild` for build), `src/index.ts` (HTTP server + `ws` upgrade on `/realtime`, `/healthz` endpoint), `src/session.ts`, `src/connection.ts`.
- **Session model:** `Session { code: 6-char, players: Map<PlayerId, Conn>, world, createdAt }`. Create → returns code + `playerId` + `resumeToken`; join by code (reject >4 players, wrong version). Sessions GC'd after last player leaves + grace.
- Per-connection: hello handshake → version check → attach to session. Heartbeat ping/pong every 2 s; also measures RTT and serves **clock sync** (client keeps an EWMA estimate of `serverTimeOffset` — needed properly in Phase 3, cheap to start now).
- Structured logging (pino or console-JSON): session lifecycle, join/leave, error causes.

### Task 3: Hub presence loop (temporary relay)
- Client publishes local player transform + anim flags at 15 Hz (`transformUpdate`); server clamps (speed/teleport sanity vs `PLAYER_SPEED`, hub bounds) and rebroadcasts to session peers at 15 Hz batched.
- Server does not yet run `stepSim` for the hub — it will from Phase 3 on.

### Task 4: Client networking layer
- **Files:** `apps/web/src/net/transport.ts` (thin `Transport` interface + WebSocket impl, auto-reconnect w/ backoff), `apps/web/src/net/client.ts` (connection state machine: idle → connecting → joined; message dispatch), `apps/web/src/net/useSession.ts` (React glue).
- Store additions (`apps/web/src/ui/store.ts`): `session?: { code, playerId, members: [{id, name, ping}] }`, `connectionState`. Keep the "UI/meta only" doctrine — net *gameplay* state goes to the ECS, not zustand.
- Env: `VITE_REALTIME_URL` (defaults to `ws://localhost:8090/realtime` in dev, `wss://gamedash.workdash.site/realtime` in prod).

### Task 5: Remote player entities
- **File:** `apps/web/src/game/entities/RemotePlayers.tsx` — for each session member ≠ self, add ECS entity `{ id, remotePlayer: true, transform, health, faction:'player' }` and render with the existing `AnimatedCharacter` (reuse `Teammates.tsx:36` druid-avatar approach + character choice), name tag billboard.
- **File:** `sim/src/interp.ts` — snapshot interpolation buffer (per-entity ring of timestamped states; sample at `now - INTERP_DELAY_MS`, hermite/lerp position, shortest-arc lerp rotationY). Written generically now; Phase 3+ reuses it verbatim for monsters/projectiles.
- Anim state for remotes driven by velocity + flags (walk/run/idle/jump) through the existing animation resolver.

### Task 6: Minimal session UI (dev-grade) + ping card
- Enable the MainMenu "Multiplayer" button (`apps/web/src/ui/MainMenu.tsx:143-149`): Create Session (shows code) / Join (code input) → both land in the hub `scene`. Polished UX is Phase 6; this is functional plumbing.
- **`apps/web/src/ui/PingCard.tsx` — real-time ping display (explicit user request).** A small always-visible card in a HUD corner listing every session member with their live ping. **Rendered as plain DOM (React + Tailwind, same as the rest of the HUD overlay) — never three.js/Canvas text or sprites.**
  - Data flow: the server measures each player's RTT via the 2 s heartbeat and includes all members' EWMA pings in a lightweight `sessionState` broadcast (~1 Hz); your *own* ping updates from every local pong (2 s). UI re-renders are throttled through the zustand `session.members[].ping` field — no per-frame React work (respects the "React is for UI only" doctrine).
  - Presentation: name + `NN ms`, color-coded thresholds (green < 60, yellow < 120, red ≥ 120, greyed/`—` while reconnecting), subtle enough to live on screen permanently; collapses to just your own ping when solo-in-session.
  - This card is the *player-facing* surface; the F3 debug overlay (Phase 3) is the developer surface — they share the RTT source, not the component.

### Task 7: Dev-run integration
- `.claude/launch.json` + root scripts: `pnpm dev` variant that runs web + realtime concurrently. Document two-tab local testing in `apps/realtime/README.md`.

## Acceptance criteria
- Two browser tabs: create + join by code; both see each other walking/jumping around the hub with smooth motion (no visible stepping at 15 Hz thanks to interpolation) and correct character avatars.
- Ping card shows both members with live values that visibly react when artificial latency is toggled; it's DOM-rendered (verifiable in the element inspector, not part of the WebGL canvas).
- Kill one tab → other sees the avatar despawn within 5 s; rejoin works.
- Server survives malformed messages (zod-rejected, logged, connection preserved or cleanly dropped).
- Unit tests: session join/leave/full/bad-code; interpolation buffer sampling.

## Risks
- **Scope creep toward real netcode here** — resist; the relay is a placeholder, prediction work belongs to Phase 3 where it lands on the sim, not on ad-hoc transforms.
- Multiple Canvas-side singletons (world, event queue) now created per-session lifecycle — verify create/teardown on join/leave doesn't leak entities across sessions.
