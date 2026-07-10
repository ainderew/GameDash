# Feature Plan: Relic Pass — Failure Behavior

> **Created:** 2026-07-10
> **Status:** ✅ Implemented 2026-07-10 (same session as relic-receiver-feedback.md). Open questions resolved: Q1 = thrower cooldown IS refunded on failure; Q2 = hover stays 0.6 (tunable); Q3 = marker for all grounded relics, hot pulse + error tone for failures only. Obstruction/thief/boss failures remain deferred as planned.
> **Estimated scope:** small — can ride along in the same session as `relic-receiver-feedback.md` (both touch `relicSystem.ts` + the pass FX layer)
> **Spec source:** RELIC RELAY pass technical specification §13 ("Failure behavior") — Andrew's design doc

## Current state vs spec (audit of `apps/web/src/game/ecs/systems/relicSystem.ts`, 2026-07-10)

### Failure *reasons* — mostly in place

| Spec failure reason | Status |
|---|---|
| Receiver downed before arrival | ✅ implemented + unit-tested (dies mid-flight → drop) |
| Receiver teleports beyond correction range | ✅ implemented + unit-tested (3 m homing budget; arrival tolerance 2 m) |
| Thrower heavily interrupted before launch | ✅ heavy stagger / dodge / melee / death cancel the aim (`passControl.ts`); light damage doesn't |
| Static obstruction (closing gate) | ❌ no collision sweep exists (spec §9 sweep also unbuilt); no gates exist either |
| Relic Thief intercepts | ❌ enemy type doesn't exist |
| Boss interception move | ❌ no boss |

### Failure *landing behavior* — the gap this plan closes

| Spec on-failure behavior | Status |
|---|---|
| Relic follows its remaining momentum | ⚠️ partial — it completes the full Bézier deterministically, but then stops dead |
| Bounces once | ❌ it instantly snaps to grounded hover at the arrival point |
| Hovers ~0.3 m above landing point | ⚠️ hovers at `RELIC_GROUND_HOVER` = 0.6 (chosen for the 4-part model's hanging base tendrils — see open question) |
| Creates a bright world marker | ❌ nothing; a grounded relic is genuinely hard to see in tall grass today |
| Immediately recoverable | ⚠️ by teammates yes (`noCatchUntil = 0` on pass flights); the **thrower** is still locked out by their own 2.5 s `relicRecatchUntil` (see open question) |
| Relic Thieves prioritize it | ❌ blocked on the enemy existing |
| Never rolls downhill | ✅ free — flight is deterministic, grounded pose is terrain-height + hover, no rigid body anywhere |

## Work items

### 1. Bounce-once on failed pass

**Where:** the pass-arrival failure branch in `relicSystem.ts` (currently calls `ground(s, pos)` when the receiver is dead/escaped at `t ≥ 1`).

Instead of grounding instantly, convert the failure into a **mini-lob** — the lob mode already does everything the spec asks:

- Exit direction = Bézier tangent at t=1, which is `P2 − P1` (`to − control`), projected to XZ and normalized → "follows remaining momentum".
- Set `mode = 'lob'`, `from = current pos`, `to = pos + dir × ~1.2`, `arcHeight ≈ 0.5`, `flightMs ≈ 260`, `noCatchUntil = 0`.
- Lob flights already run walk-in `tryCatch` every frame → the bounce itself is catchable, and it grounds via the existing path when it lands → "bounces once" then hovers, no rolling, done.
- Guard: a bounce must not chain into another bounce (it can't — lobs ground unconditionally at t≥1 — but assert this in the test).

New constants in `packages/shared/src/balance.ts`: `RELIC_FAIL_BOUNCE_DIST`, `RELIC_FAIL_BOUNCE_ARC`, `RELIC_FAIL_BOUNCE_MS`.

**Tests** (extend `relicSystem.test.ts`): failed pass (receiver teleports) → phase goes `inFlight:pass → inFlight:lob → grounded`, final position ≈ bounce distance past the Bézier endpoint along the tangent; bounce is immediately catchable by a teammate standing in its path.

### 2. Bright world marker on the grounded relic

**Where:** new render branch in the pass FX component (or `Relic.tsx` itself — decide by file size in-session).

- Spec ties the marker to *failure*, but a grounded relic is hard to spot in grass **today** regardless of how it got there — build it for the `grounded` phase generally. This also serves normal G-drops.
- Cheap, no-shader version matching the art direction: an additive vertical beam (open-ended cylinder, gold `#fbbf24`, opacity ~0.25, ~6 u tall, slow alpha pulse) + a flat ground ring that breathes (the aim-UI torus pattern). Bloom will catch the beam via the existing PostFX.
- Optionally brighter/faster pulse for the first ~1.5 s after a *failed* pass (read: "something went wrong, go get it") — needs a `groundedAt`/`groundedReason` stamp on `RelicState`. One extra field, worth it.

### 3. Event for failure (rides the same seam as receiver feedback)

Emit `RelicPassFailed { position, reason: 'receiver_downed' | 'receiver_escaped' }` through `events.ts`, sibling to the `RelicPassLaunched`/`RelicCaught` events specified in `relic-receiver-feedback.md`. Consumers now: the marker's "hot" state + a low error sound (spec §7 asks for a low tone on blocked/failed). Consumer later: server-authoritative failure, Relic Thief aggro ("thieves prioritize it" = AI targets the relic entity on this event).

## Explicitly out of scope (and where they land later)

- **Static-obstruction failures** — belongs to the spec §9 collision sweep (sphere-sweep the sampled curve against `obstacles` at release). Do it when arenas gain walls/gates; the open field can't produce this failure.
- **Relic Thief / boss interception** — new enemy archetype + explicit intercept volumes; design says these are the ONLY enemies that can intercept, so nothing to guard against until they exist.
- **"Thieves prioritize it"** — hangs off `RelicPassFailed` + a thief AI state; note left in `aiSystem` planning.

## Open questions for Andrew

1. **Thrower lockout on failure:** spec says the failed relic is "immediately recoverable," but the thrower's own 2.5 s rotation cooldown (`relicRecatchUntil`) still applies to them. If a pass fails with no teammate nearby, the relic sits exposed and the thrower has to stand next to it waiting. Options: (a) keep it — failure should hurt and forces rotation; (b) clear/halve the thrower's cooldown on `RelicPassFailed`. Lean (b)? Decide before implementing.
2. **Hover height:** spec says ~0.3 m; the model's base tendrils made 0.6 look right. Keep 0.6, or drop `RELIC_GROUND_HOVER` to 0.3 and tuck the tendrils? Purely visual — check both in-game.
3. Should the failure marker/error-tone also fire for intentional G-drops, or only failed passes? (Plan assumes: marker for all grounded, hot pulse + tone for failures only.)
