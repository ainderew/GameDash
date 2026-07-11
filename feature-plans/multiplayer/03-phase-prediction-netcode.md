# Phase 3 — Authoritative Movement: Prediction, Reconciliation, Snapshots

> **Goal:** the server runs the sim; clients send only inputs. Your own character feels 100 % local (prediction), everyone else is smooth (interpolation), and nobody rubber-bands at 150 ms simulated ping. This phase is the heart of "minimize de-sync, delay, and lag."
>
> **Depends on:** Phases 1–2. **Blocks:** 4, 5. Replaces Phase 2's transform relay.

## Tasks

### Task 1: Input command pipeline
- **File:** `packages/shared/src/net/input.ts` — `InputCmd { seq, clientTick, moveX, moveZ (quantized int8), buttons: u16 bitmask (jump|sprint|dodge|melee|ranged|parry|passHold|drop), aimYaw: u16, passTargetId?: u16 }` + codec.
- Client (`apps/web/src/net/inputSender.ts`): each fixed client tick, capture the intent `SystemRunner` already builds (camera-relative move vector, SystemRunner.tsx:94-106 — send the *rotated* vector so the server never needs camera state) + edge-triggered actions; send batched (**last 3 cmds per packet** — a single lost packet costs nothing; no-rubberband contract #2); buffer unacked cmds for replay.
- Server: per-player input queue with de-dup by seq, **adaptive jitter buffer** (target 1–2 cmds ahead; grows on measured arrival jitter, shrinks slowly — never trades a late packet for a retroactive correction); on starvation coast on last movement cmd (actions stripped); clamp magnitudes. Starvation must *never* rewrite already-simulated ticks.

### Task 2: Server-side authoritative stepping
- `apps/realtime/src/session.ts`: drive `stepSim(world, events, intentsByPlayer, dtFixed, now, mode, noopHooks)` at 30 Hz (`setInterval` + drift-corrected accumulator). Hub mode = movement + hub collisions only (the sim's existing hub early-out, SystemRunner behavior now inside `stepSim`).
- Delete the Phase 2 transform relay path; server now *rejects* client transforms entirely.
- Record per-tick `lastProcessedSeq` per player (for reconciliation) and a **position history ring buffer** (last 8 ticks ≈ 266 ms) per hittable entity — consumed by Phase 4 lag-comp.

### Task 3: Snapshot pipeline (binary)
- **File:** `packages/shared/src/net/snapshot.ts` — flat binary codec (DataView): header `{ serverTick, serverTimeMs, yourLastProcessedSeq }`, then per-entity records with a **dirty mask** (only changed fields since that client's last acked snapshot; full baseline on join/keyframe every 2 s). Quantization: position int16 centimeters (world ≪ 300 m), rotY uint8, hp uint16, velocity int16 mm/s (velocity included for interpolation quality on remotes).
- Round-trip property tests (encode→decode = identity within quantization epsilon); byte-budget test: 4 players + 60 monsters + projectiles ≤ ~1.5 KB/snapshot ⇒ ≤ 30 KB/s ≈ 240 kbps worst case, typical ≪ 100 kbps with dirty masks.
- Server broadcasts at 20 Hz per client (unacked-delta or simple "delta vs last keyframe" — pick simplest correct: delta vs last *acked*, fall back to keyframe).

### Task 4: Client prediction + reconciliation (local player)
- **File:** `apps/web/src/net/prediction.ts`:
  - Client runs `applyPlayerIntent` + movement integration for the local player every fixed tick immediately (this is already what happens locally — unchanged feel).
  - On snapshot: read authoritative local-player state; compare with the predicted state stored for `yourLastProcessedSeq`. If divergence > epsilon (1–2 cm / small angle): rewind local entity to server state, **replay all unacked InputCmds** through `applyPlayerIntent` + integrate (pure functions from `@friendslop/sim` — same code the server ran), restoring present-time position.
  - **Error smoothing:** never snap the mesh — fold residual correction in over ~80–120 ms (position lerp on the presentation transform, not the sim transform). Hard snaps are banned by the no-rubberband contract (#4); the only exception is a genuine teleport event (zone change, respawn), which is explicit.
  - **Server-impulse replay (no-rubberband contract #3):** server-initiated forces on the local player (knockback, stagger, catch-shockwave push) arrive as sequenced `ServerImpulse { tick, entityId, impulse }` events. The client applies them immediately on receipt AND stores them in the replay stream keyed by tick, so subsequent reconciliation replays them alongside inputs — prediction and authority agree about the shove instead of tug-of-warring over it.
  - Predicted state ring buffer keyed by seq; unit tests: scripted input + delayed authoritative echoes converge to zero error; forced server nudge reconciles without overshoot; **impulse-during-movement test:** knockback at tick N while strafing produces one smooth arc, zero correction spikes.
- Dodge/jump/i-frame timers predict fine (deterministic from inputs); server remains authority on their outcomes.
- **Divergence telemetry:** every reconciliation correction > epsilon logs (seq, magnitude, cause-class). The Phase 3 exit review requires: on a clean simulated link, corrections ≈ 0/min; at 1 % loss, corrections stay < 1/min and every one is sub-perceptual (< 10 cm folded over 100 ms). Anything above is a bug in sim parity, not a tuning knob.

### Task 5: Remote entity interpolation (finalize)
- Reuse `sim/src/interp.ts` from Phase 2 for remote players + (Phase 4) monsters/projectiles, now fed by snapshots. Sample at `estimatedServerTime - INTERP_DELAY_MS (100)`.
- **Clock sync hardening:** ping/pong → offset EWMA with outlier rejection; adaptive interp delay (grow to p95 snapshot inter-arrival + jitter margin, shrink slowly).
- Buffer underrun policy: brief hold-last-frame ≤ 100 ms, then dead-reckon on last velocity ≤ 150 ms, then hold (never wild extrapolation).

### Task 6: Network condition harness + debug overlay
- **Dev latency simulator** in the client `Transport` wrapper: artificial delay/jitter/loss (e.g. `?net=150ms±30,loss1%` query param) so every later phase is developed *at* 150 ms, not at localhost-zero. Optional: `apps/realtime` mirror flag for asymmetric testing.
- **Debug overlay** (`apps/web/src/ui/NetDebugOverlay.tsx`, toggle F3): ping, offset, interp delay, snapshot rate, reconciliation corrections/s + magnitude, bytes in/out. Corrections/s is the phase's KPI — near-zero on clean links.
- **Headless bot client** (`apps/realtime/src/bot.ts`): Node client that joins a session and runs scripted inputs — used for convergence integration tests (server pos vs bot predicted pos within epsilon) and later load tests.

### Task 7: Cut over the hub, keep solo intact
- Multiplayer sessions (hub included) now run fully input-authoritative. Solo play keeps the local `stepSim` path with no transport — same sim, no server. `SystemRunner` gets a `driver: 'local' | 'networked'` split; keep the branch small and explicit.

## Acceptance criteria
- At simulated 150 ms ± 30 ms, 1 % loss: own movement feels indistinguishable from solo (no added input latency); remote players glide with no teleports; reconciliation corrections < 1/min during normal running.
- Speed-hack attempt (modified client sending >max move) is fully ignored — position is server-derived, sanity-clamped inputs only.
- Codec round-trip + byte-budget tests green; bot convergence test green in CI.

## Risks
- **Float nondeterminism between replays** — mitigated: reconciliation replays on the *same machine* (client replaying its own prediction), so cross-platform determinism is NOT required; only server-authoritative snapshots cross machines.
- **`applyPlayerIntent` hidden inputs** (e.g. terrain `heightAt` — fine, pure; camera yaw — solved by sending rotated vectors).
- **TCP head-of-line stalls on loss spikes** — bounded by small packets + 20 Hz cadence + underrun policy; if it still bites, the `Transport` interface is where WebTransport lands (documented, not built).
