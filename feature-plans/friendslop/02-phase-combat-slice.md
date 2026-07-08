# Phase 2: Combat Slice — Weapons, Monsters, Hit Detection & Game Feel

> **Feature:** friendslop — 3D web gacha roguelite
> **Phase:** 2 of 8
> **Depends on:** `01-phase-foundation.md`
> **Estimated scope:** Large

## Context from Previous Phase

Phase 1 delivered a playable grey-box world with a third-person kinematic controller (WASD/jump/dodge with i-frames), a miniplex ECS ticked by a single `SystemRunner` `useFrame`, a Draco/KTX2-ready asset loader, and a React/Tailwind HUD split from the R3F `<Canvas>`.

**Files created in previous phases:**
- `packages/shared/src/types.ts`, `.../balance.ts` — shared domain types + tuning constants.
- `apps/web/src/game/GameCanvas.tsx` — `<Canvas>` + `<Physics>` + `<Suspense>` shell.
- `apps/web/src/game/world/{GreyboxArena,Lighting}.tsx` — placeholder zone + lights.
- `apps/web/src/game/entities/Player.tsx` — third-person controller (ecctrl/Rapier KCC).
- `apps/web/src/game/input/useInput.ts` — ref-based input snapshot.
- `apps/web/src/game/camera/ThirdPersonCamera.tsx` — de-occluding follow camera.
- `apps/web/src/game/ecs/{world,components}.ts`, `.../systems/movementSystem.ts`, `.../SystemRunner.tsx` — ECS core.
- `apps/web/src/lib/loaders.ts` — GLTF loader utility.
- `apps/web/src/ui/{HUD,store}.tsx/ts` — HUD + Zustand UI store.

## Existing Codebase Context

- `.../ecs/components.ts` — extend with combat components here.
- `.../ecs/SystemRunner.tsx` — register new systems in explicit order.
- `packages/shared/src/balance.ts` — all combat tuning goes here (damage, cooldowns, HP).
- Player already exposes an `iframeUntil` component — combat must respect it.

## Objective

Make hunting *fun* before any backend exists. Add one melee and one ranged weapon, 2–3 monster archetypes with basic AI, server-agnostic hit detection, a Mixamo-driven animation state machine, health/damage/death, and **local** material drops (visual pickups only — persistence is Phase 3). This phase de-risks the single hardest part of a 3D web game: combat feel. Everything is still grey-box/primitive; real art is Phase 6.

## Architecture Decisions

### Decision: Hit detection = shapecast (melee) + sensor colliders (projectiles)
- **Choice:** Melee resolves via a Rapier shapecast / `three-mesh-bvh`-accelerated overlap along the swing arc during active frames. Projectiles are small dynamic bodies with sensor colliders; on intersection they apply damage and despawn.
- **Alternatives considered:** Pure trigger volumes for melee (imprecise), full per-bone hitboxes (overkill for low-poly).
- **Rationale:** SRP — hit detection is a system, decoupled from rendering and from the damage rules.
- **Tradeoff:** Slightly more math than trigger volumes; buys responsive, fair hits.

### Decision: Client-side combat is authoritative *only for feel*; loot is provisional
- **Choice:** Combat runs fully client-side (no server yet). Materials dropped this phase are **local/provisional**; Phase 3 replaces the drop grant with a server-validated call. Design the drop event as a typed payload now so swapping the sink is trivial.
- **Rationale:** Overview's "intent, not outcome" rule — build the seam now (OCP) so Phase 3 plugs the server in without rewrites.
- **Tradeoff:** Drops don't persist yet; acceptable for a feel slice.

## Implementation Steps

### Step 1: Combat components + shared combat constants
**What:** Add ECS components and balance constants for combat.
**File(s):** `apps/web/src/game/ecs/components.ts`, `packages/shared/src/balance.ts`, `packages/shared/src/combat.ts`
**Details:**
- Components: `health {current,max}`, `damageDealer {amount,knockback}`, `faction ('player'|'monster')`, `attackState {kind, startedAt, activeFrames}`, `aiBrain {state, targetId, lastAttackAt}`, `lootDropper {tableId}`.
- `combat.ts`: pure functions `computeDamage(base, mods)`, `isInIFrames(entity, now)`. No rendering, no Rapier — unit-testable.
- `balance.ts`: `MELEE_DAMAGE`, `MELEE_COOLDOWN_MS`, `RANGED_DAMAGE`, `PROJECTILE_SPEED`, monster `HP`/`SPEED`/`ATTACK` per archetype.

### Step 2: Weapon system — one melee, one ranged
**What:** Player attacks that spawn hit queries / projectiles.
**File(s):** `apps/web/src/game/ecs/systems/weaponSystem.ts`, `apps/web/src/game/entities/Projectile.tsx`
**Details:**
- Melee: on attack input, enter `attackState` for N active frames; during active frames run a shapecast arc in front of the player; apply `computeDamage` to overlapped `faction:'monster'` entities once per swing (track hit set to avoid multi-hits).
- Ranged: spawn a projectile entity (dynamic body + sensor); `projectileSystem` moves it, applies damage on sensor intersect, despawns on hit/lifetime.
- Respect attack cooldowns from `balance.ts`.
> **ANTI-PATTERN: Applying Damage Every Frame of a Swing** — ❌ Don't damage on each active frame. ✅ One hit per target per swing via a per-swing hit set. 💡 Otherwise a single swing deletes everything instantly.

### Step 3: Monster archetypes + AI system
**What:** 2–3 monsters (e.g., melee chaser, ranged spitter, tanky brute) with a simple state machine.
**File(s):** `apps/web/src/game/entities/Monster.tsx`, `apps/web/src/game/ecs/systems/aiSystem.ts`, `apps/web/src/game/ecs/systems/spawnSystem.ts`, `packages/shared/src/monsters.ts`
**Details:**
- `aiSystem`: FSM `idle → chase → attack → cooldown`. Steering toward player; attack when in range and off cooldown; respect player i-frames (attack still fires, damage is nullified if player is in i-frames).
- `spawnSystem`: spawns waves in the grey-box arena (hardcoded encounter now; procedural composition is Phase 5).
- Monsters render as **instanced** primitives where possible (drei `<Instances>`) to hold FPS with many on screen.
> **ANTI-PATTERN: One Draw Call Per Monster** — ❌ Don't render 100 monster meshes individually. ✅ Instance identical archetypes; keep draw calls <100. 💡 Draw calls are the FPS killer, not triangles.

### Step 4: Health, damage resolution & death
**What:** Central system that applies queued damage, handles death, and emits loot.
**File(s):** `apps/web/src/game/ecs/systems/healthSystem.ts`, `apps/web/src/game/ecs/systems/lootSystem.ts`, `apps/web/src/game/events.ts`
**Details:**
- `healthSystem`: subtract damage (skip if target in i-frames), clamp, on `current<=0` mark entity dead → remove from world → if `lootDropper`, push a `LootDropped` event.
- `events.ts`: a tiny typed event bus (or a queue drained each tick). `LootDropped { tableId, position }` is the seam Phase 3 will route to the server.
- Player death: on player HP 0, emit `PlayerDowned` → HUD shows a placeholder "hunt failed" state (real hunt lifecycle is Phase 5).

### Step 5: Animation state machine (Mixamo)
**What:** Drive character animations (idle/run/attack/dodge/hit/death) with crossfade blending.
**File(s):** `apps/web/src/game/animation/useCharacterAnimations.ts`, `apps/web/src/game/animation/animationStateMachine.ts`
**Details:**
- Use drei `useAnimations` → `AnimationMixer`; `animationStateMachine.ts` maps ECS state (moving? attacking? dead?) to a target clip and `crossFadeTo` transitions.
- **Standardize on one Mixamo-compatible skeleton** for all characters (overview Decision #12) so clips are shared without retargeting. For this phase, primitives can use a stubbed rig or a single free rigged placeholder (e.g. a Quaternius/KayKit character sharing one skeleton).
> **ANTI-PATTERN: Per-Character Retargeting** — ❌ Don't mix skeletons and retarget at runtime. ✅ One skeleton, shared clip set. 💡 Mixamo retargeting in three.js is buggy (inverted feet/hands) and a time sink.

### Step 6: Combat HUD + feedback
**What:** Health bar, hit feedback, monster health pips, damage numbers.
**File(s):** `apps/web/src/ui/CombatHUD.tsx`, `apps/web/src/game/fx/HitFlash.tsx`
**Details:** HUD reads player HP from the Zustand store (a bridge system copies ECS player HP → store at a throttled rate, e.g. 10Hz, **not** every frame). Hit feedback: brief material flash + optional screen shake + floating damage text via drei `<Html>` or an instanced text layer.
> **ANTI-PATTERN: Syncing ECS→React Every Frame** — ❌ Don't `setState` player HP each frame. ✅ Throttle the ECS→store bridge to ~10Hz. 💡 The HUD doesn't need 60Hz; React doesn't want it.

## State Management for This Phase

| State | Category | Location | Source of Truth | Persistence |
|-------|----------|----------|-----------------|-------------|
| Monster/projectile/player HP | game sim | ECS components | miniplex `world` | none |
| Attack/AI state | game sim | ECS components | `world` | none |
| Provisional dropped materials | game sim | ECS + `LootDropped` events | `world` | none (Phase 3 persists) |
| Player HP mirror (HUD) | shared UI | Zustand store | ECS (throttled copy) | none |

## Error Handling

| Operation | Failure Mode | User-Facing Behavior | Recovery Strategy |
|-----------|-------------|----------------------|-------------------|
| Animation clip missing | Named clip absent on model | Fallback to idle; console warn (not empty catch) | Clip lookup returns a safe default |
| Projectile leak | Projectile never despawns | Capped lifetime + max-projectile budget | Lifetime timer + pool ceiling |
| Monster count spike | Too many entities → FPS drop | Spawn cap + instancing | `spawnSystem` enforces a hard active-monster cap |

## Testing Requirements for This Phase

- [ ] `computeDamage` respects modifiers; `isInIFrames` gates damage during the dodge window.
- [ ] One melee swing damages each target at most once.
- [ ] Monster FSM transitions idle→chase→attack correctly given distance/cooldown.
- [ ] On monster death, exactly one `LootDropped` event fires with the right `tableId`.
- [ ] Player i-frames nullify incoming damage during the dodge window.

**Test type guidance:** Heavy unit coverage on pure combat logic (`combat.ts`, FSM transitions, damage resolution) — these are the correctness-critical, headless-testable pieces. Feel/animation is verified manually via the smoke test.

## Acceptance Criteria

- [ ] Player can kill all three monster archetypes with melee and ranged weapons.
- [ ] Dodging through an attack grants invulnerability (visible i-frames).
- [ ] Killing a monster spawns a visible material pickup (local only).
- [ ] 50+ monsters on screen hold ~60fps (instanced; draw calls <100 via r3f-perf).
- [ ] Animations crossfade cleanly (idle↔run↔attack↔hit↔death) with no T-pose flashes.
- [ ] Combat "feels" responsive: input→attack latency is low, hits register where expected.

**Verification commands:**
- `pnpm --filter web lint && pnpm --filter web typecheck && pnpm --filter web build`
- `pnpm --filter shared test` — combat/AI unit tests pass

**Smoke test:** Spawn a wave, kite the ranged spitter, dodge through a brute's slam (take no damage), melee-combo the chaser to death, and confirm a pickup drops. Watch the perf overlay stay near 60fps as the wave grows.

## Handoff to Next Phase

Combat is fun and self-contained client-side: two weapons, three monster archetypes with FSM AI, fair shapecast/sensor hit detection, a shared-skeleton animation state machine, health/death, and a `LootDropped` event seam. Materials are provisional (not persisted). Phase 3 builds the Supabase backend and makes the economy real: auth, the full schema, server-authoritative pull/upgrade/drop endpoints, ledger + idempotency, and cloud save. The `LootDropped` event becomes a server-validated `reportHuntResult` call (wired fully in Phase 5, but the endpoint and inventory land in Phase 3).

**Open questions for next phase:**
- Exact loot-table shape (weights, rarity) — define with `item_defs` in Phase 3.
- Whether provisional client drops should be shown optimistically then reconciled with server (recommended: yes, optimistic pickup UI, server is source of truth).
