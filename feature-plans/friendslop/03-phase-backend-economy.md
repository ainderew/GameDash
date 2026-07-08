# Phase 3: Backend & Economy — Auth, Schema, Server-Authoritative Ledger

> **Feature:** friendslop — 3D web gacha roguelite
> **Phase:** 3 of 8
> **Depends on:** `01-phase-foundation.md`, `02-phase-combat-slice.md`
> **Estimated scope:** Large

## Context from Previous Phase

Phases 1–2 delivered a fully client-side, fun combat slice: third-person controller, weapons, monster AI, hit detection, animation state machine, and a `LootDropped` typed event. **Nothing persists** — no accounts, no saved inventory, no real currency. This phase adds the authoritative backend.

**Relevant files that exist:**
- `packages/shared/src/{types,balance,combat,monsters}.ts` — shared domain layer (no framework deps).
- `apps/web/src/game/events.ts` — typed event bus emitting `LootDropped { tableId, position }`.
- `apps/web/src/ui/store.ts` — Zustand UI/meta store (currently ephemeral).

## Existing Codebase Context

- Monorepo is a pnpm workspace: `apps/web` (Vite client), `packages/shared`. **This phase adds `apps/server` (Next.js).**
- All shared types/schemas belong in `packages/shared` so client and server validate against one source (Consistency principle).

## Objective

Introduce accounts and a **tamper-proof economy**. Add a Next.js server (Vercel) backed by Supabase Postgres, with auth, the full schema (config + per-player + audit tables), a repository/service layer, and the first server-authoritative mutation endpoints (currency, inventory grants, upgrades — gacha itself is Phase 4). Establish the non-negotiable pattern every economy op follows: **one serializable transaction + idempotency key + append-only ledger row, with server-side RNG**. Wire cloud save so progress survives refresh.

## Architecture Decisions

### Decision: The client sends intent; the server owns every outcome
- **Choice:** No balance, drop result, or upgrade result is ever computed or trusted from the client. Endpoints accept intent + an idempotency key; the server validates, mutates in a transaction, and returns the authoritative new state.
- **Rationale:** Threat model — a browser is attacker-controlled (devtools, request forgery/replay). Server authority eliminates currency dupes, item injection, and forced rolls. (Overview core rule.)
- **Tradeoff:** More round-trips than a naive client-side economy; the only acceptable design for a commercial gacha.

### Decision: Append-only ledger is the source of truth for currency
- **Choice:** `player_wallets.balance` is a materialized convenience column with a `CHECK (balance >= 0)`; every change writes a `currency_ledger` row **in the same transaction**. Balance is always reconstructable by summing the ledger.
- **Rationale:** ACID Atomicity + Durability; auditability required for commercial/regulatory reasons.
- **Tradeoff:** Extra writes; gains full traceability ("how did this player get X?").

### Decision: Thin controllers → services → repositories
- **Choice:** Next.js server actions / route handlers are thin. Business logic lives in `services/`; data access in `repositories/`. Zod schemas (in `packages/shared`) validate all input.
- **Rationale:** SRP + DIP; logic is testable without HTTP and reusable across actions.
- **Tradeoff:** More files; standard clean-architecture layering.

## Implementation Steps

### Step 1: Add the Next.js server app + Supabase
**What:** Scaffold `apps/server` and connect Supabase.
**File(s):** `apps/server/` (Next.js App Router), `apps/server/src/lib/supabase.ts`, `.env.example`, `apps/server/drizzle.config.ts`
**Details:**
- Use **Drizzle ORM** over Supabase Postgres (typed schema, migrations, transactions). Server-side client uses the service role key; the browser only ever holds the anon key and talks to *our* endpoints, not the DB directly.
- `.env.example`: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`. Validate env with Zod at boot.
> **ANTI-PATTERN: Direct DB Access from the Browser** — ❌ Don't let the client hit Supabase tables directly for economy data (even with RLS, the client controls the request). ✅ All economy mutations go through our server endpoints. 💡 RLS protects rows, not business rules like pity/rates.

### Step 2: Auth (Supabase Auth)
**What:** Email/OAuth login; map an auth user to a `players` row.
**File(s):** `apps/server/src/app/(auth)/...`, `apps/server/src/services/authService.ts`, `apps/web/src/auth/*`
**Details:** Supabase Auth (free to 50k MAU, no per-MAU tax). On first login, create a `players` row + starter `player_wallets` + `player_save_state`. Every server action resolves `player_id` **from the session**, never from the request body.
> **ANTI-PATTERN: Trusting player_id from the Request** — ❌ Don't accept `{ playerId }` in the body. ✅ Derive it from the authenticated session server-side. 💡 Otherwise anyone edits anyone's wallet.

### Step 3: Schema — config, per-player, audit
**What:** Define all tables via Drizzle migrations.
**File(s):** `packages/shared/src/schema/*.ts` (Drizzle table defs, imported by server), migration files.
**Details (tables & key columns):**
- **Config:** `item_defs(id, kind, rarity, base_stats jsonb, meta jsonb)`; `currencies(code PK, name, kind)` where kind ∈ `soft|premium|material`; `rarity_tiers(code PK, base_rate numeric)`; `facility_defs`, `weapon_upgrade_defs` (cost curves), `zones`, `monster_defs`, `loot_tables` (banners live in Phase 4).
- **Per-player:** `players(id, auth_user_id unique, display_name, created_at)`; `player_wallets(player_id, currency_code, balance bigint CHECK(balance>=0), PK(player_id,currency_code))`; `inventory_items(id, player_id, item_def_id, qty, level, refinement)`; `player_facilities(player_id, facility_id, level)`; `player_weapon_levels(player_id, weapon_instance_id, level)`; `player_save_state(player_id, data jsonb)` (non-authoritative: settings, cosmetics, tutorial flags).
- **Audit/integrity:** `currency_ledger(id bigserial, player_id, currency_code, delta bigint, reason, ref_type, ref_id, idempotency_key, balance_after, created_at)` — append-only; `idempotency_keys(user_id, key, request_hash, response_code, response_body jsonb, locked_at, created_at, UNIQUE(user_id,key))`.
- **Indexes:** ledger on `(player_id, created_at)`; inventory on `(player_id, item_def_id)`; idempotency unique on `(user_id, key)`.
> **ANTI-PATTERN: Balances in JSONB** — ❌ Don't put money in the `player_save_state` blob. ✅ Money = real columns with CHECK constraints + ledger. 💡 JSONB can't enforce non-negative balances or be transactionally reconciled cleanly.

### Step 4: Repository layer
**What:** Typed data-access functions; no business logic.
**File(s):** `apps/server/src/repositories/{walletRepo,inventoryRepo,ledgerRepo,idempotencyRepo}.ts`
**Details:** e.g. `walletRepo.getBalance(tx, playerId, code)`, `ledgerRepo.append(tx, row)`, `idempotencyRepo.claim(tx, userId, key, requestHash)`. All accept a transaction handle so services compose them atomically.
> **ANTI-PATTERN: ORM Queries in Controllers** — ❌ Don't call Drizzle in server actions. ✅ Actions call services; services call repos. 💡 Keeps data access swappable and testable.

### Step 5: The economy transaction primitive
**What:** A reusable `runEconomyTx` helper enforcing the invariant pattern.
**File(s):** `apps/server/src/services/economy/runEconomyTx.ts`, `.../creditCurrency.ts`, `.../debitCurrency.ts`, `.../grantItem.ts`
**Details:**
- `runEconomyTx({ playerId, idempotencyKey, requestHash }, fn)`: opens a `SERIALIZABLE` transaction, claims the idempotency key (returns cached response if the key was already completed; 409 if same key + different body), runs `fn(tx)`, caches the response, commits.
- `creditCurrency`/`debitCurrency` update the wallet **and** append a matching ledger row atomically; debit asserts sufficient balance (else typed `InsufficientFundsError`).
- Server RNG uses `crypto` (CSPRNG), never `Math.random()`.
> **ANTI-PATTERN: Non-Idempotent Money Endpoints** — ❌ Don't let a retried request double-charge/double-grant. ✅ Every mutating economy request carries a client-generated idempotency key; the server dedupes. 💡 The network guarantees at-least-once; you need exactly-once.
> **ANTI-PATTERN: Math.random() for Rewards** — ❌ Don't use `Math.random()` for drops/pulls. ✅ Server-side CSPRNG; persist the seed. 💡 Predictable RNG is exploitable and unauditable.

### Step 6: First endpoints — upgrades + inventory grant + save
**What:** Ship the non-gacha mutations end-to-end (gacha is Phase 4).
**File(s):** `apps/server/src/app/actions/{upgradeWeapon,upgradeFacility,grantDrops,syncSave,loadSave}.ts`, service files, shared Zod input schemas in `packages/shared/src/api/*.ts`
**Details:**
- `upgradeWeapon`/`upgradeFacility`: validate input → `runEconomyTx` → check material cost from `*_upgrade_defs`/`facility_defs` cost curve → debit materials (ledger) → increment level → return new state.
- `grantDrops({ huntId?, drops[] })`: **provisional stand-in** for Phase 5's validated loot — for now, credits a small fixed drop so the client loop closes. Phase 5 replaces the input with server-rolled loot from `startHunt`/`reportHuntResult`.
- `syncSave`/`loadSave`: read/write `player_save_state.data` (non-authoritative only).
> **ANTI-PATTERN: Business Logic in the Action** — ❌ Don't inline cost math + DB writes in the action file. ✅ Action parses/authorizes, calls `upgradeWeaponService`. 💡 SRP; the service is unit-testable without HTTP.

### Step 7: Client integration — API client + optimistic reconcile
**What:** Wire the client to call the server and reconcile.
**File(s):** `apps/web/src/api/client.ts`, `apps/web/src/api/economy.ts`, update `apps/web/src/game/events.ts` consumer, `apps/web/src/ui/store.ts`
**Details:**
- `client.ts`: typed fetch wrapper attaching the session token, generating idempotency keys (uuid) for mutations, and surfacing typed errors.
- Bridge the Phase 2 `LootDropped` event → optimistic pickup UI → `grantDrops` call; the server response is the source of truth (reconcile if it differs).
- Load `loadSave` on boot to hydrate settings/cosmetics; wallet/inventory come from dedicated authoritative reads.
> **ANTI-PATTERN: useEffect Data Waterfalls** — ❌ Don't chain fetches in nested effects. ✅ Use TanStack Query (client) or server-component loads for reads; mutations via the typed client. 💡 Avoids flicker/waterfalls.

## State Management for This Phase

| State | Category | Location | Source of Truth | Persistence |
|-------|----------|----------|-----------------|-------------|
| Wallet balances | server data | Postgres `player_wallets` + ledger | **Server** | durable |
| Inventory / levels | server data | Postgres `inventory_items`, `player_*` | **Server** | durable |
| Idempotency records | server data | Postgres `idempotency_keys` | Server | durable (reaped ~72h) |
| Session/auth | shared | Supabase Auth session | Supabase | durable |
| Settings/cosmetics | server data | `player_save_state.data` (JSONB) | Server | durable |
| Client mirrors of wallet/inv | cache | TanStack Query cache | Server | refetched/invalidated on mutation |

## Error Handling

| Operation | Failure Mode | User-Facing Behavior | Recovery Strategy |
|-----------|-------------|----------------------|-------------------|
| Upgrade/spend | Insufficient materials | Inline "not enough X" | Typed `InsufficientFundsError` → 402; no mutation |
| Any mutation | Network retry / dup submit | Idempotent no-op, same result | Idempotency key returns cached response |
| Any mutation | Same key, different body | Reject | 409 conflict (misuse/fraud signal) |
| Transaction | Serialization conflict | Transparent retry | Bounded retry loop on serialization failure |
| Auth | Expired session | Redirect to login, preserve intent | Refresh token / re-auth |

## Testing Requirements for This Phase

- [ ] Debit below zero is rejected and writes no ledger row (integration test on a real test DB).
- [ ] Same idempotency key twice → one mutation, identical response both times.
- [ ] Same key + different body → 409.
- [ ] Ledger sum always equals `player_wallets.balance` after a batch of random credits/debits.
- [ ] Upgrade spends the exact cost-curve amount and increments level by one.
- [ ] `player_id` is taken from session; a forged body `playerId` is ignored.

**Test type guidance:** This is the highest-risk area — prioritize **integration tests** against a real Postgres (Supabase local / Testcontainers), not mocks. Concurrency test: fire N parallel debits on the same wallet and assert no oversell (Isolation). Unit-test cost-curve math in `packages/shared`.

## Acceptance Criteria

- [ ] A new user can sign up, gets a `players` row + starter wallet.
- [ ] Killing monsters → `grantDrops` credits materials that **persist across refresh**.
- [ ] Spending materials to upgrade a weapon/facility works and is reflected after reload.
- [ ] Every balance change has a corresponding ledger row; balances never go negative.
- [ ] Replaying a mutation request does not double-apply.
- [ ] Settings persist via cloud save.

**Verification commands:**
- `pnpm --filter server test` — economy integration tests pass (against test DB)
- `pnpm --filter server typecheck && pnpm --filter server lint && pnpm --filter server build`
- `pnpm --filter server db:migrate` — migrations apply cleanly

**Smoke test:** Sign up, hunt and kill monsters, refresh — materials remain. Upgrade a weapon; balance decreases, level increases, both survive reload. Open the Network tab and replay a `upgradeWeapon` request — no double spend.

## Handoff to Next Phase

Accounts, the full schema, a repository/service layer, and the server-authoritative economy primitive (`runEconomyTx` = serializable txn + idempotency + ledger + CSPRNG) are live, with upgrades, provisional drop grants, and cloud save wired end-to-end. Phase 4 builds the gacha system on this exact primitive — banners, rarity/pity/50-50, single/10-pull, dupe conversion — plus the weapon/base upgrade **trees** (this phase shipped the mechanism; Phase 4 designs the content/curves and the UI), and the public **published odds** page required for commercial launch.

**Open questions for next phase:**
- Currency taxonomy: confirm soft (materials/coins) vs premium (gacha currency) split before wiring banners.
- Whether pity is per-banner-group (recommended, Genshin-style) — lock in Phase 4 schema.
