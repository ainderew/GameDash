# Feature Plan: Relic Pass — Receiver Feedback

> **Created:** 2026-07-10
> **Status:** ✅ Implemented 2026-07-10 (same session as relic-pass-failure.md). Deviations from plan: open Q1 resolved as whoosh-only for the thrower (no extra tick); Q2 resolved as amber for the incoming ring. Controller pulse + offscreen indicator remain deferred as planned.
> **Estimated scope:** one session
> **Spec source:** RELIC RELAY pass technical specification §10 ("Receiver feedback") — Andrew's design doc
> **Prerequisite state:** pass system is live (E tap/hold soft-lock pass, Bézier flight + homing, auto-catch, dummy teammates that return passes). See `apps/web/src/game/combat/passControl.ts`, `passTargeting.ts`, `ecs/systems/relicSystem.ts`, `fx/PassAimUI.tsx`.

## Problem

The spec's receiver-feedback block is unimplemented. Today a pass launches **silently and invisibly**: the thrower's aim UI (trajectory + rings in `PassAimUI.tsx`) is cleared by `resetPassAim()` the moment E is released, so the relic flies with no path shown, the receiver gets no warning, and the teammate's return pass arrives at the player with zero notice — exactly the unfairness §10 exists to prevent.

Spec items and their disposition:

| §10 item | This plan | Rationale |
|---|---|---|
| Incoming trajectory visible to receiver | **BUILD** | Meaningful now; the player receives a return pass every relay cycle |
| Catch ring contracts with time-to-impact | **BUILD** | Same |
| Soft directional chime when the pass is accepted | **BUILD** | Audio module already synthesizes everything; add stereo pan |
| Controller pulse ~150 ms before arrival | **DEFER** | No gamepad support exists anywhere in the game yet; belongs to a future input pass |
| Offscreen relic indicator (HUD arrow) | **DEFER** | Needs a HUD screen-edge system; low value while arenas are one screen and there's a single relic |

## Architecture decision: trigger feedback from game events, not call sites

`apps/web/src/game/events.ts` is the typed event queue whose header says it verbatim: *"This is the seam Phase 3 will route to the server."* The spec phrases §10 as "once the **server** accepts a pass" — so feedback must hang off an **event**, not be inlined in `passRelic()`. When netcode lands, the emit moves from local code to the server-ack handler and every feedback effect comes along for free.

Add two events:

```ts
export interface RelicPassLaunched {
  type: 'RelicPassLaunched';
  /** True when the LOCAL player is the receiver — gates receiver-side feedback. */
  toLocalPlayer: boolean;
  from: Vector3Tuple; // launch position (directional audio)
}
export interface RelicCaught {
  type: 'RelicCaught';
  byLocalPlayer: boolean;
  position: Vector3Tuple;
}
```

Emit `RelicPassLaunched` at the end of `passRelic()` and `RelicCaught` inside `catchRelic()` (both in `relicSystem.ts`). Drain in `SystemRunner`'s existing step 10 alongside `LootDropped`/`PlayerDowned`.

## Work items

### 1. In-flight trajectory (visible to everyone on the one screen)

**Where:** extend `fx/PassAimUI.tsx` (rename to `fx/PassFX.tsx` if it gets crowded) with a second render branch driven by the **relic entity**, not `passAim`.

- Query: `relics.first` where `relic.phase === 'inFlight' && relic.mode === 'pass'`. All curve inputs live on `RelicState`: `from`, `control`, `to`, `startedAt`, `flightMs`.
- Re-sample the Bézier each frame with the existing `sampleBezier()` — `to` moves during homing (last 38 % of flight), so sampling live keeps the drawn path honest.
- Render only the **remaining** path (from current `t` to 1), reusing the instanced flow-dot technique already in the file (24 dots, turquoise→amber, tapered, `MAX_DOTS` instancing). Fade all dots in over the first ~80 ms so the release doesn't pop.
- The aim-preview dots and the in-flight dots never show simultaneously (aim state resets on release) — one instanced mesh can serve both branches.

### 2. Contracting catch ring on the receiver

**Where:** same component.

- While a pass is in flight, draw a ring at the receiver's catch socket (`target.transform.position + RELIC_CATCH_SOCKET_Y`, same placement as the aim-mode lock ring).
- Radius maps to time-to-impact: `t = (gameNow() - startedAt) / flightMs`, scale from ~2.2× down to 1.0× of the base torus as t goes 0→1. Reuse the existing selected-ring torus geometry; add a second material (amber, so "incoming" reads differently from "aim lock" turquoise — spec asks not to rely on color alone, and shape does differ: contracting vs pulsing).
- On arrival the existing catch shockwave (`spawnImpactVfx` in `catchRelic`) is the terminal beat — no extra work.

### 3. Directional chime on pass launch

**Where:** `feel/audio.ts` — everything there is synthesized on one lazy `AudioContext` with a master gain (see `playHit`, `playFootstep` for the house pattern).

- New `playPassChime(pan: number)`: two short sine partials (~880 Hz + ~1320 Hz, ~120 ms exponential decay, gentle attack) through a `StereoPannerNode` → master. Soft — this fires every few seconds in normal play.
- Pan derivation (in the event drain, where camera state is accessible): direction from listener (player) to `event.from`, projected onto camera-right — `pan = clamp(dot(dir, camRight), -1, 1) * 0.8`. Camera-right on XZ is `(cos(cameraRig.yaw), -sin(cameraRig.yaw))` (already derived this way for the aim shoulder shift in `ThirdPersonCamera.tsx`).
- Fire on `RelicPassLaunched` with `toLocalPlayer === true` (receiver's warning). Optionally a quieter tick for passes *by* the player (thrower confirmation) — decide by feel in-session.
- While here, close a known gap from spec §8: the launch itself is silent. Call the existing `playWhoosh('light')` on every `RelicPassLaunched` regardless of receiver.

## Acceptance criteria

1. When the teammate returns the relic, the player sees the incoming dotted arc and an amber ring contracting on their own character, and hears a soft chime panned toward the teammate's side of the screen.
2. When the player passes, the arc + contracting ring appear on the receiving teammate.
3. No feedback fires for lob drops (G) — §10 is pass-only.
4. All effects derive from `RelicPassLaunched`/`RelicCaught` events; `passRelic()` contains no direct audio/UI calls.
5. Existing tests still pass; new unit coverage for the pan math and the event emissions (extend `relicSystem.test.ts`: assert events queued via `drainEvents()` after `passRelic`/catch).

## Verification (browser, same harness as before)

Dev server: `preview_start` name `gamedash-web` (launch.json in workdash-project `.claude/`). Drive with synthetic key events via `preview_eval` — **beware**: screenshots blur the window, which releases held keys (this fired a phantom pass during the last session). Keep hold-release-observe sequences inside a single eval. Full relay loop for reference: catch relic → set `__cameraRig.yaw` toward a teammate → hold E 450 ms → release → teammate returns after 2 s. Screenshot mid-return-flight (~300 ms window; flight is 250–650 ms) for the arc + ring; audio verified by code inspection + manual listen.

## Out of scope (tracked for later)

- **Controller pulse:** blocked on gamepad support (input layer has none).
- **Offscreen indicator:** needs a screen-edge HUD projection system; revisit with bigger arenas.
- **Perfect catch (spec §10 "Perfect catch"):** receiver-input timing window — pointless against dummies; build alongside multiplayer or give dummies a perfect-catch chance.
- **Trajectory ribbon mesh (spec §7):** flow dots stay until the pass feel is locked; a shader ribbon is polish.

## Open questions for Andrew

1. Should the *thrower* also hear a confirmation tick on launch, or only the whoosh? (Spec gives the receiver the chime; thrower feedback in §8 is thump + whoosh.)
2. Catch-ring color: plan says amber for "incoming" vs turquoise "aim lock" — match the concept art's gold energy, or keep everything turquoise?
