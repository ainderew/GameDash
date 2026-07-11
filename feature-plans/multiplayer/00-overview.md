# Feature Plan: Real-Time Multiplayer — Shared World Co-op

> **Created:** 2026-07-11
> **Phases:** 6 (+ this overview)
> **Status:** Planning
> **Supersedes:** friendslop Decision #4 ("Solo + cloud save + async social"). Real-time co-op is now in scope; this plan is the netcode counterpart to `feature-plans/friendslop/`.

## Feature Summary

Players join a **session** (party of up to 4 friends) and share one world: the same **social hub**, the same **expedition zone**, the same monsters, the same relic. Movement, combat, and the relic relay are **server-authoritative** — the client predicts, the server decides. The design goal ranked above all others: **catching and fighting must feel smooth** — minimize perceived delay, de-sync, and rubber-banding at real-world friend-group latencies (30–150 ms).

The game stays in the browser. A Steam release via Electron wrapper is a future route; this plan keeps that door open (see *Topology* below) but builds nothing Electron-specific.

## Why the codebase is ready for this

The single-player code was deliberately built with netcode seams (verified 2026-07-11):

- **AI teammates are explicit stand-ins for remote players** — `apps/web/src/game/entities/Teammates.tsx:16`, `ecs/systems/teammateSystem.ts:13` ("until netcode lands").
- **The event bus is the documented server seam** — `apps/web/src/game/events.ts:25`: "when netcode lands, the emits move to the server-ack handler." All relic feedback (arc, catch ring, chime) is driven off events, not call sites, so it works unchanged once events arrive from the network.
- **Sim systems are pure, time-injected, and `Math.random`-free** — `applyPlayerIntent` (movementSystem.ts) is headless-testable; spawn rings are deterministic ("keeps the sim replayable"). This is exactly what client-side prediction replay and a headless server sim need.
- **Near-zero client coupling** — systems import only miniplex + `@shared` + the feel layer; `terrainHeight.ts` has zero imports; `hubLayout.ts` imports only the `Entity` type. No three.js in the sim hot path except `weaponSystem`'s blade-socket refinement (handled in Phase 4).

What does **not** exist yet: any networking code, any deployed backend, any session concept. This is greenfield netcode on well-prepared soil.

## Topology Decision: dedicated server now, player-host later via Electron

The user asked to explore **player-hosted sessions** (Steam listen-server style). Analysis for a browser game:

| | Dedicated server (VPS) | Player-hosted (browser, WebRTC) |
|---|---|---|
| How | Node room server on the existing DigitalOcean VPS, WSS through nginx | Host's browser runs the authoritative sim; peers connect via WebRTC DataChannels |
| Connectivity | Just works (client→server WSS) | Needs a signaling service + STUN; ~10–20 % of NAT pairs also need a **TURN relay** (bandwidth we pay for, often *higher* latency than a VPS hop) |
| Authority / anti-cheat | True server authority — matches the "browser is hostile" doctrine | The host **is** the authority → host can cheat; contradicts the server-authoritative requirement |
| Reliability | Process supervised by Docker; no host-migration problem | Host closes the tab → session dies or needs host migration (a large system in itself); background-tab throttling is survivable (WebRTC-active pages are exempt from Chrome's intensive throttling, sim can run in a Worker) but fragile |
| Latency | One hop to a datacenter; symmetric for all players | Zero for the host (host advantage), residential upload jitter for everyone else |
| Cost | Rooms are cheap: a 30 Hz sim with ≤60 monsters and ≤4 players is trivial CPU; one small droplet runs dozens of rooms | "Free" compute, but TURN + signaling infra still required |

**Decision:** dedicated server rooms now. The enabling move for the future is architectural, not infrastructural: the authoritative sim is extracted into a transport-agnostic, headless package (**`packages/sim`**, Phase 1) that runs identically in a Node room server today, in an **Electron main process as a true listen server** for the Steam route later, or (if ever wanted) in a host browser behind WebRTC. Nothing in the netcode may assume "the server is remote."

## Architecture Overview

```
┌────────────────────────────── BROWSER (per player) ──────────────────────────────┐
│ React UI (menus/HUD)      R3F <Canvas>                                            │
│  party/session UI          ├─ presentation: meshes, anim, FX, audio, hitstop      │
│  ping/debug overlay        └─ PREDICTED local player + INTERPOLATED remotes       │
│                                                                                   │
│  @friendslop/sim (same code as server):                                           │
│   └─ local prediction: re-run applyPlayerIntent for unacked inputs each snapshot  │
│      remote entities: snapshot interpolation buffer (~100 ms behind server time)  │
└───────────────┬───────────────────────────────────────────────────────────────────┘
                │ WSS (binary): input cmds @30 Hz ▲ │ ▼ snapshots @20 Hz + events
┌───────────────┴───────────────────────────────────────────────────────────────────┐
│ apps/realtime — Node room server (NEW)                                             │
│  Session rooms (join code) ── each room runs @friendslop/sim at FIXED 30 Hz:       │
│  player movement (from inputs) · monster AI/spawns · projectiles · damage          │
│  (melee lag-compensated) · relic state machine · loot events                       │
│  SERVER OWNS every gameplay outcome. Clients send intent, never state.             │
└───────────────┬────────────────────────────────────────────────────────────────────┘
                │ (later: hunt-result credit calls)
        apps/server (Next.js economy) ── Supabase Postgres        [unchanged, Phase 3+ of friendslop]
```

**Netcode model (state sync, not lockstep):**

- **Fixed 30 Hz server tick**; snapshots broadcast at 20 Hz with per-entity dirty flags + quantized fields; discrete outcomes (damage, catch, death, loot) as reliable **events** — the existing `GameEvent` types, moved to the wire.
- **Local player: client-side prediction + reconciliation.** Client applies its own input immediately (zero perceived input delay), tags each input command with a sequence number; on each authoritative snapshot it rewinds to the server state and replays unacked inputs. `applyPlayerIntent` + `movementSystem` are already pure — they *are* the replay function.
- **Remote players / monsters / projectiles: snapshot interpolation** — rendered ~100 ms in the past between two known snapshots. Smoothness is bought with a fixed, small delay rather than extrapolation guesses.
- **Melee: lag compensation.** Client sends the swing with its view timestamp; server rewinds hittable positions (≤200 ms ring buffer) to what the attacker saw, validates the arc, applies damage. Favor-the-attacker; misses become rare, hits feel instant.
- **Relic passes stay deterministic.** A pass is fully described by its launch params (Bézier `from/control/to`, `startedAt`, `flightMs`) — the server validates and broadcasts `RelicPassLaunched`; every client plays the *identical* flight locally. Catch/fail is decided by the server at the arrival tick. This mechanic is unusually netcode-friendly because it was designed that way.
- **Game feel goes presentation-only.** Hitstop/slow-mo (`feel/time.ts`) currently freeze the sim; in multiplayer they must freeze only the local presentation layer (anim/camera/FX) — the shared sim clock is the server's. Attack swings/whoosh play predictively on input; hitstop + damage numbers + knockback fire on server confirmation (~1 RTT, imperceptible at ≤100 ms ping).

### The no-rubberband contract (hard requirement)

The player's stated bar is **LAN-native feel; rubberbanding is unacceptable**. Rubberbanding has exactly four causes in this architecture; each gets a structural countermeasure, and all four are treated as correctness bugs (not tuning debt) in review:

1. **Prediction/server divergence** → eliminated by construction: client prediction runs the *same* `@friendslop/sim` functions the server runs. In normal play the authoritative snapshot confirms the prediction bit-for-bit (float noise ≪ the 1–2 cm epsilon) and no correction ever fires. **KPI: reconciliation corrections ≈ 0/min on a clean link (measured in the Phase 3 debug overlay).**
2. **Server-side input starvation** (late/lost input packets → server simulates you idle → retroactive disagreement) → redundant input transmission (each packet carries the last 3 cmds), adaptive per-player jitter buffer, and a starvation policy that coasts on the last movement cmd. The server never rewrites the past because a packet was late.
3. **Unpredictable server-initiated forces** (monster knockback/stagger on the local player — the classic hidden rubberband) → server impulses are explicit sequenced events that the client injects into its own replay stream, so reconciliation *replays* them like inputs instead of fighting them. Knockback feels like a hit, not a teleport.
4. **Hard snap on correction** → banned. Any residual correction folds into the presentation transform over ~100 ms; the sim state corrects instantly, the mesh never jumps.

Corollary: only the **local player** is predicted. Remote players/monsters are interpolated ~100 ms in the past — they can't rubberband because they're never guessed, only replayed. The one place remote delay could be *felt* (relic catches) is absorbed by the pass mechanic's homing budget and server-timeline catches (Phase 5).

## Key Decisions Log

| # | Decision | Choice | Rationale | Date |
|---|----------|--------|-----------|------|
| 1 | Topology | Dedicated server rooms on existing VPS; sim core kept host-agnostic for future Electron listen server | See topology table; "server authoritative" is a hard requirement | 2026-07-11 |
| 2 | Transport | WebSocket (binary frames) behind nginx TLS; thin `Transport` interface so WebTransport (unreliable datagrams) can slot in later | WSS works everywhere today incl. Safari; at 4 players/20 Hz snapshot rates TCP head-of-line blocking is acceptable and mitigated by small packets | 2026-07-11 |
| 3 | Framework | Custom `ws` + hand-rolled rooms/protocol — **no Colyseus** | We already have the authoritative sim (miniplex ECS); Colyseus's value is its schema state-sync, which would *duplicate* our state model and constrain the snapshot format. Custom keeps binary layout, prediction, and lag-comp fully in our control | 2026-07-11 |
| 4 | Sync model | Server state-sync + client prediction + snapshot interpolation + melee lag-comp | Industry standard for action co-op; lockstep is intolerant of jitter, pure relay is not authoritative | 2026-07-11 |
| 5 | Sim placement | New `packages/sim` (`@friendslop/sim`), consumed by web client AND room server | Single implementation = minimal de-sync by construction; keeps drizzle/three out of the sim | 2026-07-11 |
| 6 | Tick rates | Sim 30 Hz fixed · snapshots 20 Hz · inputs 30 Hz · interp delay ~100 ms (all tunable in `shared/net` constants) | Melee arcs and 6 m/s movement don't need 60 Hz; halves VPS cost and bandwidth | 2026-07-11 |
| 7 | Party size | 4 per session (protocol supports more; tuned for 2–4) | "friendslop" — friend-group co-op; relay rotation designed around a handful of carriers | 2026-07-11 |
| 8 | Hub scope | Session-private hub instance (party members only), not a public lobby | Matches the ask ("joining a session puts users in the same hub"); public hubs are an interest-management problem we don't need | 2026-07-11 |
| 9 | Identity | Server-issued guest identity (playerId + resume token) per session; Supabase Auth integration deferred to friendslop Phase 3 | Don't gate multiplayer on the auth phase; token enables reconnect | 2026-07-11 |
| 10 | Economy | Out of scope here; but all loot/hunt events now originate server-side, which *strengthens* the future `reportHuntResult` (server-generated, not client-reported) | Sequencing: netcode first, economy credit wiring later | 2026-07-11 |
| 11 | Feel bar | LAN-native; zero tolerated rubberbanding — see "The no-rubberband contract" above; corrections/min is a tracked KPI from Phase 3 on | Explicit user requirement (2026-07-11): "as native as possible, like LAN; I especially hate rubberbanding" | 2026-07-11 |

## Wire Protocol (v1 sketch — full spec in Phase 3)

- **Control (JSON, reliable):** `hello/welcome` (protocol version, playerId, token, session info), `join/leave`, `ping/pong` (clock sync), `zoneChange`, `event` (GameEvent envelope), `error`.
- **Hot path (binary):** `InputCmd { seq, tick, moveX, moveZ, buttons: bitmask(jump|sprint|dodge|melee|ranged|parry|passHold|drop), aimYaw, passTargetId? }` and `Snapshot { serverTick, lastProcessedSeq per client, entities: [id, kind, pos(int16 cm), rotY(int8), hp?, animFlags, …dirty fields] }`.
- All message types + encode/decode live in `packages/shared/src/net/` (new), imported by both sides — the codec is unit-tested by round-trip, never hand-duplicated.

## Phase Index

| Phase | File | Focus | Playable outcome |
|-------|------|-------|-----------------|
| 1 | `01-phase-sim-extraction.md` | Extract headless `@friendslop/sim`; N-player generalization; fixed-tick wrapper | Single-player unchanged (regression-guarded) |
| 2 | `02-phase-realtime-server-hub.md` | `apps/realtime` room server, sessions/join codes, protocol v1, hub presence | Two browsers see each other walking in the hub |
| 3 | `03-phase-prediction-netcode.md` | Authoritative movement: input cmds, prediction/reconciliation, interpolation, binary snapshots, latency harness | Movement is server-owned yet feels local at 150 ms simulated ping |
| 4 | `04-phase-authoritative-combat.md` | Server-side spawns/AI/projectiles/damage, melee lag-comp, feel preservation | Party fights the same monsters; hits land fair |
| 5 | `05-phase-relic-netcode.md` | Relic state machine on server; pass/catch/fail events over the wire | The relay: pass → catch between real players, smooth |
| 6 | `06-phase-sessions-deploy.md` | Menu/party UX, zone transitions, reconnect, deploy (Docker/nginx/CI), soak test | Friends join via code on gamedash.workdash.site |

**Sequencing note:** Phases 1→3 are strictly ordered. Phase 4 and 5 both depend on 3 and are largely parallel. Phase 6 UX tasks can start after 2; deployment tasks close the plan.

## Out of Scope

- Public/matchmade lobbies, >4-player sessions, cross-session hub.
- Player-hosted sessions in the browser (analyzed above; revisit at the Electron/Steam phase).
- WebTransport/WebRTC transport (interface reserved, not built).
- PvP of any kind; voice/text chat.
- Economy credit wiring (`reportHuntResult` etc.) — friendslop Phase 3 concern, noted at the seams.
- Host migration, spectating, replays.

## Open Questions

- 🟡 **Expedition entry rule:** whole-party gate (everyone teleports on countdown) vs per-player entry into the shared zone. Default: whole-party countdown (simplest coherent relay experience).
- 🟡 **Solo AI teammates in multiplayer:** keep AI fill when party < 3, or humans only? Default: humans only in MP sessions; AI teammates remain in solo mode.
- 🟢 **VPS region vs player geography:** single droplet is fine for one friend group; if groups span continents, room-server region selection becomes a Phase 6+ concern.
- 🟢 **Snapshot encoding library vs hand-rolled:** default hand-rolled flat codec (tiny, testable); revisit only if the schema churns painfully.
