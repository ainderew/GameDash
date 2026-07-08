# Phase 6: Asset Pipeline — Tripo MCP, Optimization & License Ledger

> **Feature:** friendslop — 3D web gacha roguelite
> **Phase:** 6 of 8
> **Depends on:** `01-phase-foundation.md` (asset loader), `05-phase-roguelite-loop.md` (content to dress)
> **Estimated scope:** Medium–Large

## Context from Previous Phase

The full game loop is playable with grey-box/primitive art. Phase 1 shipped `apps/web/src/lib/loaders.ts` — a GLTFLoader wired for Draco + KTX2 + meshopt. Phase 2 established a **single shared Mixamo-compatible skeleton** for all characters. Phase 5 defined zones/monsters/loot as data. This phase builds the repeatable pipeline that turns concepts into optimized, in-game GLB assets — and the **license discipline** that keeps a commercial launch legal.

**Relevant existing files:**
- `apps/web/src/lib/loaders.ts` — the loader all assets flow through.
- `apps/web/src/game/animation/animationStateMachine.ts` — expects the shared skeleton + named clips.
- `packages/shared/src/content/{zones,monsters}.ts` — assets map to these defs by id.

## Objective

Establish an end-to-end asset pipeline: **generate** (Tripo free-tier MCP now; paid Tripo/Meshy Pro or self-hosted Hunyuan3D later) → **optimize** (`gltf-transform`: decimate, atlas, Draco + KTX2) → **rig/animate** (shared skeleton) → **import** (GLB via the Phase 1 loader). Crucially, every asset is recorded in a **license ledger** with a hard pre-monetization gate: nothing ships commercially unless it is CC0 or owned under a paid tier / commercially-licensed self-host.

## Architecture Decisions

### Decision: Tripo free-tier MCP for prototype assets; commercial regeneration gated
- **Choice:** Use the already-installed `tripo-ai` MCP (`TRIPO_API_SECRET`, free tier ~200–300 credits/mo) to generate throwaway test assets for local playtesting. Track each in a license ledger. Before any real-money launch (Phase 8 gate), every shipped asset must be re-sourced as CC0, regenerated under **paid Tripo/Meshy Pro** (which grants ownership), or produced via **self-hosted Hunyuan3D-2.1** (commercial license permitted).
- **Rationale:** Overview Decision #10 + the guiding principle. Free-tier Tripo output is non-commercial/CC-BY and inputs/outputs are retained broadly — fine for local team testing (not distribution), illegal to sell.
- **Tradeoff:** Prototype assets are disposable; you "pay to make it sellable" later. Explicitly accepted by the user.

### Decision: Note on Meshy — its MCP needs a paid plan
- **Choice:** Meshy's API/MCP requires Pro ($20/mo); the free tier is web-UI only. So Meshy enters the pipeline only at the commercial-regeneration stage (where its free rigging/animation shine). For free prototyping, Tripo is the automated path.
- **Rationale:** Verified 2026 pricing. Don't attempt to wire Meshy MCP on the free tier — it has no API key.

## Implementation Steps

### Step 1: Asset directory + license ledger
**What:** A place for raw + optimized assets and a machine-readable license record.
**File(s):** `apps/web/src/assets/raw/`, `apps/web/public/models/`, `apps/web/public/textures/`, `assets/LICENSES.md`, `assets/asset-ledger.json`
**Details:**
- `asset-ledger.json`: one entry per asset — `{ id, file, source ('tripo-free'|'tripo-pro'|'meshy-pro'|'hunyuan3d'|'cc0-pack'|'commissioned'), license, commercial_ok: boolean, prompt/seed, created_at, maps_to (monster/weapon/facility def id) }`.
- `LICENSES.md`: human-readable attribution list for any CC-BY/CC0 packs used.
> **ANTI-PATTERN: Untracked Asset Provenance** — ❌ Don't drop GLBs in with no license record. ✅ Every asset gets a ledger entry with `commercial_ok`. 💡 At launch you must prove every asset is legal to sell; an untracked asset blocks the gate.

### Step 2: Generation workflow via Tripo MCP (free)
**What:** A documented, repeatable generate step using the installed MCP.
**File(s):** `docs/asset-pipeline.md`, `scripts/generate-asset.md` (runbook)
**Details:** In a Claude Code session with the `tripo-ai` MCP live:
1. `text_to_3d` (or `image_to_3d` from concept art) with a low-poly prompt; request quad topology + a `face_limit` (e.g. 5k–20k for creatures).
2. `rig_model` + `retarget_animation` for biped creatures (or share the standard skeleton).
3. `convert_model` → **GLB**.
4. Add a ledger entry (`source: 'tripo-free'`, `commercial_ok: false`).
- Also document the **manual/no-MCP fallback** (Tripo/Meshy web UI free tier) for anyone without the MCP.
- Document the **self-hosted Hunyuan3D-2.1** path for a teammate with an RTX 3060+/16GB GPU — the only free *and* commercially-usable option.

### Step 3: Optimization pipeline (`gltf-transform`)
**What:** One command to make any raw GLB game-ready.
**File(s):** `scripts/optimize-asset.sh`, `apps/web/package.json` (script), `docs/asset-pipeline.md`
**Details:**
- `gltf-transform optimize <raw>.glb <out>.glb --compress draco --texture-compress ktx2` plus dedupe/weld/prune/resize; target a per-asset tri budget appropriate to instancing.
- Bake character sets to a shared texture atlas (single material → fewer draw calls). Use **meshopt** (not Draco) for any animated/morph meshes.
- Optionally run `gltfjsx --types` to generate typed R3F components for complex props.
> **ANTI-PATTERN: Shipping Raw Generator Output** — ❌ Don't load 300k-tri, 4K-texture raw AI meshes. ✅ Always decimate + compress through `gltf-transform`. 💡 Raw output tanks browser load time and FPS.

### Step 4: Skeleton standardization + animation binding
**What:** Ensure all characters share one skeleton and the Phase 2 clip set.
**File(s):** `apps/web/src/game/animation/skeleton.ts`, `docs/asset-pipeline.md`
**Details:** Retarget/generate every character onto the single canonical skeleton (overview Decision #12) so idle/run/attack/hit/death clips are shared. Document the exact bone naming the animation state machine expects. Reject assets that don't conform (don't runtime-retarget).

### Step 5: Wire real assets to content defs
**What:** Replace primitives with optimized GLBs by def id.
**File(s):** `apps/web/src/game/entities/{Monster,Player,Projectile}.tsx` (swap placeholder → `useGameModel`), `packages/shared/src/content/monsters.ts` (add `modelPath`)
**Details:** Each `monster_def`/weapon/facility references an optimized GLB path. Keep instancing for monsters (drei `<Instances>` from the loaded geometry). Verify draw-call budget still holds with real meshes.

### Step 6: Asset load performance pass
**What:** Keep first-load fast despite real assets.
**File(s):** `apps/web/src/lib/preload.ts`, `apps/web/src/game/GameCanvas.tsx`
**Details:** Preload critical assets behind the loading screen; lazy-load zone-specific assets on zone entry; use drei `<Detailed>` (LOD) for distant monsters. Confirm KTX2 textures stay GPU-compressed.

## State Management for This Phase

| State | Category | Location | Source of Truth | Persistence |
|-------|----------|----------|-----------------|-------------|
| Asset files | static | `public/models`, `public/textures` | repo/Supabase Storage CDN | durable |
| License ledger | config | `assets/asset-ledger.json` | repo | durable |
| Loaded GLB cache | cache | drei `useGLTF` cache | client | session |

## Error Handling

| Operation | Failure Mode | User-Facing Behavior | Recovery Strategy |
|-----------|-------------|----------------------|-------------------|
| Asset load | Missing/oversized GLB | Fallback to primitive placeholder | Loader falls back; log which def lacks art |
| Animation | Non-conforming skeleton | Character uses idle only + warn | Reject at build; conformance check script |
| Generation | Tripo credits exhausted | Manual note; switch to CC0/self-host | Ledger shows source; no runtime impact |

## Testing Requirements for This Phase

- [ ] Optimized GLBs load through `loaders.ts` with Draco + KTX2 decoding.
- [ ] A conformance check fails any character not on the shared skeleton.
- [ ] Every file in `public/models` has an `asset-ledger.json` entry.
- [ ] Draw-call budget (<100) holds with real instanced monster meshes.
- [ ] First-load time stays within budget with critical-asset preloading.

**Test type guidance:** Mostly manual/visual verification plus a small script test for the license-ledger completeness check and skeleton conformance (these become the Phase 8 gate inputs). No heavy unit testing here.

## Acceptance Criteria

- [ ] A documented, repeatable generate → optimize → import pipeline exists (`docs/asset-pipeline.md`).
- [ ] At least one zone's monsters/weapons use real optimized low-poly GLBs via the Tripo MCP.
- [ ] All characters share one skeleton and reuse the Phase 2 animation clips.
- [ ] `asset-ledger.json` covers every shipped asset with a `commercial_ok` flag.
- [ ] Performance (60fps, draw calls, load time) holds with real assets.
- [ ] The commercial-regeneration path (paid Pro / Hunyuan3D) is documented for the Phase 8 gate.

**Verification commands:**
- `pnpm --filter web run assets:check` — license-ledger + skeleton conformance script passes
- `pnpm --filter web build` — builds with real assets
- Manual: run the game, confirm real monsters render and animate at 60fps

**Smoke test:** Generate a monster via the Tripo MCP, run it through `optimize-asset.sh`, map it to a `monster_def`, launch a hunt, and see it spawn, animate (idle/chase/attack/death), and drop loot — all at 60fps.

## Handoff to Next Phase

A repeatable, license-tracked asset pipeline is in place: Tripo free MCP → `gltf-transform` → shared-skeleton GLBs in-game, with a ledger and a documented commercial-regeneration path. The game now looks like a game. Phase 7 adds the async social layer (friends, server-validated leaderboards, read-only base showcases) — the "friendslop" hook. Phase 8 does the perf/hardening pass and the commercial launch gate, where the asset ledger's `commercial_ok` flags are audited and any `false` entries are regenerated/replaced.

**Open questions for next phase:**
- Whether to serve assets from repo `public/` or Supabase Storage CDN (recommended: CDN for cache/versioning once asset count grows).
- Art direction lock (palette/theme) — decide before mass-generating to keep a cohesive look.
