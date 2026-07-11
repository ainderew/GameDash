import type { Vector3Tuple } from '@shared/types';

/**
 * Generic snapshot-interpolation buffer: a timestamped ring of states per remote entity,
 * sampled `INTERP_DELAY_MS` in the past so motion is always a replay between two known
 * states, never a guess (the no-rubberband corollary: interpolated entities can't rubber-
 * band). Written entity-agnostic on purpose — Phase 2 feeds it hub transform relays;
 * Phase 3+ reuses it verbatim for players/monsters/projectiles from binary snapshots.
 */

export interface InterpSnapshot {
  /** Timeline timestamp, ms. Callers pick the clock (server time estimate) — the buffer
   * only requires that pushes and samples share it. */
  t: number;
  pos: Vector3Tuple;
  /** Y-axis facing, radians. */
  rotY: number;
  /** Opaque per-snapshot flags (anim bits today; dirty-field masks later). */
  flags?: number;
}

export interface InterpSample {
  pos: Vector3Tuple;
  rotY: number;
  /** Flags of the segment's newer endpoint (discrete state — never interpolated). */
  flags: number;
  /** Segment velocity, units/sec — drives remote locomotion animation speed. */
  velocity: Vector3Tuple;
}

/** Wrap an angle to (-π, π]. */
const wrapAngle = (a: number): number => {
  let r = a % (2 * Math.PI);
  if (r <= -Math.PI) r += 2 * Math.PI;
  else if (r > Math.PI) r -= 2 * Math.PI;
  return r;
};

/** Lerp between two angles along the SHORTEST arc (−170° → 170° goes 20°, not 340°). */
export const shortestArcLerp = (from: number, to: number, k: number): number =>
  wrapAngle(from + wrapAngle(to - from) * k);

const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

export class InterpBuffer {
  private entries: InterpSnapshot[] = [];

  constructor(private readonly capacity = 64) {}

  get size(): number {
    return this.entries.length;
  }

  get latest(): InterpSnapshot | null {
    return this.entries.length > 0 ? this.entries[this.entries.length - 1]! : null;
  }

  /**
   * Append a snapshot. Out-of-order arrivals older than the newest entry are dropped
   * (late relay packets must not rewind the timeline); equal timestamps overwrite.
   */
  push(snapshot: InterpSnapshot): void {
    const last = this.latest;
    if (last) {
      if (snapshot.t < last.t) return;
      if (snapshot.t === last.t) {
        this.entries[this.entries.length - 1] = snapshot;
        return;
      }
    }
    this.entries.push(snapshot);
    if (this.entries.length > this.capacity) this.entries.shift();
  }

  /**
   * Sample the state at `renderT` (typically `estimatedServerNow - INTERP_DELAY_MS`).
   * Before the first entry → holds the first; past the newest → holds the newest
   * (NO extrapolation — smoothness is bought with delay, never guesses). Null while empty.
   */
  sample(renderT: number): InterpSample | null {
    const entries = this.entries;
    if (entries.length === 0) return null;

    const first = entries[0]!;
    if (renderT <= first.t) {
      return { pos: [...first.pos], rotY: first.rotY, flags: first.flags ?? 0, velocity: [0, 0, 0] };
    }

    const last = entries[entries.length - 1]!;
    if (renderT >= last.t) {
      return { pos: [...last.pos], rotY: last.rotY, flags: last.flags ?? 0, velocity: [0, 0, 0] };
    }

    // Find the bracketing segment (linear scan from the tail — buffers are small and
    // the sample point rides near the newest entries).
    let hi = entries.length - 1;
    while (hi > 0 && entries[hi - 1]!.t > renderT) hi -= 1;
    const from = entries[hi - 1]!;
    const to = entries[hi]!;

    const dtMs = to.t - from.t;
    const k = dtMs > 0 ? (renderT - from.t) / dtMs : 1;
    const dtSec = Math.max(dtMs / 1000, 1e-6);

    return {
      pos: [
        lerp(from.pos[0], to.pos[0], k),
        lerp(from.pos[1], to.pos[1], k),
        lerp(from.pos[2], to.pos[2], k),
      ],
      rotY: shortestArcLerp(from.rotY, to.rotY, k),
      flags: to.flags ?? 0,
      velocity: [
        (to.pos[0] - from.pos[0]) / dtSec,
        (to.pos[1] - from.pos[1]) / dtSec,
        (to.pos[2] - from.pos[2]) / dtSec,
      ],
    };
  }

  /** Drop entries that can never be sampled again (older than `beforeT`, keeping one). */
  prune(beforeT: number): void {
    while (this.entries.length > 2 && this.entries[1]!.t < beforeT) this.entries.shift();
  }

  clear(): void {
    this.entries = [];
  }

  /** Velocity of the newest buffered segment, units/sec (dead-reckoning input). */
  latestVelocity(): Vector3Tuple {
    const n = this.entries.length;
    if (n < 2) return [0, 0, 0];
    const a = this.entries[n - 2]!;
    const b = this.entries[n - 1]!;
    const dtSec = Math.max((b.t - a.t) / 1000, 1e-6);
    return [
      (b.pos[0] - a.pos[0]) / dtSec,
      (b.pos[1] - a.pos[1]) / dtSec,
      (b.pos[2] - a.pos[2]) / dtSec,
    ];
  }
}

export interface UnderrunPolicy {
  /** Overrun ≤ this: hold the last snapshot (a beat of stillness beats a guess). */
  holdMs: number;
  /** Then dead-reckon on the last segment velocity for at most this long. */
  deadReckonMs: number;
}

/**
 * Buffer-underrun sampling (Phase 3, Task 5): when `renderT` runs past the newest
 * snapshot (a late/stalled snapshot stream), degrade gracefully —
 *   hold ≤ holdMs → dead-reckon on last velocity ≤ deadReckonMs → hold forever.
 * Never wild extrapolation: the dead-reckon window is bounded and velocity-linear.
 * Inside the buffered range this is exactly `buffer.sample`.
 */
export const sampleWithUnderrunPolicy = (
  buffer: InterpBuffer,
  renderT: number,
  policy: UnderrunPolicy,
): InterpSample | null => {
  const newest = buffer.latest;
  if (!newest) return null;
  const overrunMs = renderT - newest.t;
  if (overrunMs <= 0) return buffer.sample(renderT);

  const held = buffer.sample(newest.t);
  if (!held) return null;
  if (overrunMs <= policy.holdMs) return held; // phase 1: hold

  // Phase 2: dead-reckon from the hold point, capped; phase 3: hold the capped point.
  const drMs = Math.min(overrunMs - policy.holdMs, policy.deadReckonMs);
  const vel = buffer.latestVelocity();
  const dtSec = drMs / 1000;
  return {
    pos: [
      held.pos[0] + vel[0] * dtSec,
      held.pos[1] + vel[1] * dtSec,
      held.pos[2] + vel[2] * dtSec,
    ],
    rotY: held.rotY,
    flags: held.flags,
    velocity: drMs < policy.deadReckonMs ? vel : [0, 0, 0],
  };
};
