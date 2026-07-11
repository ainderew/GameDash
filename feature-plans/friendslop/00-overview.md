# Feature Plan: friendslop — 3D Web Gacha Roguelite

> **Created:** 2026-07-08
> **Phases:** 8 (+ this overview)
> **Stack:** TypeScript (strict) · React 19 · React Three Fiber + Three.js · Rapier physics · miniplex ECS · Vite · Next.js (server actions) · Supabase (Postgres) · Vercel
> **Status:** Planning

## Codebase Context

- **Project structure:** Greenfield. `/Users/marwinbong/projects/friendslop` is empty. No existing conventions to honor — this plan defines them.
- **Existing patterns:** None. Structure is proposed below and locked in Phase 1.
- **Related code:** None.
- **Testing setup:** None yet. Vitest (unit/logic) + Playwright (E2E smoke) proposed; economy logic gets the heaviest coverage.
- **Styling approach:** Tailwind CSS for 2D HUD/menus (per user's global preferences). 3D is R3F, not CSS.

## Feature Summary

friendslop is a browser-based 3D action game. A player drops into a **hunting zone**, fights monsters in **third-person real-time combat** (WASD + aim/dodge), and collects **material drops**. Materials feed a persistent **base upgrade tree** and **weapon upgrades**; a **gacha** system (server-authoritative, earned currency) grants new characters/weapons/gear. Progressively harder zones gate better materials, forming a **roguelite loop**: hunt → drop → upgrade → unlock harder zone → repeat. Progress is cloud-saved, and an **async social** layer (leaderboards, read-only base showcases) lets friends compare without real-time multiplayer.

## Guiding Principle (read this first)

> **Commercial-ready architecture, prototype-grade content.**
> The user intends to monetize eventually but is prototyping with free assets and a free-tier asset pipeline. Therefore: build the *economy and data layer* to commercial standard from day one (server-authoritative, auditable, tamper-proof), but populate with **disposable placeholder assets** tracked in a license ledger. A **hard gate** (Phase 8) blocks any real-money launch until every shipped asset is CC0 or owned under a paid tier, and odds/compliance are in place. Do **not** wire real payments until the loop is proven fun.

## Architecture Overview

```
┌────────────────────────── BROWSER (Vite bundle) ──────────────────────────┐
│  React 19 UI (Tailwind)          React Three Fiber <Canvas>                │
│  ├─ HUD / menus / gacha screen   ├─ Renderer (WebGPU→WebGL2 fallback)      │
│  ├─ inventory / base / shop      ├─ Rapier physics world                   │
│  └─ leaderboards / social        └─ miniplex ECS (movement, AI, combat,    │
│         │  (React state = UI only)      spawning) driven in useFrame       │
│         │                                    │                             │
│         │  intent only (never outcomes)      │ per-frame sim (refs, no     │
│         ▼                                     │ React re-render)           │
└─────────┼─────────────────────────────────────────────────────────────────┘
          │  HTTPS (fetch / server actions)
          ▼
┌────────────────────── SERVER (Next.js on Vercel) ─────────────────────────┐
│  Server Actions / Route Handlers (thin controllers)                        │
│     └─ Services (business logic) ── Repositories ── Supabase Postgres       │
│  SERVER OWNS: RNG, pull outcomes, drops, balances, pity, upgrades.          │
│  Every mutation = one SERIALIZABLE txn + idempotency key + ledger row.      │
└────────────────────────────────────────────────────────────────────────────┘
          ▼
   Supabase: Postgres (economy = source of truth) · Auth · Storage (asset CDN)
```

**Core rule:** the browser is hostile. The client sends *intent* ("pull banner X", "upgrade weapon Y", "I finished hunt Z"); the server computes and returns *outcomes*. The client only animates what the server decided. This single rule eliminates currency dupes, item injection, and forced-roll exploits — see Phase 3.

## Decisions Log

| # | Decision | Choice | Rationale | Date |
|---|----------|--------|-----------|------|
| 1 | Renderer | Three.js via React Three Fiber | Only engine with native React integration; largest ecosystem; ideal for low-poly. Matches betrayal.io *look*, not its (likely Unity/WASM) engine. | 2026-07-08 |
| 2 | Physics | Rapier (`react-three-rapier`) | Rust/WASM, fastest in 2026, deterministic, built-in kinematic character controller. | 2026-07-08 |
| 3 | Game-loop architecture | miniplex ECS in `useFrame`; React for UI only | React reconciliation is wrong for 100+ monsters mutating per frame. Keep the hot path out of React. | 2026-07-08 |
| 4 | Multiplayer model | ~~Solo + cloud save + **async social**~~ **SUPERSEDED** → real-time shared-world co-op | Real-time MP is now in scope and built: server-authoritative rooms with client prediction + snapshot interpolation, deployed on the VPS. See **`feature-plans/multiplayer/`** (its Decision #4 and the 6-phase plan) for the netcode counterpart. The async-social layer remains a possible future add, not the multiplayer answer. | ~~2026-07-08~~ · superseded 2026-07-12 |
| 5 | Combat style | Third-person real-time action | User choice; closest to the betrayal.io reference. Highest game-feel risk → gets a dedicated slice phase. | 2026-07-08 |
| 6 | Backend | Next.js server actions + Supabase Postgres + Vercel | Cheap, scales to zero, ACID transactions for the economy, auth+DB+storage in one. | 2026-07-08 |
| 7 | Economy authority | Fully server-authoritative + append-only ledger + idempotency | Commercial intent; anti-cheat is non-negotiable for a gacha economy. | 2026-07-08 |
| 8 | Base building | Data-driven **upgrade tree** (facilities w/ levels), NOT spatial placement | Spatial base-builder is a huge separate system; defer. | 2026-07-08 |
| 9 | Zones | Hand-authored grey-box arenas + procedural **spawn/modifier** composition | Procedural 3D geometry is out of scope for MVP. | 2026-07-08 |
| 10 | Asset pipeline | Tripo free-tier MCP for test assets → paid Tripo/Meshy Pro **or** self-hosted Hunyuan3D before launch | Free tier (Tripo API works free; Meshy API is Pro-only) is fine for local playtesting; not for shipping (non-commercial license). | 2026-07-08 |
| 11 | Monetization sequencing | Architect for real money now; integrate Stripe LAST | Don't monetize an unfun game; keep regulatory surface closed until proven. | 2026-07-08 |
| 12 | Shared skeleton | One Mixamo-compatible skeleton across all characters | Avoids the retargeting-hell that plagues Mixamo rigs in three.js. | 2026-07-08 |

## Data Model (canonical — full detail in Phase 3)

**Config tables (mostly static, versioned):** `item_defs`, `currencies`, `banners`, `banner_pool_items`, `rarity_tiers`, `zones`, `monster_defs`, `loot_tables`, `facility_defs`, `weapon_upgrade_defs`.

**Per-player, server-authoritative (source of truth):** `players`, `player_save_state`, `player_wallets` (`balance CHECK >= 0`), `inventory_items` (`level`, `refinement`), `player_pity`, `player_facilities`, `player_weapon_levels`.

**Immutable audit / integrity:** `currency_ledger` (append-only, every balance change), `pull_history` (every gacha roll + seed + pity-at-pull), `idempotency_keys`.

**Social:** `friendships`, `leaderboard_entries` (server-validated scores), base-showcase snapshot derived from `player_facilities`.

> **ANTI-PATTERN: Storing Derived Data** — ❌ Don't store `balance` only inside a JSONB save blob. ✅ Balances are real columns with `CHECK` constraints; the ledger reconstructs them. 💡 JSONB can't enforce non-negative money or keep column stats.

## API Surface (server-authoritative; full signatures in Phase 3–5)

| Method | Action | Purpose | Auth |
|--------|--------|---------|------|
| action | `pullBanner({ bannerId, count, idempotencyKey })` | Gacha pull — server rolls, deducts, grants | yes |
| action | `upgradeWeapon({ weaponInstanceId, idempotencyKey })` | Spend materials, raise weapon level | yes |
| action | `upgradeFacility({ facilityId, idempotencyKey })` | Spend materials, raise base facility level | yes |
| action | `startHunt({ zoneId, loadout })` | Open a server-tracked hunt session, seed spawns | yes |
| action | `reportHuntResult({ huntId, events, idempotencyKey })` | Server validates & credits drops | yes |
| action | `syncSave()` / `loadSave()` | Non-authoritative client state (settings, cosmetics) | yes |
| GET | `getBanner(id)` / `getOdds(id)` | Public banner config + **published odds** | no |
| GET | `getLeaderboard(id)` / `getFriends()` / `getBaseShowcase(playerId)` | Social reads | yes |

## Phase Index

| Phase | File | Focus | Key Deliverables |
|-------|------|-------|-----------------|
| 0 | `00-overview.md` | This document | Architecture, data model, decisions |
| 1 | `01-phase-foundation.md` | Foundation | Monorepo, R3F canvas, third-person controller, grey-box world, ECS + asset-loader skeleton |
| 2 | `02-phase-combat-slice.md` | Combat feel | Weapons, monster AI, hit detection, animation state machine, drops |
| 3 | `03-phase-backend-economy.md` | Backend | Supabase schema, auth, server-authoritative economy, ledger, idempotency, cloud save |
| 4 | `04-phase-gacha-upgrades.md` | Meta loop | Gacha (pity/50-50/10-pull), weapon + base upgrade trees, published odds page |
| 5 | `05-phase-roguelite-loop.md` | Progression | Zones, hunt/run structure, server-validated loot tables, escalation |
| 6 | `06-phase-asset-pipeline.md` | Assets | Tripo free MCP workflow, gltf-transform optimization, license ledger, paid/self-host upgrade path |
| 7 | `07-phase-async-social.md` | Social | Friends, server-validated leaderboards, read-only base showcase |
| 8 | `08-phase-polish-launch.md` | Ship-ready | Perf pass, hardening, **commercial launch gate** (asset audit, odds, region rules, Stripe) |

**Sequencing note:** Phases 1–2 prove combat is fun *before* any backend. Phase 3 makes it persistent and tamper-proof. Phases 4–5 close the meta loop. Phase 6 can start in parallel once Phase 2's asset-loader exists. Phases 7–8 add social and the launch gate. Each phase is a shippable increment.

## Out of Scope (MVP)

- Real-time multiplayer / co-op (loop is single-player; async social only).
- Spatial/free-form base building (data-driven upgrade tree instead).
- Procedurally-generated 3D level geometry (hand-authored arenas + procedural spawns).
- Real-money payments / Stripe (architected for, integrated in Phase 8 only, behind the launch gate).
- Player-to-player trading or gifting of premium items (RMT/loot-box legal risk — deferred, and only ever non-tradeable if added).
- Mobile-native apps (responsive web only).

## Open Questions

- 🟡 **Run/death economy:** default is "keep materials collected during a failed hunt." Harsher extraction-risk modes are a Phase 5 tuning dial, not a blocker.
- 🟡 **Character vs weapon-centric gacha:** default pools include both characters (playable) and weapons/gear. Confirm the ratio during Phase 4 content design.
- 🟢 **Art direction specifics** (palette, monster theme): decided during Phase 6 asset generation; doesn't block systems work.
- 🟢 **Self-host Hunyuan3D:** viable only if a team member has an RTX 3060+/16GB GPU; otherwise paid Pro tier is the commercial path. Revisit at Phase 6.
