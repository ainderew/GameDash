# Phase 4: Gacha & Upgrade Trees — Pity, Banners, Published Odds

> **Feature:** friendslop — 3D web gacha roguelite
> **Phase:** 4 of 8
> **Depends on:** `03-phase-backend-economy.md`
> **Estimated scope:** Large

## Context from Previous Phase

Phase 3 delivered accounts and a tamper-proof economy: Supabase Postgres schema, auth, repository/service layers, and the reusable `runEconomyTx` primitive (SERIALIZABLE transaction + idempotency key + append-only `currency_ledger` + server CSPRNG). Currency spend, item grants, weapon/facility upgrades, and cloud save all work end-to-end and survive refresh.

**Relevant existing files:**
- `apps/server/src/services/economy/runEconomyTx.ts` — the transaction primitive **every gacha pull must use**.
- `apps/server/src/services/economy/{creditCurrency,debitCurrency,grantItem}.ts`.
- `packages/shared/src/schema/*.ts` — Drizzle tables; `item_defs`, `currencies`, `rarity_tiers` already exist.
- `apps/server/src/repositories/*` — wallet/inventory/ledger/idempotency repos.
- `apps/web/src/api/client.ts` — typed client with idempotency-key generation.

## Objective

Build the gacha system and the upgrade **trees** — the meta loop that turns materials/currency into power and new units. Gacha must be fully server-authoritative (rarity tiers, soft/hard pity, 50/50 featured, single/10-pull, duplicate conversion) with an immutable `pull_history`, and a **public published-odds page** (required before any commercial launch). Weapon and base upgrade trees get their content curves and UI (the spend mechanism shipped in Phase 3).

## Architecture Decisions

### Decision: Two-layer roll — rarity first, then item within tier
- **Choice:** Roll the rarity tier (with pity/soft-pity/hard-pity/50-50 overrides), then roll an item within that tier by weight from `banner_pool_items`.
- **Alternatives considered:** One big weighted table over all items. Rejected — couples "luck" to "which item," makes featured boosts and pity awkward.
- **Rationale:** OCP — new banners/featured units are pure data changes; the roll engine never changes.
- **Tradeoff:** Two rolls instead of one; negligible cost, big config flexibility.

### Decision: Pity is per pity-group, carried across banners in the group
- **Choice:** `player_pity(player_id, pity_group)` tracks `pulls_since_5star`, `pulls_since_4star`, `guaranteed_featured`, `fate_points`. Character-event banners share one group; weapon banners another; standard another.
- **Rationale:** Matches the proven Genshin model; predictable, player-trusted.
- **Tradeoff:** Slightly more state; correct behavior.

## Implementation Steps

### Step 1: Gacha schema
**What:** Add banner/pool/pity/history tables.
**File(s):** `packages/shared/src/schema/gacha.ts`, migration
**Details:**
- `banners(id, code, type, starts_at, ends_at, pity_group, soft_pity_start int, hard_pity int, four_star_interval int default 10, cost_currency, cost_per_pull int, featured_5star jsonb, featured_4star jsonb)`.
- `banner_pool_items(banner_id, item_id, rarity_code, is_featured bool, weight numeric)`.
- `player_pity(player_id, pity_group, pulls_since_5star int default 0, pulls_since_4star int default 0, guaranteed_featured bool default false, fate_points int default 0, PK(player_id,pity_group))`.
- `pull_history(id bigserial, player_id, banner_id, item_id, rarity_code, was_featured bool, pity_counter_at_pull int, roll_seed text, idempotency_key uuid, created_at)` — **immutable audit + compliance artifact**.

### Step 2: The roll engine (pure, unit-tested)
**What:** Deterministic-given-seed roll logic with pity.
**File(s):** `packages/shared/src/gacha/rollEngine.ts`, `.../gacha/pity.ts`
**Details:**
- `rollRarity({ pity, config, rng })`: base rate until `soft_pity_start`, then ramp per pull; hard pity guarantees 5★ at `hard_pity`; guarantee a 4★ at least every `four_star_interval`.
- `applyFeaturedRule({ rarity, pity, banner, rng })`: on 5★, if `guaranteed_featured` → featured; else 50/50, and losing sets `guaranteed_featured=true`. Weapon banners: `fate_points` targeting (1 point guarantees chosen weapon on next 5★).
- `rollItemInTier({ tier, banner, rng })`: weighted pick from pool.
- Pure functions take an injected `rng` (seeded CSPRNG stream) → fully unit-testable and reproducible from `roll_seed`.
> **ANTI-PATTERN: Client-Side Roll Preview That Becomes the Result** — ❌ Don't roll on the client and "confirm" on the server. ✅ Server rolls; client only animates the returned result. 💡 A client roll is a forged roll.

### Step 3: Pull service on `runEconomyTx`
**What:** The authoritative pull, one transaction.
**File(s):** `apps/server/src/services/gacha/pullService.ts`, `apps/server/src/app/actions/pullBanner.ts`, shared input schema `packages/shared/src/api/gacha.ts`
**Details:** `pullBanner({ bannerId, count: 1|10, idempotencyKey })`:
1. `runEconomyTx` → claim idempotency key.
2. Load banner; assert active; compute cost = `cost_per_pull * count`; `debitCurrency` (ledger).
3. Load `player_pity(group)`; for each of `count`: seed a CSPRNG substream → `rollRarity` → `applyFeaturedRule` → `rollItemInTier` → update pity counters → `grantItem` (or convert duplicate) → insert `pull_history`.
4. Return results (items, rarities, pity state) → client animates.
- **Duplicate handling:** dupes raise the item's `refinement` up to a cap, then convert to a soft currency payout — dupes are never dead weight.
> **ANTI-PATTERN: Multiple Statements Outside One Transaction** — ❌ Don't debit, then grant, in separate transactions. ✅ Debit + all grants + pity + history in ONE serializable txn. 💡 A crash between steps must not lose currency or dupe items.

### Step 4: Published odds endpoint + page (compliance)
**What:** Public, honest odds + pity disclosure.
**File(s):** `apps/server/src/app/actions/getOdds.ts`, `apps/web/src/ui/gacha/OddsPage.tsx`
**Details:** `getOdds(bannerId)` returns consolidated rates (base + pity-inclusive), soft/hard pity thresholds, 50/50 rule, and the full featured pool. Render a clear odds page linked from the gacha screen. This is mandatory for App Store/Google Play and several jurisdictions (China requires exact per-item probabilities). See overview + Phase 8 launch gate.
> **ANTI-PATTERN: Hiding Real-Money Cost Behind Currency Layers** — ❌ Don't obscure effective cost/odds. ✅ Disclose odds + pity plainly. 💡 FTC dark-pattern exposure; platform policy requires it.

### Step 5: Gacha UI + pull animation
**What:** Banner screen, single/10-pull, reveal animation.
**File(s):** `apps/web/src/ui/gacha/{BannerScreen,PullReveal,PityMeter}.tsx`, `apps/web/src/api/gacha.ts`
**Details:** Client sends intent, receives authoritative results, plays the reveal (rarity flourish). `PityMeter` reads `player_pity` from the server. All numbers displayed come from the server response — the client computes none.

### Step 6: Weapon & base upgrade trees (content + UI)
**What:** Design the upgrade curves and build the tree UI (spend mechanism exists from Phase 3).
**File(s):** `packages/shared/src/balance/upgradeCurves.ts`, `apps/server/src/services/economy/{upgradeWeapon,upgradeFacility}.ts` (extend), `apps/web/src/ui/base/{BaseScreen,UpgradeTree}.tsx`
**Details:**
- Cost curves: **hybrid exponential + milestone** — `cost = base * r^level` (r≈1.12–1.18) with milestone gates at breakpoints that unlock zones/features. Materials come from hunts (Phase 5). Tune backwards from pacing ("an upgrade every ~2 days").
- Facilities give **capabilities/variety**, not just flat power (roguelite best practice: meta upgrades are a leash, not a crutch) — e.g. unlock a new weapon slot, a crafting bench, a pull-discount, a new zone.
- `UpgradeTree`: shows facility levels, costs, and prerequisites; calls `upgradeFacility`/`upgradeWeapon`.
> **ANTI-PATTERN: Flat Stat-Bump Meta Progression** — ❌ Don't make every upgrade "+5% damage." ✅ Bias toward new options/capabilities; soft-cap raw power. 💡 Pure power meta makes veterans bounce; variety retains.

## State Management for This Phase

| State | Category | Location | Source of Truth | Persistence |
|-------|----------|----------|-----------------|-------------|
| Pity counters | server data | `player_pity` | **Server** | durable |
| Pull history | server data | `pull_history` (immutable) | Server | durable |
| Banner config / odds | server data | `banners`, `banner_pool_items` | Server | durable |
| Facility/weapon levels | server data | `player_facilities`, `player_weapon_levels` | Server | durable |
| Gacha UI (reveal, selection) | UI | React local + Zustand | client | none |

## Error Handling

| Operation | Failure Mode | User-Facing Behavior | Recovery Strategy |
|-----------|-------------|----------------------|-------------------|
| Pull | Insufficient premium currency | "Not enough X" + link to earn/buy | 402; no debit |
| Pull | Banner expired mid-session | "Banner ended" toast | Server rejects; client refreshes banner list |
| Pull | Retry after timeout | Same items returned, not re-rolled | Idempotency key |
| Upgrade | Prereq/milestone not met | Disabled button + tooltip | Server re-validates prereqs |

## Testing Requirements for This Phase

- [ ] Hard pity: at `hard_pity` pulls with no 5★, the next pull is guaranteed 5★.
- [ ] Soft pity ramps 5★ rate after `soft_pity_start` (statistical test over many seeded rolls).
- [ ] 4★ guaranteed at least every `four_star_interval`.
- [ ] Losing a 50/50 sets `guaranteed_featured`; the next 5★ is featured.
- [ ] A 10-pull debits exactly `10 * cost_per_pull` once (idempotent) and grants 10 results.
- [ ] Duplicate beyond refinement cap converts to the correct soft-currency payout.
- [ ] Published odds returned by `getOdds` match the actual roll-engine probabilities.
- [ ] `pull_history` row written for every single pull with seed + pity-at-pull.

**Test type guidance:** Unit-test the pure roll engine exhaustively with seeded RNG (deterministic). Integration-test the full `pullBanner` transaction (debit + grants + pity + history atomic; idempotency). A statistical harness (e.g. 100k seeded pulls) validates the empirical rates equal the published odds — this doubles as the compliance check.

## Acceptance Criteria

- [ ] Player can single- and 10-pull an active banner using earned currency; results persist.
- [ ] Pity, 50/50, and 4★ floor all behave correctly and are visible via the pity meter.
- [ ] Published odds page shows honest, pity-inclusive rates matching the engine.
- [ ] Every pull writes an immutable history row; balances/ledger stay consistent.
- [ ] Weapon and base upgrade trees spend materials and unlock capabilities.
- [ ] No pull outcome can be influenced from the client (verified by request tampering test).

**Verification commands:**
- `pnpm --filter shared test` — roll-engine + statistical tests pass
- `pnpm --filter server test` — pull integration + idempotency tests pass
- `pnpm --filter web build && pnpm --filter server build`

**Smoke test:** Do a 10-pull; watch the pity meter advance; keep pulling to hard pity and confirm a guaranteed 5★; lose a 50/50 then confirm the next 5★ is featured. Open the odds page and confirm the rates match. Try editing the pull request in devtools — the server ignores it.

## Handoff to Next Phase

The full meta loop exists: server-authoritative gacha with pity/50-50/dupe-conversion + immutable history, a compliant published-odds page, and weapon/base upgrade trees that convert materials into capabilities. But materials still come from Phase 3's provisional `grantDrops`. Phase 5 builds the real roguelite loop: zones with escalating monster tiers, a server-tracked hunt/run lifecycle, and **server-validated loot tables** that replace the provisional grant — closing the loop hunt → materials → upgrade → unlock harder zone.

**Open questions for next phase:**
- Material→zone mapping (which zone drops which mats) — design in Phase 5 with `zones`/`loot_tables`.
- Anti-cheat for hunt results (client reports combat; server must bound/validate) — the central Phase 5 problem.
