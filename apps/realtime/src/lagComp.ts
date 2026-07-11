import type { Vector3Tuple } from '@shared/types';
import { MS_PER_TICK } from '@shared/net/constants';
import { NET_LAGCOMP_MAX_MS } from '@shared/balance';
import type { Entity } from '@sim/components';
import type { MeleeRewind } from '@sim/systems/weaponSystem';

/**
 * MELEE LAG COMPENSATION (Phase 4, Task 3).
 *
 * The attacker's own avatar is authoritative at the tick their melee cmd is consumed, so it
 * is NEVER rewound (favor-the-attacker). The HITTABLE entities — monsters — are rewound to
 * WHAT THE ATTACKER SAW: their position at the attacker's interpolated view tick, read from
 * an 8-tick position-history ring (the Phase 3 ring, now recorded for monsters too). The
 * server then runs the SAME pure arc test the sim uses (`weaponSystem`'s broad phase) with a
 * small `NET_MELEE_PAD` tolerance, so a swing that visually connected on a 150 ms link lands,
 * while a 250 ms-stale swing clamps to the ≤ 200 ms rewind bound and legitimately misses.
 *
 * Anti-cheat is structural: the server received only inputs. A tampered client cannot mark a
 * monster hit — the arc test decides — and cannot rewind past a monster's death (a monster
 * dead more than one tick before the view tick is unhittable, so a stale swing never
 * resurrects a corpse for a kill claim).
 */

export interface HistorySample {
  tick: number;
  pos: Vector3Tuple;
}

export const NET_LAGCOMP_MAX_TICKS = Math.round(NET_LAGCOMP_MAX_MS / MS_PER_TICK);

/**
 * Position of an entity as of `viewTick`, from its history ring. Picks the newest sample at
 * or before `viewTick`; clamps to the oldest retained sample when the view predates the ring
 * (the ring only holds ~8 ticks). Returns null only for an empty ring.
 */
export const rewindPos = (
  history: readonly HistorySample[],
  viewTick: number,
): Vector3Tuple | null => {
  if (history.length === 0) return null;
  let chosen: HistorySample | null = null;
  for (const s of history) {
    if (s.tick <= viewTick && (!chosen || s.tick > chosen.tick)) chosen = s;
  }
  // View older than everything we kept → clamp to the oldest sample.
  if (!chosen) {
    let oldest = history[0]!;
    for (const s of history) if (s.tick < oldest.tick) oldest = s;
    chosen = oldest;
  }
  return [chosen.pos[0], chosen.pos[1], chosen.pos[2]];
};

/** Convert a client's view time (ms on the server timeline) into a tick to rewind to. */
export const viewTickFromMs = (viewServerTimeMs: number): number =>
  Math.round(viewServerTimeMs / MS_PER_TICK);

export interface LagCompContext {
  /** Current authoritative server tick. */
  currentTick: number;
  /** entityId → position history ring (living monsters, recorded each tick). */
  history: ReadonlyMap<number, HistorySample[]>;
  /** entityId → server tick the monster died at (kept briefly after removal). */
  deathTick: ReadonlyMap<number, number>;
  /** attacker entityId → the view tick recorded when its current swing started. */
  viewTickOf: (attackerId: number) => number | undefined;
}

/**
 * Build the rewind resolver injected into `weaponSystem` on the room server. For each
 * candidate monster it returns the (rewound) position to test the arc against, or null to
 * SKIP the target (dead too long ago to have been hittable from the attacker's view).
 */
export const makeMeleeRewind = (ctx: LagCompContext): MeleeRewind => {
  const { currentTick, history, deathTick, viewTickOf } = ctx;
  const minTick = currentTick - NET_LAGCOMP_MAX_TICKS;
  return (target: Entity, attacker: Entity): Vector3Tuple | null => {
    const rawView = viewTickOf(attacker.id ?? -1) ?? currentTick;
    // Clamp the rewind to the ring/policy window — a swing can't reach further into the past.
    const viewTick = Math.max(minTick, Math.min(currentTick, rawView));
    const targetId = target.id;
    if (targetId !== undefined) {
      const died = deathTick.get(targetId);
      // Dead more than one tick before what the attacker saw → not hittable (no corpse kill).
      if (died !== undefined && died < viewTick - 1) return null;
      const ring = history.get(targetId);
      if (ring) return rewindPos(ring, viewTick) ?? (target.transform?.position ?? null);
    }
    return target.transform?.position ?? null;
  };
};
