# Phase 4 — Authoritative Expedition: Monsters, Combat, Loot

> **Goal:** the party fights the *same* monsters. Spawns, AI, projectiles, damage, deaths, and loot are simulated only on the server; clients render interpolated monsters and get instant-feeling, lag-compensated melee. Game feel (hitstop, shake, numbers, combos) survives the authority move.
>
> **Depends on:** Phase 3. **Parallel with:** Phase 5 (both touch expedition; coordinate on `stepSim` changes).

## Tasks

### Task 1: Server-side expedition lifecycle
- Session gains `zone: 'hub' | 'expedition'` (party-wide, see Phase 6 gate UX). On transition the server: resets world combat state, seeds `createSpawnState()`, spawns players at the expedition origin, runs full `stepSim` order (spawn → ai → weapons → knockback → projectiles → movement → separation → relic → health → loot).
- `spawnSystem` is already deterministic (ring placement, no `Math.random`) — now it simply *only runs on the server*; clients learn about monsters exclusively from snapshots + a `MonsterSpawned { id, archetype, pos }` reliable event (so clients can play spawn FX and pre-warm meshes).
- Wave/monster-count HUD state comes from server events (`WaveStarted`, existing store fields `wave`, `monstersAlive` — `apps/web/src/ui/store.ts`).

### Task 2: Monster replication + client rendering
- Snapshot records for monsters: id, archetype (u8, join-time or spawn-event only), pos, rotY, hp, aiState (u8 → drives animation), staggerUntil flag. Interpolated via `sim/src/interp.ts`.
- `apps/web/src/game/entities/Monsters.tsx`: in networked mode, entities are created/destroyed from spawn/death events + snapshot presence, **not** by local `spawnSystem`. AI/`aiBrain` fields untouched on clients (no local AI in networked mode — the sim's monster systems are skipped client-side; `stepSim` gains per-system authority flags: `simAuthority: 'server' | 'local'`).

### Task 3: Lag-compensated melee
- `InputCmd` already carries melee edge + aimYaw; add `viewServerTimeMs` (client's interpolated render time) so the server knows *what the attacker saw*.
- **File:** `apps/realtime/src/lagComp.ts` — on melee-hit resolution tick, rewind hittable entities to `viewServerTimeMs` using the Phase 3 position-history ring (clamped to ≤ 200 ms, and never rewind a monster that already died > 1 tick ago), run the **pure arc test** from `sim` (`weaponSystem` arc broad-phase; the client-only blade-socket refinement is *not* replicated — server tolerance = arc + small pad, tuned in `@shared/balance` as `NET_MELEE_PAD`).
- Same rewind path validates monster→player melee only in the *forward* direction (server sim already authoritative there; no rewind needed — players are the ones with prediction).
- Tests: scripted "attacker at 150 ms ping swings at a strafing monster he sees in his crosshair" lands the hit; the same swing 250 ms stale misses (rewind clamp).

### Task 4: Ranged/projectiles
- Server-spawned projectile entities (from validated ranged inputs and spitter AI), replicated in snapshots (pos + vel → clients can dead-reckon between snapshots for smooth fast movers). Client plays muzzle FX predictively on input; impact FX on the server's `DamageDealt`/despawn event.

### Task 5: Feel preservation under authority (the smoothness contract)
- **Predict the swing, confirm the hit:** on melee input the local client immediately plays animation + whoosh (`hooks.onSwing`) — no waiting. `DamageDealt { targetId, amount, strength, sourceId, pos }` reliable events from the server trigger: floating numbers, hitstop, screenshake, flash, knockback visuals. At ≤ 120 ms RTT the confirmation lands mid-swing — perceptually instant.
- **Hitstop/slow-mo become presentation-only in networked mode** (flip the `localOnly` flag from Phase 1 Task 4): freeze animation mixers/camera/FX aging (`impactFxSystem` already runs on real time), never the sim clock. Solo keeps the old sim-freezing feel.
- **Combo state** (`combat/combo.ts`) is input-cadence driven — stays fully client-side for feel; server independently tracks its own combo for damage computation (both from the same input stream → agree by construction; divergence only on dropped inputs, resolved in server's favor via `DamageDealt.amount`).
- Parry: predicted stance instantly; `ParrySuccess` event drives the reward FX. Parry negation itself is server-side in `dealDamage`.

### Task 6: Health, downed, and hunt-fail
- Player HP is server-owned; HUD reads it from snapshots (replaces the 10 Hz local HP bridge in networked mode). Knockback/stagger on the *local* player uses the Phase 3 `ServerImpulse` replay path (no-rubberband contract #3): applied on receipt for instant feel, replayed by reconciliation so authority and prediction agree — a monster hit must read as a shove with hurt-flash, never as a position correction. This interaction is THE rubberband hot spot; it gets its own harness scenario (strafing player takes brute knockback at 150 ms ping — assert one smooth arc, zero visible correction).
- `PlayerDowned` → downed state (not despawn): teammate revive interaction (hold E near body, `REVIVE_MS` in balance) — *new mechanic required by co-op* (solo death = hunt failed stays). All players downed → server emits `HuntFailed` → store flag (existing `huntFailed` overlay) + return-to-hub (Phase 6 transition).
- Loot: `LootDropped`/`MaterialCollected` events now originate on the server (`lootSystem` server-authoritative; pickup radius check server-side, per-player or shared-pool — **shared pool** (everyone gets the tally) for co-op friendliness, constant in balance). Store `materials` updates from server events only, in networked mode.

### Task 7: Bot + integration tests
- Extend `apps/realtime/src/bot.ts`: 2 bots fight wave 1 with scripted melee; asserts monsters die on both bots' views within 1 snapshot of each other, HP/materials tallies match server exactly after 60 s.

## Acceptance criteria
- Two browsers at simulated 150 ms: both see identical monster positions (within interpolation), kill the same brute, see the same damage numbers and drops; no monster "dies on my screen but keeps hitting my friend."
- Melee at 150 ms ping feels like solo: swing is instant, hitstop lands imperceptibly late, no whiffs on visually-clean hits (lag-comp KPI: ≥ 95 % of on-screen-valid swings confirmed).
- A tampered client cannot: kill monsters it didn't hit, take no damage, or inflate drops (server ignores all outcome claims — it only ever received inputs).
- Bot integration test green in CI.

## Risks
- **Server blade-socket gap:** server validates with arc-only + pad — too generous invites cheating-adjacent hits, too tight causes whiffs. Tune `NET_MELEE_PAD` with the latency harness; log server-side hit/miss deltas vs client claims to calibrate.
- **Event ordering vs snapshots** (death event before the snapshot showing the corpse): give reliable events a `serverTick` and have clients apply them at/after that tick in interpolation time.
- **Per-system authority flags complexity** in `stepSim` — keep it a single `authority` param consulted at the system list level, not scattered ifs.
