# Phase 5 — Relic Relay Over the Wire

> **Goal:** the signature mechanic between real humans. Pass, catch, fail-bounce, drop, and the rotation rule are decided by the server; every client renders the identical deterministic flight. The catch must feel as crisp at 150 ms as it does in solo.
>
> **Depends on:** Phase 3 (events/snapshots), coordinates with Phase 4 (shockwave hits monsters).

## Why this mechanic networks well

`RelicState` (sim `components.ts:44-82`) already describes a pass as pure data: Bézier `from/control/to`, `startedAt`, `flightMs`, `arcHeight`, homing budget. The receiver-feedback plan (`feature-plans/relic-receiver-feedback.md`) explicitly routed all feedback through events so "when netcode lands, the emit moves to the server-ack handler and every feedback effect comes along for free." This phase is that sentence coming true.

## Tasks

### Task 1: Server-authoritative relic state machine
- `relicSystem` runs only on the server in networked mode (Phase 4's authority flags). One relic per session, spawned server-side on expedition start (replaces `Relic.tsx:130` local spawn; client creates the render entity from the spawn event/snapshot).
- Relic snapshot record: phase (u8), carrierId, grounded pos — coarse truth. Flight is **event-driven** (Task 2), snapshots only reconcile drift/late-joiners.

### Task 2: Pass intent → validation → broadcast
- Client pass flow today: E-hold aim (`combat/passControl.ts` state machine, client-side — stays client-side) → release calls `passRelic`. In networked mode, release sends `PassIntent { targetId | none(lob), aimYaw, viewServerTimeMs }` in the InputCmd stream.
- Server validates: sender is carrier, target alive + in range/cone (checked against lag-comp rewound positions, reusing Phase 4's ring buffer), rotation rule (`relicRecatchUntil`) honored. Then it computes the Bézier (the same `passTargeting.ts` math from `sim`, using *server* predicted catch position) and broadcasts **`RelicPassLaunched`** carrying the full flight params + `serverTick`.
- Every client (including the thrower) plays the identical flight locally from the params — mid-flight homing (last 38 %, ≤ 3 m) re-targets the receiver's *snapshot-interpolated* position on each client and the *server* position on the server; the ≤ 3 m budget absorbs the ≤ interp-delay divergence. Server remains the arbiter of arrival.

### Task 3: Throw feel under latency
- **Predict the throw:** on release, the thrower immediately plays the throw animation, whoosh, and starts a *provisional* local flight from its own aim solution. On `RelicPassLaunched` (≈ 1 RTT later) the client swaps to the authoritative params — divergence is tiny (same math, same inputs) and folded in with a ≤ 100 ms curve blend. On **rejection** (`PassRejected { reason }`: not carrier / target invalid / rotation), the relic snaps back to the shoulder with the existing fail feedback — rare, and correct.
- Aim preview (dotted arc) stays fully client-side (it's UI).

### Task 4: Catch, fail, drop — server decides, events drive juice
- At flight end the **server** resolves: receiver alive + within catch tolerance → `RelicCaught { catcherId, pos }` (drives: attach, defensive shockwave — server applies the stagger/knockback to monsters (Phase 4 systems), clients play the VFX; catch-plant + hitstop only on the catcher's client, presentation-only); receiver downed/escaped → existing fail path: server runs the bounce mini-lob, emits `RelicPassFailed { reason }` + refunds the thrower's rotation cooldown (server-side rule now).
- **Catch timing tolerance:** the receiving client may show the catch up to `INTERP_DELAY` before/after the server tick; auto-catch is deterministic-on-arrival so pre-playing the catch animation at local arrival and confirming state on the event is safe (no player input races the catch — targeted passes are uninterceptable by design, which eliminates the classic contested-catch netcode problem).
- **Walk-in catch (grounded/lob):** genuinely contested (two players can race). Server-side first-to-radius wins per tick order; client shows pickup only on `RelicCaught`. Slight delay acceptable here (rare, low-stakes verb). `G` drop → `DropIntent`, server lobs it.
- **Receiver feedback** (incoming arc, amber ring, panned chime): consume `RelicPassLaunched` from the network — per the original design, zero changes to the effects themselves; stereo pan already derives from positions (`passTargeting.ts stereoPanFor`).

### Task 5: Edge cases
- **Carrier disconnects** → server drops the relic as a lob at their last position (reuse fail-bounce), emits `RelicDropped { reason:'disconnect' }`.
- **Carrier dies mid-aim / receiver dies mid-flight** → existing fail machinery (already implemented + tested in solo) now exercised server-side; port `relicSystem.test.ts` scenarios to a server-context test suite.
- **Late join / reconnect** mid-flight: `welcome` snapshot includes active flight params so the joiner reconstructs the arc.
- Rotation rule (`RELIC_PASS_RECATCH_MS`) enforced server-side; client only greys the UI.

### Task 6: Multi-human targeting polish
- Pass-candidate scoring (`passTargeting.ts`) now scores real players (and AI teammates in solo). Verify soft-lock cycling and cone selection with 3 candidates; tune `@shared/balance` pass constants at 150 ms via the harness. Recatch/rotation UX (who's eligible) surfaced on the HUD ring colors.

## Acceptance criteria
- Two humans at simulated 150 ms ± 30 ms complete a 10-pass relay: every flight path looks identical on both screens (record + compare positions), every catch fires shockwave/ring/chime on both, zero relic duplication or limbo states (single source of truth asserted by server invariant checks: exactly one of carried/inFlight/grounded).
- Thrower feels zero delay on release; catcher sees the incoming arc ≥ 500 ms before arrival (feedback events arrive at launch, flight ≥ 600 ms typical).
- Kill the carrier's tab mid-carry → relic lobs out within one grace tick on all clients.
- Server relic test suite (ported + disconnect/reject cases) green.

## Risks
- **Provisional-flight vs authoritative-flight mismatch** if client and server aim solutions drift (different predicted catch positions) — bound by the blend window; measure divergence in the debug overlay; if consistently > 1 m, delay the local flight start by ~½ RTT instead (trade tiny throw latency for zero blend).
- **Shockwave fairness:** monsters staggered by a catch the attacker hasn't seen yet — acceptable (shockwave deals no damage, pure space-making; latency here is invisible in practice).
