# Phase 1 — Headless Sim Core (`@friendslop/sim`)

> **Goal:** the entire gameplay simulation runs with zero DOM/three/React imports, per-instance (no singletons), on a fixed timestep, for N players — so the identical code can tick inside a Node room server. **Single-player behavior must be unchanged** at the end of this phase.
>
> **Depends on:** nothing. **Blocks:** everything else.

## Why first

De-sync is minimized *by construction* when server and client run the same functions. Every divergence between "what the server simulates" and "what the client predicts/renders" becomes rubber-banding later — this phase is where smoothness is actually won.

## Tasks

### Task 1: Create `packages/sim` workspace
- **Files:** `packages/sim/package.json` (`@friendslop/sim`, `type: module`, deps: `miniplex`, `@friendslop/shared`), `tsconfig.json` extending `tsconfig.base.json`, `vitest.config.ts`.
- Mirror the `@friendslop/shared` conventions (subpath exports if useful). Add `@sim/*` alias in `apps/web/vite.config`/tsconfig paths.
- **Hard rule (enforce with an eslint `no-restricted-imports` rule in this package):** no `three`, no `react`, no `@react-three/*`, no DOM globals.

### Task 2: Move the ECS core
- **Move into `packages/sim/src/`:**
  - `apps/web/src/game/ecs/components.ts` → `sim/src/components.ts`. Break the one client import: `HitStrength` currently comes from `@/game/feel/config` (components.ts:4) — move the `HitStrength` type into `packages/shared/src/combat.ts` (it's a combat classification, not a feel value) and re-point both.
  - `apps/web/src/game/ecs/world.ts` → replace the module-singleton `world` with a factory: `createGameWorld(): World<Entity>` + the query helpers taking a world argument. The client keeps a singleton *instance* (created once in `GameCanvas`); the server creates one per room. Keep `window.__world` assignment in client code only.
  - `apps/web/src/game/events.ts` → `sim/src/events.ts`, converted from module-level queue to a per-world `EventQueue` instance (the server needs isolated queues per room). It already imports only `@shared/types`.
  - `apps/web/src/game/world/terrainHeight.ts` (zero imports) and the collision half of `hubLayout.ts` (`resolveHubCollisions`, footprint data — hubLayout.ts:93) → `sim/src/terrain/`. The *visual* hub layout usage stays in `apps/web` importing from sim.

### Task 3: Move systems behind a feel-hooks seam
- **Move all of `apps/web/src/game/ecs/systems/` into `sim/src/systems/`** along with their tests (`movementSystem.test.ts`, `relicSystem.test.ts`, plus `combat/passTargeting.ts` + test — pass math is sim, pass *input* handling is not).
- Invert the client-only tendrils into an injected **`SimHooks`** interface (default no-op on server):
  - `combatHelpers.ts:5-6` → `feel/config`, `feel/onHit` (`onHitLanded`, `onParry`) → `hooks.onHitLanded(ctx)`.
  - `relicSystem.ts:4-6` → `spawnImpactVfx`, `addTrauma`, `requestHitstop` → `hooks.onRelicCaught(...)` etc.
  - `weaponSystem.ts:12` `playWhoosh` → `hooks.onSwing(...)`; `knockbackSystem.ts`/`separationSystem.ts` read tuning from `feel/config` → move those *constants* to `@shared/balance` (they're balance, not juice).
  - Feel *constants* used inside sim math (e.g. knockback decay) move to shared; feel *side effects* (audio/VFX/shake/hitstop) become hooks. Floating damage numbers become a hook/event consumer on the client, not sim entities created inside `dealDamage`.
- `weaponSystem.ts:16` imports `three.Vector3` + `weaponSockets` (animated blade socket refinement). Split: **arc hit math (pure) lives in sim** and is what the server will trust; the socket-based refinement becomes a client-provided `hooks.refineMeleeHit?` used only in local play. (Phase 4 revisits validation tolerance.)

### Task 4: Fixed-timestep driver
- **File:** `sim/src/loop.ts` — `createSimStepper({ hz: 30 })` with an accumulator: consumes real dt, runs 0..n fixed `step(world, dtFixed, nowMs)` calls, exposes `alpha` (remainder fraction) for render interpolation.
- Extract the system run order out of `SystemRunner.tsx:113-207` into `sim/src/step.ts`: `stepSim(world, events, input: PerPlayerIntents, dt, now, mode: 'hub'|'expedition', hooks)` — the *one* function both client and server call. `SystemRunner.tsx` becomes a thin adapter: gathers local input, calls the stepper, keeps the HUD bridge and feel bits.
- Hitstop integration changes: `advanceTime`/`requestHitstop` (`feel/time.ts`) must no longer scale the dt fed to `stepSim` (that would freeze a shared world). Local hitstop moves to the presentation layer (animation mixers, camera, FX aging) — in this phase, single-player can keep sim-freezing behavior behind a `localOnly` flag so nothing feels different yet; Phase 4 flips multiplayer to presentation-only.

### Task 5: Generalize to N players
- Kill every `players.first` / single-player assumption:
  - `aiSystem.ts:17` — target selection becomes nearest-living-player (already per-monster, trivial change).
  - `relicSystem.ts:134`, `teammateSystem.ts:29`, pass targeting (`passTargeting.ts` candidate scoring already handles teammates — extend to any `playerControlled | remotePlayer` entity).
  - `SystemRunner` HUD bridge and `Player.tsx:148` stay local-player-specific by *selecting* the locally-owned entity (`entity.localPlayer === true`, new component) instead of `.first`.
- Add stable **numeric entity ids** (`entity.id: number`, per-world counter) — miniplex object refs can't cross the wire. Add `ownerId?: PlayerId` for player-controlled entities.
- `applyPlayerIntent(player, intent, now)` already takes the entity — confirm no hidden module state (input buffering fields live on the entity — good).

### Task 6: Regression guard
- All moved vitest suites pass from `packages/sim`.
- New test: **headless smoke sim** — create world, add 2 players + wave 1, run 30 s of fixed ticks with scripted intents in plain Node, assert: no NaN transforms, monsters die to scripted melee, relic pass→catch works between the two players. This test IS the proof the server can run the game.
- Manual: full single-player run (hub → gate → 3 waves → relic passes with AI teammates) — feel unchanged.

## Acceptance criteria
- `pnpm --filter @friendslop/sim test` green in plain Node (no jsdom).
- `apps/web` builds; single-player plays identically (hitstop, combos, relic feel intact).
- Zero `three`/`react` imports under `packages/sim` (lint-enforced).
- Two-player headless smoke test passes.

## Risks
- **Hidden module-singletons** (pass aim state `combat/passAim.ts`, weapon store) leaking into sim — audit each; input/aim state is client, its *outputs* (intents) are sim inputs.
- **Behavior drift during extraction** — move files with `git mv` history, no logic edits except the seams listed; any tuning-constant relocation must be value-identical.
