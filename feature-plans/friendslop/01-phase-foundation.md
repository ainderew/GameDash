# Phase 1: Foundation — Project Scaffold, 3D World & Third-Person Controller

> **Feature:** friendslop — 3D web gacha roguelite
> **Phase:** 1 of 8
> **Depends on:** None
> **Estimated scope:** Large

## Context from Previous Phase

This is the first phase. No prior context. The project directory `/Users/marwinbong/projects/friendslop` is empty. Read `00-overview.md` for the full architecture and decisions log before starting.

## Objective

Stand up the monorepo, the client rendering stack (React Three Fiber + Rapier + miniplex), and a playable **grey-box world**: a low-poly capsule/placeholder character you can run, jump, and dodge around a flat arena with a third-person camera. No combat, no backend yet. The goal is "the engine works and moving feels good," because everything else renders inside this shell.

## Existing Codebase Context

None — greenfield. This phase establishes the conventions every later phase follows. Adhere to the user's global preferences: TypeScript strict, functional components with named exports, arrow functions for callbacks, function declarations for top-level, early returns, files under ~200 lines, `@/` path alias, Tailwind for 2D UI, 2-space indent / single quotes / trailing commas (Prettier owns formatting).

## Architecture Decisions

### Decision: Monorepo layout with a shared types package
- **Choice:** pnpm workspace with `apps/web` (Vite client), `apps/server` (Next.js — added Phase 3), and `packages/shared` (types, Zod schemas, game-balance constants shared client↔server).
- **Alternatives considered:** Single Next.js app hosting both client and 3D. Rejected: the 3D game wants Vite's HMR and a lean bundle; Next.js is best for the authoritative API. Splitting keeps concerns clean (DIP).
- **Rationale:** Clean Architecture — domain types live in `packages/shared` with no framework dependency; both apps depend on the abstraction.
- **Tradeoff:** Slightly more setup than a single app; worth it for the client/server authority boundary.

### Decision: ECS (miniplex) owns per-frame simulation; React owns UI
- **Choice:** A miniplex `World` holds entities (player, later monsters/projectiles). Systems run in a single `useFrame`. React state is used **only** for HUD/menus.
- **Rationale:** Decision #3 in overview. Prevents React reconciliation on the hot path.
- **Tradeoff:** Two mental models (declarative React + imperative systems). Documented clearly so it doesn't confuse implementers.

## Implementation Steps

### Step 1: Initialize the monorepo
**What:** Create a pnpm workspace with the client app and shared package.
**File(s):** `/pnpm-workspace.yaml`, `/package.json`, `/apps/web/`, `/packages/shared/`, root `/tsconfig.base.json`, `/.prettierrc`, `/.eslintrc.cjs`, `/.gitignore`.
**Details:**
- `pnpm-workspace.yaml` includes `apps/*` and `packages/*`.
- Scaffold `apps/web` with `pnpm create vite apps/web --template react-ts`.
- `tsconfig.base.json` sets `"strict": true`, `"noUncheckedIndexedAccess": true`, and the `@/*` → `apps/web/src/*` and `@shared/*` → `packages/shared/src/*` path aliases (also add the aliases to `apps/web/vite.config.ts` via `resolve.alias`).
- Run `git init` (repo is not yet a git repo).

### Step 2: Install the 3D + game stack
**What:** Add rendering, physics, ECS, and state libs to `apps/web`.
**File(s):** `apps/web/package.json`
**Details:** Install `three`, `@react-three/fiber@^9`, `@react-three/drei@^10`, `@react-three/rapier@^2`, `miniplex`, `three-mesh-bvh`, `zustand`, and dev deps `@types/three`, `leva`, `r3f-perf`. Pin versions after install and verify the R3F v9 / React 19 pairing (check npm for the current `three` r-number). Note: `@react-three/fiber@9` requires React 19.

### Step 3: Shared domain types + balance constants
**What:** Seed `packages/shared` with the types and tunable constants used everywhere.
**File(s):** `packages/shared/src/index.ts`, `packages/shared/src/types.ts`, `packages/shared/src/balance.ts`
**Details:**
- `types.ts`: `Vector3Tuple`, `EntityId`, `Rarity` (`'R3' | 'R4' | 'R5'`), `WeaponKind` (`'melee' | 'ranged'`), and placeholder `ItemDef`, `MonsterDef` interfaces (filled in Phase 3/5).
- `balance.ts`: exported consts for movement (`PLAYER_SPEED`, `DODGE_DISTANCE`, `DODGE_IFRAME_MS`, `JUMP_IMPULSE`, `GRAVITY`). Single source of truth for tuning — never hardcode these in components.
> **ANTI-PATTERN: Magic Numbers Scattered in Components** — ❌ Don't sprinkle `5.0` speed values across files. ✅ Import from `@shared/balance`. 💡 Balance tuning must be one-file, one-place.

### Step 4: The R3F canvas shell + render pipeline
**What:** Create the game canvas with renderer, physics world, lighting, and perf overlay.
**File(s):** `apps/web/src/game/GameCanvas.tsx`, `apps/web/src/game/world/Lighting.tsx`
**Details:**
- `GameCanvas` renders `<Canvas>` with `dpr={[1, 1.5]}`, `shadows`, `gl={{ powerPreference: 'high-performance' }}`. Wrap contents in `<Suspense>` and `<Physics>` (from `@react-three/rapier`).
- Add `<Perf />` (r3f-perf) gated behind a dev flag.
- `Lighting.tsx`: one directional (sun) + hemisphere light. Keep dynamic lights minimal — low-poly is CPU/draw-call bound, not fill bound.
> **ANTI-PATTERN: Premature Client Boundary Sprawl** — ❌ Don't put game logic in React state/effects. ✅ Game logic lives in ECS systems (Step 7); React components declare scene structure. 💡 See overview Decision #3.

### Step 5: Grey-box arena
**What:** A flat ground plane with a few static obstacles as collision/nav reference.
**File(s):** `apps/web/src/game/world/GreyboxArena.tsx`
**Details:** A large `RigidBody type="fixed"` ground `<CuboidCollider>` + a handful of box obstacles. Use `MeshStandardMaterial` with flat colors. This is the placeholder zone until Phase 5.

### Step 6: Third-person character controller
**What:** A player capsule with kinematic movement, dodge, jump, and a follow camera.
**File(s):** `apps/web/src/game/entities/Player.tsx`, `apps/web/src/game/input/useInput.ts`, `apps/web/src/game/camera/ThirdPersonCamera.tsx`
**Details:**
- Use **ecctrl** (or Rapier's kinematic character controller directly) for physics-driven third-person movement. Reference: `https://github.com/pmndrs/ecctrl`.
- `useInput.ts`: keyboard (WASD, Space=jump, Shift=dodge) via drei `<KeyboardControls>` + pointer for aim direction. Returns a stable input snapshot read in `useFrame` (refs, not React state).
- Dodge: a short dashed impulse over `DODGE_DISTANCE` granting i-frames for `DODGE_IFRAME_MS` (i-frame flag consumed by combat in Phase 2).
- `ThirdPersonCamera`: follow camera with collision-aware distance (raycast from player to desired camera pos, pull in on obstruction). Smooth with damping.
> **ANTI-PATTERN: Reading Input via React State** — ❌ Don't `useState` per keypress and re-render. ✅ Mutate an input ref; read it in the frame loop. 💡 Per-frame React updates tank FPS.

### Step 7: miniplex ECS skeleton
**What:** The ECS world and a movement system, wired into one `useFrame`.
**File(s):** `apps/web/src/game/ecs/world.ts`, `apps/web/src/game/ecs/components.ts`, `apps/web/src/game/ecs/systems/movementSystem.ts`, `apps/web/src/game/ecs/SystemRunner.tsx`
**Details:**
- `components.ts`: component types — `transform`, `velocity`, `playerControlled`, `health` (unused until Phase 2), `iframeUntil`.
- `world.ts`: `export const world = new World<Entity>()` with the `Entity` union type.
- `SystemRunner.tsx`: a component rendered inside `<Canvas>` whose single `useFrame((_, dt) => { movementSystem(world, dt); /* future systems */ })` ticks all systems in fixed order.
> **ANTI-PATTERN: Multiple useFrame Loops Fighting for Order** — ❌ Don't scatter `useFrame` across entity components. ✅ One `SystemRunner` ticks systems in explicit order. 💡 Deterministic system order prevents 1-frame-lag bugs.

### Step 8: Asset-loader utility (skeleton)
**What:** Central GLTF loader wired for Draco + KTX2 + meshopt, ready for Phase 6 assets.
**File(s):** `apps/web/src/lib/loaders.ts`
**Details:** Configure `DRACOLoader`, `KTX2Loader`, and `MeshoptDecoder` once and export helpers; expose a typed `useGameModel(path)` wrapper over drei `useGLTF`. For now it loads simple placeholder GLBs (or primitives). Full pipeline lands in Phase 6.

### Step 9: HUD shell (React, outside Canvas)
**What:** A minimal Tailwind HUD overlay proving the React-UI / 3D-scene split.
**File(s):** `apps/web/src/ui/HUD.tsx`, `apps/web/src/App.tsx`, `apps/web/src/ui/store.ts`
**Details:** `store.ts` is a Zustand store for UI/meta state (health bar value, menu open). `HUD` renders absolutely-positioned Tailwind elements *outside* `<Canvas>`. `App.tsx` composes `<GameCanvas />` + `<HUD />`.

## State Management for This Phase

| State | Category | Location | Source of Truth | Persistence |
|-------|----------|----------|-----------------|-------------|
| Player transform/velocity | game sim | ECS component (refs) | miniplex `world` | none (recreated each session) |
| Input snapshot | ephemeral | input ref | `useInput` ref | none |
| Camera state | ephemeral | camera refs | camera component | none |
| HUD values (health, menu) | shared UI | Zustand `store.ts` | Zustand | none this phase (cloud save = Phase 3) |

## Error Handling

| Operation | Failure Mode | User-Facing Behavior | Recovery Strategy |
|-----------|-------------|----------------------|-------------------|
| Asset/model load | GLB missing / decode fail | Suspense fallback → error boundary with reload | R3F `<Suspense>` + an error boundary around `<Canvas>` contents |
| WebGL/WebGPU init | Unsupported/blocked GPU | Friendly "enable hardware acceleration" message | Detect context-creation failure; render a fallback DOM screen |

## Testing Requirements for This Phase

- [ ] Movement system: given input + dt, player transform advances by expected delta (unit test on `movementSystem`, no renderer).
- [ ] Dodge sets `iframeUntil` for the configured duration and applies the dash.
- [ ] Balance constants are imported, not duplicated (grep check).
- [ ] Camera pulls in when an obstacle is between camera and player.

**Test type guidance:** Unit-test pure ECS systems and math (miniplex worlds are plain objects — easy to test headless). Defer rendering/E2E smoke to Playwright in Phase 8; a manual smoke test suffices now.

## Acceptance Criteria

- [ ] `pnpm --filter web dev` serves a page rendering the grey-box arena.
- [ ] Player capsule moves with WASD, jumps, and dodges with a visible dash + i-frame window.
- [ ] Third-person camera follows and de-occludes against obstacles.
- [ ] Runs at 60fps on a mid laptop (check r3f-perf overlay).
- [ ] HUD renders as a DOM overlay, not inside the WebGL canvas.
- [ ] No per-frame React re-renders during movement (verify with React DevTools profiler — no re-render storm).

**Verification commands:**
- `pnpm --filter web lint` — passes
- `pnpm --filter web typecheck` (`tsc --noEmit`) — passes with strict
- `pnpm --filter web build` — builds
- `pnpm --filter shared test` — movement/dodge unit tests pass

**Smoke test:** Run the dev server, hold W to run forward, tap Space to jump, tap Shift while moving to dodge-dash. The camera should trail smoothly and not clip through the box obstacles.

## Handoff to Next Phase

Foundation is live: monorepo, R3F+Rapier+miniplex client, grey-box arena, a good-feeling third-person controller with dodge/i-frames, an ECS `SystemRunner`, a Draco/KTX2-ready asset loader, and a React HUD split cleanly from the 3D scene. `packages/shared` holds types + `balance.ts`. Phase 2 adds combat inside this shell: weapons, monsters, AI, hit detection, animation state machine, and material drops.

**Open questions for next phase:**
- Hit detection approach (shapecast vs sensor colliders) — recommended default: shapecast + `three-mesh-bvh` for melee arcs, sensor colliders for projectiles. Decide in Phase 2.
- Whether to bring in real character art now or stay grey-box — recommended: stay grey-box/primitive through Phase 2; real assets in Phase 6.
