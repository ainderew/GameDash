# Phase 5: Roguelite Loop — Zones, Hunt Sessions & Server-Validated Loot

> **Feature:** friendslop — 3D web gacha roguelite
> **Phase:** 5 of 8
> **Depends on:** `04-phase-gacha-upgrades.md`
> **Estimated scope:** Large

## Context from Previous Phase

Phases 1–4 delivered: a fun client-side combat slice; a server-authoritative economy (`runEconomyTx`, ledger, idempotency); a full gacha system with pity + published odds; and weapon/base upgrade trees. **The missing link:** materials currently come from a provisional `grantDrops` stand-in. This phase builds the real roguelite loop and closes it.

**Relevant existing files:**
- `apps/server/src/services/economy/{runEconomyTx,grantItem,creditCurrency}.ts` — loot credits go through these.
- `apps/web/src/game/ecs/systems/{spawnSystem,lootSystem}.ts` — spawns are hardcoded; loot emits local events.
- `apps/web/src/game/events.ts` — `LootDropped` event.
- `packages/shared/src/schema/*.ts` — `zones`, `monster_defs`, `loot_tables` tables exist (defined Phase 3, populated here).
- `apps/server/src/app/actions/grantDrops.ts` — the provisional grant this phase replaces.

## Objective

Turn the combat sandbox into a progression game: multiple **zones** with escalating monster tiers and zone-gated materials; a **server-tracked hunt/run lifecycle** (start → play → resolve) with in-run temporary boons and permadeath-of-the-run; and **server-validated loot** that safely credits materials without trusting the client's combat claims. Result: the complete loop — hunt harder zones → get rarer materials → upgrade base/weapons → unlock the next zone.

## Architecture Decisions

### Decision: Server seeds the hunt; client reports bounded outcomes; server rolls loot
- **Choice:** `startHunt` returns a server-generated hunt seed + encounter composition. The client simulates combat locally (for feel), then `reportHuntResult` sends *bounded, plausibility-checked* outcomes (kills by monster type, time, damage taken). The server re-derives max plausible rewards from the seed and rolls loot **server-side** from `loot_tables`.
- **Alternatives considered:** (a) Trust client-reported drops — rejected, trivially cheatable. (b) Full server-side authoritative simulation — rejected, that's real-time-MP-grade complexity (out of scope, overview Decision #4).
- **Rationale:** Pragmatic anti-cheat for a single-player loop: the client can't invent monsters that weren't seeded, can't exceed the seed's spawn counts, and never decides drops. Bounds + server RNG close the main exploits without a simulation server.
- **Tradeoff:** Not perfectly cheat-proof (a determined solo cheater could fake plausible results), but the *economy* stays sound: rewards are capped by the seed and rolled server-side. Acceptable for single-player; leaderboards get stricter validation in Phase 7.

### Decision: Zones = hand-authored arenas + procedural spawn/modifier composition
- **Choice:** Each zone is a hand-built grey-box (later art-dressed) arena. Difficulty/variety comes from procedurally composed spawns and run modifiers, seeded server-side.
- **Rationale:** Overview Decision #9 — procedural 3D geometry is out of scope; procedural *encounters* give replayability cheaply.
- **Tradeoff:** Fewer unique layouts than full procgen; far less work.

## Implementation Steps

### Step 1: Populate zone/monster/loot config
**What:** Author the config data driving progression.
**File(s):** `packages/shared/src/content/{zones,monsters,lootTables}.ts` (typed seed data), migration/seed script
**Details:**
- `zones`: `id, tier, unlock_requirement (facility/level or prior-zone clear), monster_pool, material_loot_table_id, modifiers`.
- `monster_defs`: per-archetype HP/damage/speed scaled by zone tier; drop weights.
- `loot_tables`: two-layer (roll rarity tier → roll material within tier), with **pity-like protection** (guaranteed rare material every N hunts) so grinding stays fair (2026 Warframe/MonHun trend).
> **ANTI-PATTERN: Unbounded Grind With No Floor** — ❌ Don't rely on pure low-probability drops for key mats. ✅ Add a guaranteed-rare-every-N-hunts floor. 💡 Pure RNG grind is the #1 churn driver.

### Step 2: Hunt session lifecycle (server)
**What:** Server-tracked runs with seeds.
**File(s):** `apps/server/src/services/hunt/{startHunt,reportHuntResult}.ts`, actions `apps/server/src/app/actions/{startHunt,reportHuntResult}.ts`, `packages/shared/src/schema/hunt.ts`, `packages/shared/src/api/hunt.ts`
**Details:**
- `hunt_sessions(id, player_id, zone_id, seed, encounter jsonb, status ('active'|'succeeded'|'failed'), started_at, ended_at, idempotency_key)`.
- `startHunt({ zoneId, loadout })`: assert zone unlocked; generate CSPRNG seed; compute encounter (waves, monster types, counts, modifiers) from seed + zone tier; persist session; return seed + encounter to client.
- `reportHuntResult({ huntId, kills, timeMs, damageTaken, outcome, idempotencyKey })`: via `runEconomyTx` — validate the session is active & owned; **bound-check** reported kills against the seeded encounter (reject impossible counts); server-roll loot from the zone's `loot_table` for validated kills (+ apply the rare-material floor); credit materials/currency (ledger); mark session resolved.
> **ANTI-PATTERN: Trusting Client-Reported Drops** — ❌ Don't credit whatever the client says it looted. ✅ Server re-rolls loot from the seeded encounter; client reports only bounded kill counts. 💡 The client owns *feel*, the server owns *rewards*.

### Step 3: Client — consume seed, run the hunt, report
**What:** Wire spawns to the server seed and report on completion.
**File(s):** `apps/web/src/game/ecs/systems/spawnSystem.ts` (rewrite), `apps/web/src/game/hunt/HuntController.tsx`, `apps/web/src/api/hunt.ts`
**Details:**
- `spawnSystem` now spawns exactly the seeded encounter (deterministic from the hunt seed) instead of hardcoded waves.
- `HuntController`: manages run state (in-progress, success on clear, fail on player death), tallies kills locally, and calls `reportHuntResult` on completion. On success it shows server-credited rewards; on failure the player **keeps materials collected during the run** (overview default) — implement by reporting on both success and fail outcomes.

### Step 4: In-run boons (temporary progression)
**What:** Roguelite in-run upgrade layer, distinct from persistent meta.
**File(s):** `apps/web/src/game/hunt/boons.ts`, `apps/web/src/game/ecs/systems/boonSystem.ts`, `apps/web/src/ui/hunt/BoonSelect.tsx`
**Details:** Between waves, offer a choice of temporary buffs (Hades-style boons) that last only the run and create build variety. These are client-side (they only affect in-run feel, not the economy) but the *offered set* is seeded server-side to keep it deterministic/repro. Persistent power stays in the Phase 4 upgrade trees.
> **ANTI-PATTERN: Conflating In-Run and Meta Progression** — ❌ Don't let boons grant permanent power. ✅ Boons = run-only variety; meta = persistent trees. 💡 Two separate axes keep runs fresh and progression meaningful.

### Step 5: Zone map + progression UI
**What:** Zone selection gated by unlock requirements.
**File(s):** `apps/web/src/ui/zones/{ZoneMap,ZoneCard}.tsx`, `apps/web/src/api/zones.ts`
**Details:** Zone map shows tiers, unlock status, and material-drop previews. Unlocks are checked server-side (client shows state but the server enforces on `startHunt`).

### Step 6: Loop integration test (the whole thing)
**What:** Prove the closed loop end-to-end.
**File(s):** `apps/server/src/services/hunt/__tests__/loop.test.ts`
**Details:** Simulate: start hunt in zone 1 → report valid kills → receive materials → upgrade a facility that unlocks zone 2 → start hunt in zone 2 (now allowed) → confirm rarer materials drop. This is the acceptance backbone.

## State Management for This Phase

| State | Category | Location | Source of Truth | Persistence |
|-------|----------|----------|-----------------|-------------|
| Hunt session + seed | server data | `hunt_sessions` | **Server** | durable |
| Encounter composition | server data | seed-derived, stored on session | Server | durable |
| In-run kills / boons | game sim | ECS + `HuntController` | client (bounded by server seed) | none (run-scoped) |
| Zone unlock state | server data | derived from `player_facilities`/clears | Server | durable |
| Credited materials | server data | `inventory_items` + ledger | Server | durable |

## Error Handling

| Operation | Failure Mode | User-Facing Behavior | Recovery Strategy |
|-----------|-------------|----------------------|-------------------|
| `startHunt` | Zone locked | "Unlock requirement not met" | Server rejects; UI shows requirement |
| `reportHuntResult` | Implausible kills | Reward capped to seed max; flagged | Server bounds to encounter; logs anomaly |
| `reportHuntResult` | Duplicate report | Idempotent, same rewards | Idempotency key |
| Disconnect mid-hunt | Session left active | Session expires; no rewards, or resume | TTL sweep of stale active sessions |

## Testing Requirements for This Phase

- [ ] Encounter is deterministic from the hunt seed (same seed → same spawns).
- [ ] `reportHuntResult` rejects/caps kill counts exceeding the seeded encounter.
- [ ] Loot is server-rolled; the rare-material floor triggers at the configured cadence.
- [ ] Failed hunt still credits materials collected during the run.
- [ ] Zone 2 `startHunt` fails until its unlock requirement is met, then succeeds.
- [ ] Full loop integration test passes (hunt→materials→upgrade→unlock→harder hunt).

**Test type guidance:** Integration-test the hunt lifecycle and bound-checking against a test DB (highest-value coverage). Unit-test encounter generation determinism and loot-table rolls (seeded). The loop integration test is the phase's definition of done.

## Acceptance Criteria

- [ ] Multiple zones exist with escalating difficulty and distinct material drops.
- [ ] Starting a hunt spawns the server-seeded encounter; clearing it credits server-rolled loot.
- [ ] In-run boons offer temporary build variety and vanish after the run.
- [ ] Materials from hunts feed the upgrade trees, which unlock the next zone.
- [ ] Cheated hunt reports cannot mint materials beyond the seed's plausible max.
- [ ] The core game loop is fully playable and replayable end-to-end.

**Verification commands:**
- `pnpm --filter server test` — hunt lifecycle + loop integration tests pass
- `pnpm --filter shared test` — encounter/loot determinism tests pass
- `pnpm --filter web build && pnpm --filter server build`

**Smoke test:** Enter zone 1, clear the encounter, collect materials, upgrade a facility to unlock zone 2, enter zone 2, and confirm it's harder with better drops. Fail a hunt on purpose and confirm you keep what you collected.

## Handoff to Next Phase

The complete roguelite loop is live and server-safe: seeded zones with escalating tiers, a hunt lifecycle with bounded server-validated loot, in-run boons vs persistent meta, and zone-gated progression. Everything so far uses grey-box/primitive art. Phase 6 stands up the **asset pipeline** — Tripo free-tier MCP for test models, `gltf-transform` optimization, the license ledger, and the paid/self-hosted upgrade path — to replace primitives with real low-poly monsters, weapons, and props. Phase 6 can technically run in parallel with earlier phases since Phase 1's loader is ready, but it's sequenced here so art dresses a proven-fun game.

**Open questions for next phase:**
- Which monsters/zones to prioritize for art — pick the most-played zones from the smoke tests.
- Extraction-risk mode (lose unbanked loot on death) as a harder alternative — a tuning dial, revisit post-launch.
