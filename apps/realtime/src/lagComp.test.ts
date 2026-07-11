import { describe, expect, it } from 'vitest';
import { MELEE_RANGE } from '@shared/balance';
import { meleeArcHit } from '@sim/systems/weaponSystem';
import type { Entity } from '@sim/components';
import {
  makeMeleeRewind,
  rewindPos,
  NET_LAGCOMP_MAX_TICKS,
  type HistorySample,
} from './lagComp';

/**
 * Lag-comp unit coverage (Phase 4, Task 3):
 *  - a 150 ms-stale swing at a strafing monster the attacker saw in his crosshair LANDS;
 *  - the same swing 250 ms stale MISSES (rewind clamps to the ≤200 ms policy window);
 *  - a monster dead more than one tick before the view is NEVER hittable (no corpse kills).
 */

// Attacker at the origin facing +Z. Its swing cone points down +Z.
const attackerPos = [0, 0, 0] as const;
const FX = Math.sin(0); // 0
const FZ = Math.cos(0); // 1
const COS_HALF_ARC = Math.cos(Math.PI / 3);
const PAD = 0.35;

const arcHits = (pos: readonly [number, number, number]): boolean =>
  meleeArcHit(attackerPos, FX, FZ, COS_HALF_ARC, MELEE_RANGE, pos, 0.5, PAD) !== null;

// A synthetic strafe: the monster crosses through the crosshair at tick 5, is out of reach
// both earlier (tick 4) and later/present (tick 10). currentTick = 10.
const CURRENT_TICK = 10;
const strafeRing: HistorySample[] = [
  { tick: 4, pos: [4, 0, 2] }, // 250 ms-stale view clamps here → out of range
  { tick: 5, pos: [0, 0, 2] }, // 150 ms-stale view → in the crosshair
  { tick: 6, pos: [0.5, 0, 2] },
  { tick: 7, pos: [1.2, 0, 2] },
  { tick: 8, pos: [2.2, 0, 2] },
  { tick: 9, pos: [3, 0, 2] },
  { tick: 10, pos: [3.4, 0, 2] }, // present → the monster has run past the arc
];

const monster = (id: number): Entity => ({ id, transform: { position: [3.4, 0, 2], rotationY: 0 } });
const attacker = (): Entity => ({ id: 99, transform: { position: [0, 0, 0], rotationY: 0 } });

describe('lag compensation', () => {
  it('rewindPos picks the newest sample at or before the view tick, clamping old views', () => {
    expect(rewindPos(strafeRing, 5)).toEqual([0, 0, 2]);
    expect(rewindPos(strafeRing, 7)).toEqual([1.2, 0, 2]);
    // Older than the ring → clamp to the oldest retained sample.
    expect(rewindPos(strafeRing, 1)).toEqual([4, 0, 2]);
    expect(rewindPos([], 5)).toBeNull();
  });

  it('a 150 ms-stale swing at the strafing monster LANDS (rewound to the crosshair)', () => {
    const rewind = makeMeleeRewind({
      currentTick: CURRENT_TICK,
      history: new Map([[1, strafeRing]]),
      deathTick: new Map(),
      viewTickOf: () => 5, // 150 ms behind at 30 Hz
    });
    const testPos = rewind(monster(1), attacker(), 0);
    expect(testPos).toEqual([0, 0, 2]);
    expect(arcHits(testPos!)).toBe(true);
    // Sanity: without rewind (present position) the same swing would whiff.
    expect(arcHits([3.4, 0, 2])).toBe(false);
  });

  it('the SAME swing 250 ms stale MISSES: the rewind clamps to ≤200 ms and lands out of arc', () => {
    // 250 ms ≈ 7.5 ticks behind → tick 2.5, but the clamp floors the view at currentTick−6.
    const rewind = makeMeleeRewind({
      currentTick: CURRENT_TICK,
      history: new Map([[1, strafeRing]]),
      deathTick: new Map(),
      viewTickOf: () => CURRENT_TICK - 8, // deliberately older than the policy window
    });
    const testPos = rewind(monster(1), attacker(), 0);
    // Clamped to currentTick − NET_LAGCOMP_MAX_TICKS = tick 4 → (4,0,2), out of range.
    expect(testPos).toEqual(strafeRing.find((s) => s.tick === CURRENT_TICK - NET_LAGCOMP_MAX_TICKS)!.pos);
    expect(arcHits(testPos!)).toBe(false);
  });

  it('never resurrects a monster dead more than one tick before the view', () => {
    const rewind = makeMeleeRewind({
      currentTick: CURRENT_TICK,
      history: new Map([[2, strafeRing]]),
      deathTick: new Map([[2, 4]]), // died at tick 4
      viewTickOf: () => 6, // view 6: died (4) < 6−1 = 5 → too dead → skip
    });
    expect(rewind(monster(2), attacker(), 0)).toBeNull();

    // Within one tick of the view, the hit still counts (favor-the-attacker on the frame).
    const freshRewind = makeMeleeRewind({
      currentTick: CURRENT_TICK,
      history: new Map([[2, strafeRing]]),
      deathTick: new Map([[2, 4]]),
      viewTickOf: () => 5, // died (4) < 5−1 = 4 is false → hittable
    });
    expect(freshRewind(monster(2), attacker(), 0)).toEqual([0, 0, 2]);
  });
});
