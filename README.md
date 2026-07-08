# friendslop

A browser-based 3D action gacha roguelite. TypeScript · React 19 · React Three Fiber · Rapier · miniplex ECS · Vite.

See `feature-plans/friendslop/` for the full 8-phase plan.

## Status

- **Phase 1 — Foundation: ✅ playable.** Monorepo, R3F + Rapier + miniplex client, grey-box arena, third-person controller (WASD / jump / dodge with i-frames), ECS `SystemRunner`, Draco/KTX2-ready asset loader, React HUD split from the 3D scene.
- **Phase 2 — Combat slice: ✅ playable.** Melee (arc shapecast) + ranged (projectiles), 3 monster archetypes (chaser / spitter / brute) with an FSM AI, i-frame-aware damage, health/death, a `LootDropped` event seam → collectible material pickups, wave spawner with a monster cap, and a combat HUD (HP / wave / materials / hunt-failed). All entities are instanced (1 draw call each) — holds 60fps. Pure combat logic is unit-tested (`@shared/combat`, ECS systems).
- **Phase 6 — Asset pipeline: partially bootstrapped.** A test monster was generated via the Tripo MCP, optimized (5.95 MB → 169 KB), rigged + animated (idle/run), and recorded in `assets/asset-ledger.json`. Currently stands in as the player avatar.

## Layout

```
apps/web            Vite client (the game)
packages/shared     Framework-free types + balance constants (client<->server)
assets/             Raw sources, optimized models, preview renders, license ledger
scripts/            optimize-asset.sh (Phase 6 optimization)
feature-plans/      The phased implementation plan
```

## Develop

```bash
pnpm install
pnpm --filter web dev        # http://localhost:5173
pnpm --filter web typecheck
pnpm --filter web test       # movement/dodge unit tests
pnpm --filter web build
```

**Controls:** WASD move · Space jump · Shift dodge.

## Assets

Generate + optimize a model (requires the `tripo-ai` MCP for generation):

```bash
scripts/optimize-asset.sh assets/models/raw.glb apps/web/public/models/out.glb 1024
```

Every asset must have an `assets/asset-ledger.json` entry with a `commercial_ok` flag — the Phase 8 launch gate audits these. Free/Starter-tier Tripo output is prototype-only until re-sourced under a commercial license.
