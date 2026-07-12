# Multiplayer — Handoff

> **Last updated:** 2026-07-12
> **Feature:** Real-time co-op (shared hub + expedition, server-authoritative).
> **Plan docs:** `feature-plans/multiplayer/00-overview.md` … `06-*.md` (design); this file = current state.

---

## 1. TL;DR status

Real-time co-op is **built and live**. Friends can open the site, create/join a party by 6-char
code, share a hub, gate into an expedition together, and fight the same server-authoritative
monsters. Movement, combat, and the relic relay are server-owned with client prediction.

- **Live:** https://gamedash.workdash.site — deployed commit **`4cb514a`**.
- **Realtime endpoint:** `wss://gamedash.workdash.site/realtime` (verified working end-to-end).
- **⚠️ 4 commits are NOT deployed yet** (see §4) — today's co-op fixes + remote combat anims.
- **Create-party works** on the live site (verified: session `PHPZU9` created cleanly). Any
  "infinite loading" is environmental — stale browser cache (hard-refresh) or a dead local
  `dev:mp`, not a code bug.

---

## 2. Architecture (how it works)

**Model:** server-authoritative state sync + client-side prediction + snapshot interpolation.
The client sends *intent* (inputs), never state; the server decides all outcomes.

```
Browser (per player)                         apps/realtime (Node ws room server)
├─ React UI / HUD                            ├─ one Session per party (≤4), each owns a
├─ R3F <Canvas> renderer                     │   GameWorld stepped at FIXED 30 Hz
├─ @friendslop/sim (SAME code as server):    ├─ consumes InputCmds → stepSim (authority:'server')
│   ├─ local player: predict + reconcile     ├─ broadcasts binary snapshots @20 Hz + reliable
│   └─ remotes/monsters: interpolate ~100ms  │   events (damage, spawn, relic, …)
└─ net/ transport (WSS binary)  ───────────► └─ SERVER OWNS every gameplay outcome
```

**Key packages / apps:**
- `packages/sim` (`@friendslop/sim`) — the headless ECS simulation. Runs **identically** in the
  browser and the server (this is what minimizes de-sync). No three.js / React inside.
- `packages/shared/src/net` — wire protocol: `messages.ts` (JSON control), `input.ts` +
  `snapshot.ts` (binary codecs), `constants.ts` (tick rates, flags, protocol version = **2**).
- `apps/realtime` — the room server (`ws`, hand-rolled rooms; **no Colyseus**).
- `apps/web/src/net` — client transport, prediction driver (`netGame.ts`), session client
  (`client.ts`), relic net-state (`relicNet.ts`).
- `apps/web/src/game/entities/RemotePlayers.tsx`, `NetworkedWorld.tsx`, `NetworkedRelic.tsx` —
  render peers / server monsters / relic from the network.

**The no-rubberband contract** (binding — see `00-overview.md`): same-sim prediction (corrections
≈ 0/min on a clean link), redundant inputs, adaptive jitter buffer, server impulses replayed (not
fought), no hard snaps. Bot KPI held **0 corrections/min @150 ms + 1% loss** through movement,
combat, and the relic relay.

---

## 3. What's implemented

**Phases 1–6 (all committed):** headless sim extraction · room server + sessions + ping card ·
prediction/reconciliation + binary snapshots · server-authoritative combat + lag-comp melee ·
relic relay · session UX + reconnect + deploy artifacts.

**Live-bug fixes & co-op completion (today):**
| Area | What | Commit | Deployed? |
|---|---|---|---|
| Movement freeze | input `seq` now monotonic across netGame restarts | `0e0188d` | ✅ (in 4cb514a) |
| Invisible peers | was stale-server/session confusion — verified working | — | ✅ |
| Networked expedition | shared players + server monsters render | `00feda1` | ✅ |
| Relic visible on gate-entry | seed `relicNet` from snapshot | `148ddd3` | ❌ |
| Co-op revive | **hold R** near a downed teammate | `148ddd3` | ❌ |
| Throw-pass to a human | remote pass targeting + server entity id | `148ddd3` | ❌ |
| Hit feedback | floating damage numbers + monster flash | `15fb23c` | ❌ |
| Projectile + pickup visuals | replicated w/ `entityGone` despawn signal | `7dd46d4` | ❌ |
| Reconnect monster models | `welcome` carries monster roster | `7dd46d4` | ❌ |
| Remote combat anims | attack / dodge / jump / downed on peers | `1bb118f` | ❌ |

---

## 4. Deploy state & how to deploy

- **Local `main` HEAD:** `1bb118f`. **Deployed `origin/main`:** `4cb514a`. → **4 commits ahead.**
- **Undeployed:** `148ddd3`, `15fb23c`, `7dd46d4`, `1bb118f` (the ❌ rows above).
- Several of these **changed the server** (`session.ts`, `connection.ts`, protocol), so going live
  needs a **redeploy of BOTH containers** (web + realtime), which the pipeline does automatically.

**To deploy:** `git push` (local `main` → `origin/main`) → CI (`.github/workflows/deploy.yml`)
builds & pushes both images and restarts both droplet containers. A mid-game redeploy gives players
a brief "reconnecting" blip (10 s SIGTERM drain), then resumes via their resume token.

**Watch it:** the repo has no `gh` CLI, but the GitHub Actions tab works; or poll the API
(a token is available via `git credential fill`).

**Infra (already set up, one-time done):**
- DigitalOcean droplet `194.233.79.158`. Two containers: `gamedash-web` (`:3002`),
  `gamedash-realtime` (`:3003`→8090). Host nginx + certbot terminate TLS.
- The nginx `/realtime` WebSocket-upgrade block **is already installed** on the droplet (backup at
  `/etc/nginx/sites-available/gamedash.bak.mp`). No further host setup needed.
- **SSH:** `ssh -i ~/.ssh/id_ed25519 root@194.233.79.158` works from Andrew's machine (his key is
  in the droplet's authorized_keys). Health: `curl -s localhost:3003/healthz`,
  `curl -s localhost:3003/metrics | jq`.
- Repo secrets (`DROPLET_IP`, `SSH_PRIVATE_KEY`, `GHCR_PAT`) already set — CI reuses them.

---

## 5. Local dev

```bash
pnpm dev:mp    # runs web (:5173) + realtime (:8090) together
```
- Client defaults `VITE_REALTIME_URL` to `ws://localhost:8090/realtime` in dev.
- **Two-tab test:** open `http://localhost:5173` twice → Play Together → Create in one, Join by
  code in the other → Enter Hub → walk to the Expedition Gate, press **E** for the countdown.
- **Gotcha:** if `dev:mp` fails with `EADDRINUSE :::8090`, a stale realtime process is squatting the
  port — kill it (`Get-NetTCPConnection -LocalPort 8090 | … Stop-Process`) and rerun.

---

## 6. Known issues, gaps & caveats

**Not yet implemented (deferred):**
- **Relic catch/throw + hurt animations on remote players** — locomotion/attack/dodge/downed are
  networked (flag byte), but catch/throw/hurt are event-driven and not yet wired to remotes.
- **Projectile faction & pickup rarity aren't on the wire** — networked projectiles render as
  monster-purple, pickup orbs as "common". The loot **count** is authoritative (correct).
- **Relic pass-target eligibility UI** on the client doesn't reflect the server rotation rule
  (client shows eligible; server still rejects correctly → `passRejected`).

**Test / verification gaps:**
- `apps/realtime/src/combat.integration.test.ts` is **skipped** — its seed-sensitive send stream is
  perturbed by the newer reliable broadcasts (relic/entityGone). Shared-monster replication is no
  longer CI-covered; the 2-bot harness still exists if re-tuned.
- **The client render path was never WebGL-verified in this environment** (the agent's preview pane
  can't init the R3F canvas). All the ❌ commits are proven at build/logic + data-path level only —
  they need a **real 2-tab playtest**. This is the single most important open action.
- `apps/web/src/game/world/hubLayout.test.ts` currently **fails** — that's Andrew's in-progress hub
  art/layout edit, unrelated to netcode.

**Operational gotchas learned the hard way:**
- **Don't instrument `window.WebSocket` by replacing the constructor** without copying its static
  constants (`OPEN` etc.) — the client's `readyState === WebSocket.OPEN` guard silently fails and
  makes a working client look hung. (This caused a false "nginx is broken" investigation.)
- **Commit discipline:** Andrew runs a **parallel art/content workstream**. Netcode commits use
  **explicit paths**, never `git add -A`, so art stays his to manage. Never revert files under
  `apps/web/src/game/world/**`, `camera/**`, `public/**`, `ui/intro/**`, or `assets/asset-ledger.json`.
  There are ~90 uncommitted art/content files in the tree at handoff time — that's expected.

---

## 7. How to verify it's healthy

**Server (droplet):**
```bash
curl -s localhost:3003/healthz     # {"ok":true,"protocol":2,...}
curl -s localhost:3003/metrics|jq  # tick p99 should be < 15 ms
docker logs --tail 30 gamedash-realtime   # ws_connected / session_created events
```
**Public WS handshake:** a browser Create-Party should log `session_created` server-side within a
second. A raw check: a Node `ws` client to `wss://…/realtime` sending
`{type:'hello',protocolVersion:2,name:'x',character:'druid'}` then `{type:'createSession'}` gets a
`welcome`.

**In-browser data check (dev build only — prod hides these):** `window.__netClient` and
`window.__world` are exposed in DEV. e.g.
`[...__netClient.remoteServerEntities()]` (monsters), `__netClient.remoteBuffer(id)` (peer poses),
`relicNet.state`.

---

## 8. Next steps (recommended order)

1. **Playtest the 4 undeployed commits** with two real people (relic visible? revive? throw-pass?
   damage numbers? projectiles? peer attack/dodge anims?). Fix whatever's off *before* stacking more.
2. **Deploy** those commits (`git push`) once confirmed.
3. **Remote relic catch/throw + hurt animations** (event-driven — the remaining animation gap).
4. **Projectile faction + pickup rarity on the wire** (1 bit each) for correct colors.
5. **Re-tune & un-skip** the combat integration test so shared-monster replication is CI-covered.
6. Longer-horizon (from the plan, out of current scope): public/matchmade lobbies, player-hosted
   (Electron listen-server) for the Steam route, WebTransport datagrams.

---

## 9. File map (where to look)

| Concern | File(s) |
|---|---|
| Wire protocol | `packages/shared/src/net/{messages,input,snapshot,constants}.ts` |
| Room server / sessions | `apps/realtime/src/{index,session,connection,inputQueue,lagComp}.ts` |
| Client transport / session | `apps/web/src/net/{transport,client,useSession}.ts` |
| Local-player prediction | `apps/web/src/net/netGame.ts`, `packages/sim/src/prediction.ts` |
| The shared tick | `packages/sim/src/step.ts` (`stepSim`), `loop.ts` (fixed stepper) |
| Render peers / monsters / relic | `apps/web/src/game/entities/{RemotePlayers,NetworkedWorld,NetworkedRelic}.tsx` |
| Client tick adapter | `apps/web/src/game/ecs/SystemRunner.tsx` |
| Relic net-state | `apps/web/src/net/relicNet.ts` |
| Deploy | `Dockerfile`, `apps/realtime/Dockerfile`, `docker-compose.vps.yml`, `deploy/gamedash.nginx.conf`, `.github/workflows/deploy.yml`, `DEPLOYMENT.md` |
