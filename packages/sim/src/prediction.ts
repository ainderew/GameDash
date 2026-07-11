import type { Vector3Tuple } from '@shared/types';
import type { Entity } from './components';
import type { GameWorld } from './world';
import type { EventQueue } from './events';
import type { PlayerIntent, SimMode } from './step';
import { stepSim } from './step';

/**
 * CLIENT-SIDE PREDICTION + RECONCILIATION for the locally-owned player (Phase 3, Task 4).
 * Headless and transport-free so the SAME module runs in the browser client and the
 * server-side bot harness — "the real prediction module over the wire".
 *
 * Model:
 *  - `predict(seq, intent, tickTimeMs)` runs stepSim for one fixed tick (the identical
 *    function the server runs — no-rubberband contract #1) and captures the post-tick
 *    state in a ring keyed by seq.
 *  - `onAuthoritative(...)` compares the server's state-at-ack-seq against the captured
 *    prediction for that seq. Within epsilon: nothing happens (the common case). Beyond:
 *    rewind the entity to the authoritative state and REPLAY every unacked cmd through
 *    stepSim, restoring present time. The caller folds the returned presentation delta
 *    into the mesh over ~100 ms — the sim state corrects instantly, the mesh never snaps
 *    (contract #4). Divergence > teleportEpsilon is an explicit teleport (spawn, zone
 *    change) and returns kind 'teleport' so the caller may hard-place the mesh.
 *  - `scheduleImpulse(seq, impulse)` injects a server-initiated force into the replay
 *    stream (contract #3): it immediately rewinds to the last authoritative state and
 *    replays with the impulse applied at its proper seq, so prediction and authority
 *    agree about the shove instead of tug-of-warring over it.
 *
 * The world passed in must be one where stepSim's chosen mode only advances THIS entity
 * (in 'hub' mode remote-player mirrors carry no `velocity`, so movement/knockback/
 * collision touch the local player alone — replay is surgical by construction).
 */

export interface AuthoritativeState {
  pos: Vector3Tuple;
  vel: Vector3Tuple;
  rotY: number;
}

interface PredictedEntry {
  seq: number;
  tickTimeMs: number;
  intent: PlayerIntent;
  /** Post-tick state — compared against the server's post-cmd state for the same seq. */
  pos: Vector3Tuple;
  vel: Vector3Tuple;
  rotY: number;
  /** Deterministic hidden state restored on rewind so replay reproduces exactly. */
  knockback?: Vector3Tuple;
  dodgingUntil?: number;
  dodgeReadyAt?: number;
  iframeUntil?: number;
  dodgeDir?: Vector3Tuple;
  jumpsUsed?: number;
}

export interface ReconcileResult {
  kind: 'clean' | 'corrected' | 'teleport';
  /** |authPos − predictedPos| at the acked seq, meters. */
  errorM: number;
  /** presentation fold-in: oldRenderPos − newSimPos (zero-length when clean). */
  presentationDelta: Vector3Tuple;
  ackSeq: number;
}

export interface PredictionOptions {
  /** Corrections below this never fire (must exceed pos quantization noise). */
  epsilonM?: number;
  /** Above this, the divergence is an explicit teleport (hard place allowed). */
  teleportEpsilonM?: number;
  ringSize?: number;
  mode?: SimMode;
}

const v3 = (v: Readonly<Vector3Tuple>): Vector3Tuple => [v[0], v[1], v[2]];

export class PredictionEngine {
  private readonly ring = new Map<number, PredictedEntry>();
  private readonly impulses = new Map<number, Vector3Tuple[]>();
  private readonly epsilonM: number;
  private readonly teleportEpsilonM: number;
  private readonly ringSize: number;
  private readonly mode: SimMode;
  private readonly intents = new Map<Entity, PlayerIntent>();

  /** Newest predicted seq (0 = nothing predicted yet). */
  headSeq = 0;
  /** Last authoritative ack we reconciled against. */
  lastAckSeq = -1;
  /** Last authoritative state (rewind anchor for impulse injection). */
  private lastAuth: { seq: number; state: AuthoritativeState } | null = null;

  constructor(
    private readonly world: GameWorld,
    private readonly events: EventQueue,
    private readonly entity: Entity,
    private readonly fixedDtSec: number,
    opts: PredictionOptions = {},
  ) {
    this.epsilonM = opts.epsilonM ?? 0.02;
    this.teleportEpsilonM = opts.teleportEpsilonM ?? 2;
    this.ringSize = opts.ringSize ?? 128;
    this.mode = opts.mode ?? 'hub';
  }

  /** Predict one fixed tick: run stepSim with this cmd's intent and capture the result. */
  predict(seq: number, intent: PlayerIntent, tickTimeMs: number): void {
    this.applyImpulsesFor(seq);
    this.stepOnce(intent, tickTimeMs);
    this.capture(seq, intent, tickTimeMs);
    this.headSeq = seq;
    if (this.ring.size > this.ringSize) {
      const oldest = Math.min(...this.ring.keys());
      this.ring.delete(oldest);
    }
  }

  /**
   * Server-initiated impulse, keyed to the seq the server applied it at. Rewinds to the
   * last authoritative state and replays so the shove lands at its true point in the
   * timeline — one smooth arc, no later correction spike.
   */
  /**
   * Returns the presentation delta (oldPos − newPos) of the immediate rewind-replay so
   * the caller can fold the late-knowledge jump into the mesh instead of snapping it.
   */
  scheduleImpulse(seq: number, impulse: Vector3Tuple): Vector3Tuple {
    // Already folded into the authoritative state we last rewound to → applying again
    // would double the shove.
    if (this.lastAuth && seq <= this.lastAuth.seq) return [0, 0, 0];
    const list = this.impulses.get(seq) ?? [];
    list.push(v3(impulse));
    this.impulses.set(seq, list);
    if (seq <= this.headSeq) {
      const before = this.entityPos();
      if (this.lastAuth && this.ring.has(this.lastAuth.seq)) {
        // Already predicted past it → rewind-and-replay from the last known-good state
        // so the shove lands at its true tick in the timeline.
        this.rewindAndReplay(this.lastAuth.seq, this.lastAuth.state);
      } else {
        // No authoritative anchor yet (pre-first-ack edge) — apply in the present.
        applyImpulse(this.entity, impulse);
      }
      const after = this.entityPos();
      return [before[0] - after[0], before[1] - after[1], before[2] - after[2]];
    }
    // Not predicted yet → predict() will consume it when that seq runs.
    return [0, 0, 0];
  }

  /**
   * An authoritative snapshot ack arrived: `state` is the server's post-cmd state for
   * `ackSeq` (captured server-side at consume time, uncontaminated by starvation coasts).
   */
  onAuthoritative(state: AuthoritativeState, ackSeq: number): ReconcileResult | null {
    if (ackSeq <= this.lastAckSeq && this.lastAckSeq !== -1) return null; // stale/duplicate
    this.lastAckSeq = ackSeq;
    this.lastAuth = { seq: ackSeq, state: { pos: v3(state.pos), vel: v3(state.vel), rotY: state.rotY } };

    const entry = this.ring.get(ackSeq);
    if (!entry) {
      // Spawn sync / ring underflow / resume: explicit teleport, replay whatever we have.
      const before = this.entityPos();
      this.rewindAndReplay(ackSeq, state);
      return {
        kind: 'teleport',
        errorM: dist(before, state.pos),
        presentationDelta: [0, 0, 0],
        ackSeq,
      };
    }

    const errorM = dist(entry.pos, state.pos);
    this.pruneAcked(ackSeq);
    if (errorM <= this.epsilonM) {
      return { kind: 'clean', errorM, presentationDelta: [0, 0, 0], ackSeq };
    }

    const before = this.entityPos();
    this.rewindAndReplay(ackSeq, state);
    const after = this.entityPos();
    if (errorM > this.teleportEpsilonM) {
      return { kind: 'teleport', errorM, presentationDelta: [0, 0, 0], ackSeq };
    }
    return {
      kind: 'corrected',
      errorM,
      presentationDelta: [before[0] - after[0], before[1] - after[1], before[2] - after[2]],
      ackSeq,
    };
  }

  reset(): void {
    this.ring.clear();
    this.impulses.clear();
    this.headSeq = 0;
    this.lastAckSeq = -1;
    this.lastAuth = null;
  }

  // ── internals ───────────────────────────────────────────────────────────────

  private stepOnce(intent: PlayerIntent, tickTimeMs: number): void {
    this.intents.clear();
    this.intents.set(this.entity, intent);
    stepSim(this.world, this.events, this.intents, this.fixedDtSec, tickTimeMs, this.mode);
  }

  private rewindAndReplay(fromSeq: number, auth: AuthoritativeState): void {
    const e = this.entity;
    if (!e.transform || !e.velocity) return;

    // Rewind: authoritative pos/vel/rot; deterministic hidden state from our own capture
    // (the server never sends timers — they derive from the cmd stream on both sides).
    e.transform.position = v3(auth.pos);
    e.transform.rotationY = auth.rotY;
    e.velocity.linear = v3(auth.vel);
    const anchor = this.ring.get(fromSeq);
    e.knockback = anchor?.knockback ? v3(anchor.knockback) : undefined;
    if (anchor) {
      e.dodgingUntil = anchor.dodgingUntil;
      e.dodgeReadyAt = anchor.dodgeReadyAt;
      e.iframeUntil = anchor.iframeUntil;
      e.dodgeDir = anchor.dodgeDir ? v3(anchor.dodgeDir) : undefined;
      e.jumpsUsed = anchor.jumpsUsed;
    }

    // Replay every unacked cmd through the SAME sim the server runs.
    for (let seq = fromSeq + 1; seq <= this.headSeq; seq += 1) {
      const entry = this.ring.get(seq);
      if (!entry) continue;
      this.applyImpulsesFor(seq);
      this.stepOnce(entry.intent, entry.tickTimeMs);
      this.capture(seq, entry.intent, entry.tickTimeMs);
    }
  }

  /** Fold pending impulses for `seq` into the entity (pre-step, mirroring the server). */
  private applyImpulsesFor(seq: number): void {
    const list = this.impulses.get(seq);
    if (!list) return;
    for (const imp of list) applyImpulse(this.entity, imp);
    // Keep them: replays re-cross this seq. Pruned together with acked ring entries.
  }

  private capture(seq: number, intent: PlayerIntent, tickTimeMs: number): void {
    const e = this.entity;
    if (!e.transform || !e.velocity) return;
    this.ring.set(seq, {
      seq,
      tickTimeMs,
      intent,
      pos: v3(e.transform.position),
      vel: v3(e.velocity.linear),
      rotY: e.transform.rotationY,
      knockback: e.knockback ? v3(e.knockback) : undefined,
      dodgingUntil: e.dodgingUntil,
      dodgeReadyAt: e.dodgeReadyAt,
      iframeUntil: e.iframeUntil,
      dodgeDir: e.dodgeDir ? v3(e.dodgeDir) : undefined,
      jumpsUsed: e.jumpsUsed,
    });
  }

  private pruneAcked(ackSeq: number): void {
    for (const key of this.ring.keys()) if (key < ackSeq) this.ring.delete(key);
    for (const key of this.impulses.keys()) if (key <= ackSeq) this.impulses.delete(key);
  }

  private entityPos(): Vector3Tuple {
    return this.entity.transform ? v3(this.entity.transform.position) : [0, 0, 0];
  }
}

/** How a wire impulse enters the sim — IDENTICAL on server and client (contract #3). */
export const applyImpulse = (e: Entity, impulse: Readonly<Vector3Tuple>): void => {
  const kb = e.knockback ?? [0, 0, 0];
  e.knockback = [kb[0] + impulse[0], kb[1], kb[2] + impulse[2]];
  if (e.velocity && impulse[1] !== 0) e.velocity.linear[1] += impulse[1];
};

const dist = (a: Readonly<Vector3Tuple>, b: Readonly<Vector3Tuple>): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
