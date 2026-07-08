# Phase 8: Polish, Performance & Commercial Launch Gate

> **Feature:** friendslop — 3D web gacha roguelite
> **Phase:** 8 of 8
> **Depends on:** all prior phases
> **Estimated scope:** Large

## Context from Previous Phase

The game is MVP-feature-complete: third-person combat, server-authoritative economy, gacha with pity + published odds, weapon/base upgrade trees, zones with seed-validated loot, real optimized assets, and async social (friends, leaderboards, base showcases). Everything is server-authoritative and cloud-saved. What remains is making it *fast*, *robust*, and — critically — *legal to charge money for*.

**Key artifacts this phase audits:**
- `assets/asset-ledger.json` — every asset's `commercial_ok` flag (from Phase 6).
- `getOdds` / `OddsPage` — published gacha odds (from Phase 4).
- `currency_ledger`, `pull_history` — audit trails (from Phase 3–4).
- `runEconomyTx` and all mutation endpoints — the anti-cheat surface.

## Objective

Ship-readiness in two tracks: **(A) polish & performance** — error/loading states, mobile responsiveness, 60fps under load, save-anti-tamper hardening; and **(B) the commercial launch gate** — a hard checklist that must fully pass before any real-money feature goes live: asset-license audit + regeneration, odds verification, region/age compliance, security review, and only then Stripe integration.

## Architecture Decisions

### Decision: Payments integrate last, behind the gate
- **Choice:** Stripe and premium-currency purchase are the final integration, enabled only after every gate item passes.
- **Rationale:** Overview Decision #11 — don't monetize an unfun/unsafe game; keep the regulatory surface closed until everything else is proven.
- **Tradeoff:** No revenue until launch-ready; correct sequencing.

### Decision: Free-tier prototype assets are replaced, not shipped
- **Choice:** Any `asset-ledger.json` entry with `commercial_ok: false` (e.g. `tripo-free`) is regenerated under paid Tripo/Meshy Pro (ownership) or self-hosted Hunyuan3D-2.1 (commercial license) — or swapped for CC0 — before launch.
- **Rationale:** The guiding principle's hard gate; non-commercial assets are illegal to sell.
- **Tradeoff:** A regeneration cost/effort spike at the end; budgeted and expected.

## Implementation Steps

### Step 1: Performance pass
**What:** Hold 60fps with real assets under load; fast first paint.
**File(s):** `apps/web/src/game/**` (instancing/LOD audit), `apps/web/src/lib/preload.ts`, `apps/web/vite.config.ts` (bundle splitting)
**Details:** Audit draw calls (<100 target) via r3f-perf; ensure monsters instanced + LOD'd; clamp `dpr` on mobile; `<AdaptiveDpr>`/`<PerformanceMonitor>` to drop quality dynamically; code-split the 3D scene from landing/menu so first paint is fast; verify KTX2 textures stay GPU-compressed.
> **ANTI-PATTERN: Premature Optimization Without Measurement** — ❌ Don't micro-optimize by guess. ✅ Profile with r3f-perf/DevTools, fix the actual bottleneck (usually draw calls). 💡 Measure, then optimize.

### Step 2: Error, loading & empty states
**What:** Robust UX around every fallible operation.
**File(s):** error boundaries around `<Canvas>` and each major screen, `LoadingScreen`, offline/disconnect handling in `apps/web/src/api/client.ts`
**Details:** Loading screens with asset preload progress; error boundaries with reset; graceful offline handling (queue mutations, reconcile on reconnect); friendly GPU-unsupported fallback. No empty `catch` blocks anywhere.
> **ANTI-PATTERN: Empty Catch Blocks** — ❌ `catch (e) {}`. ✅ Log/rethrow/handle explicitly. 💡 Silent failures are the hardest bugs.

### Step 3: Save anti-tamper hardening
**What:** Ensure no client state can corrupt the authoritative economy.
**File(s):** `apps/server/src/services/**` (validation audit), `apps/server/src/lib/rateLimit.ts`
**Details:** Re-audit every mutation endpoint: `player_id` from session only; all inputs Zod-validated; all rewards server-derived/bounded (Phase 5 seed checks); rate-limit all mutations; confirm `player_save_state` holds only non-authoritative data. Add anomaly logging for bound-check rejections.

### Step 4: Automated test + E2E suite consolidation
**What:** Lock in coverage of the critical paths.
**File(s):** `apps/web/e2e/*` (Playwright), CI workflow `.github/workflows/ci.yml`
**Details:** Playwright E2E for the golden path (sign up → hunt → drop → upgrade → pull → leaderboard). Ensure economy integration tests (Phase 3–5) run in CI against a test DB. Gate merges on lint + typecheck + tests.
> **ANTI-PATTERN: Mocking Everything** — ❌ Don't mock the DB in economy tests. ✅ Real test Postgres; mock only external HTTP (Stripe). 💡 Bugs hide at module boundaries mocks paper over.

### Step 5: 🔒 Commercial Launch Gate (must fully pass before Step 6)
**What:** The hard checklist that authorizes monetization.
**File(s):** `docs/launch-gate.md` (the living checklist), `scripts/assets-check` (from Phase 6)
**Gate items:**
- [ ] **Asset license audit:** `assets:check` passes; every shipped asset has `commercial_ok: true`. All `tripo-free`/CC-BY-without-compliance assets regenerated (paid Pro / Hunyuan3D) or replaced with CC0. `LICENSES.md` complete.
- [ ] **Published odds:** `getOdds` matches the roll engine (statistical test from Phase 4); odds + pity displayed pre-purchase; per-item probabilities available (China requirement).
- [ ] **No real-money tradeability:** confirm no gifting/trading of premium items exists (avoids Belgium gambling classification).
- [ ] **Region/age compliance:** PEGI "paid random items" labeling plan; consider geo-gating Belgium; age-gate + spend limits where required (China/Korea); disclosed-rates pages live. Get current legal review (Digital Fairness Act / PEGI-16 floor were pending in 2026).
- [ ] **Security review:** run a security pass on all mutation endpoints; verify idempotency, serializable transactions, ledger integrity, rate limits, and session-derived `player_id` everywhere.
- [ ] **Audit trails:** `currency_ledger` + `pull_history` immutable and complete; balance = ledger sum invariant holds.
> **ANTI-PATTERN: Shipping Before the Gate** — ❌ Don't enable purchases with any gate item unchecked. ✅ Every box ticked, legal reviewed, then integrate payments. 💡 A single non-commercial asset or undisclosed odds is a legal/store-rejection risk.

### Step 6: Stripe / premium currency (only after the gate)
**What:** Real-money purchase of premium currency.
**File(s):** `apps/server/src/app/actions/purchasePremium.ts`, `apps/server/src/app/api/webhooks/stripe/route.ts`, `apps/server/src/services/payments/*`
**Details:** Stripe Checkout for premium-currency packs; the **webhook** (not the client) credits currency via `runEconomyTx` (idempotent on the Stripe event id); handle refunds/chargebacks (reverse via ledger); tax/VAT via Stripe Tax. Premium currency feeds the existing gacha — no new economy path.
> **ANTI-PATTERN: Crediting Currency from the Client Purchase Callback** — ❌ Don't grant premium currency on the browser "success" redirect. ✅ Grant only from the verified Stripe webhook, idempotently. 💡 The success redirect is forgeable; the signed webhook is the source of truth.

## State Management for This Phase

| State | Category | Location | Source of Truth | Persistence |
|-------|----------|----------|-----------------|-------------|
| Purchase records | server data | Postgres + Stripe | Stripe webhook → ledger | durable |
| Perf quality settings | UI | Zustand + save state | client (with server-saved pref) | durable (pref) |
| Launch-gate status | docs/process | `docs/launch-gate.md` | manual sign-off | n/a |

## Error Handling

| Operation | Failure Mode | User-Facing Behavior | Recovery Strategy |
|-----------|-------------|----------------------|-------------------|
| Purchase | Payment fails | Stripe error surfaced; no credit | No webhook → no grant |
| Purchase | Webhook retry | Idempotent single credit | Idempotency on Stripe event id |
| Refund/chargeback | Reverse currency | Balance adjusted (may go pending) | Ledger reversal entry |
| Load under poor GPU | Low FPS | Auto quality drop | `PerformanceMonitor` reduces dpr/effects |
| Disconnect | Mutation in flight | Retry on reconnect | Idempotency keys make retries safe |

## Testing Requirements for This Phase

- [ ] Golden-path E2E passes (signup→hunt→upgrade→pull→leaderboard).
- [ ] Stripe webhook credits exactly once per event (idempotent); success-redirect alone grants nothing.
- [ ] Refund path writes a reversing ledger entry.
- [ ] `assets:check` fails the build if any `commercial_ok: false` asset is referenced in a shipped zone.
- [ ] Load/perf: 60fps under a full zone of instanced monsters on a mid device; first paint within budget.
- [ ] Security: forged `player_id`, replayed mutations, and client score/pull tampering all rejected.

**Test type guidance:** E2E (Playwright) for the golden path and purchase flow (Stripe test mode). Keep economy integration tests against a real test DB. The launch gate is a manual sign-off backed by the automated `assets:check` and the Phase 4 statistical odds test.

## Acceptance Criteria

- [ ] 60fps under load; fast first paint; graceful loading/error/offline states.
- [ ] No client input can corrupt the economy (security audit clean).
- [ ] **Launch gate fully green:** every asset commercially licensed, odds published & verified, no premium tradeability, region/age plan in place, audit trails intact, security reviewed.
- [ ] Stripe purchase → premium currency works and is credited only via idempotent webhook.
- [ ] CI gates merges on lint + typecheck + tests.

**Verification commands:**
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all packages green
- `pnpm --filter web run assets:check` — commercial license audit passes
- `pnpm --filter web e2e` — golden-path + purchase E2E pass
- `pnpm --filter web build && pnpm --filter server build`

**Smoke test:** Run the full golden path as a new user on a mid laptop and a phone browser; verify 60fps and clean states throughout. In Stripe test mode, buy a currency pack — confirm currency appears only after the webhook, and a replayed webhook doesn't double-credit. Confirm the launch-gate checklist in `docs/launch-gate.md` is fully signed off.

## Handoff / Post-Launch

friendslop is ship-ready: fast, robust, server-authoritative, legally launch-gated, and monetizable. Post-MVP candidates (each its own future feature plan): real-time co-op (Colyseus as a separate stateful service calling the same economy API), spatial base building, procedural level geometry, seasonal leaderboards/banners, trading (only if legally cleared and non-tradeable-safe), and native app wrappers.

**Open questions (post-launch):**
- Live-ops cadence for new banners/zones — needs a content pipeline once the game is live.
- Analytics/economy telemetry to tune sources/sinks against real retention data (the ledger is the raw material).
