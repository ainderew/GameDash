import { describe, expect, it } from 'vitest';
import type { Entity } from '../components';
import {
  bezierControl,
  passDurationMs,
  predictCatchPos,
  sampleBezier,
  scoreCandidate,
  selectPassTarget,
  stereoPanFor,
  type Candidate,
} from './passTargeting';
import {
  RELIC_CATCH_SOCKET_Y,
  RELIC_PASS_ARC_MAX,
  RELIC_PASS_ARC_MIN,
  RELIC_PASS_CONE_DEG,
  RELIC_PASS_DURATION_MAX_S,
  RELIC_PASS_DURATION_MIN_S,
} from '@shared/balance';

const ent = (): Entity => ({});

const cand = (angleDeg: number, dist: number, over: Partial<Candidate> = {}): Candidate => ({
  entity: ent(),
  angleDeg,
  dist,
  facingCarrier: false,
  eligible: true,
  ...over,
});

describe('scoreCandidate', () => {
  it('angle off camera center dominates distance', () => {
    const centered = cand(3, 14); // dead ahead but far
    const offAxis = cand(30, 4); // close but at the cone edge
    expect(scoreCandidate(centered)).toBeGreaterThan(scoreCandidate(offAxis));
  });

  it('distance breaks ties at equal angle', () => {
    expect(scoreCandidate(cand(10, 4))).toBeGreaterThan(scoreCandidate(cand(10, 14)));
  });

  it('a ready receiver outscores an identical unready one', () => {
    expect(scoreCandidate(cand(10, 8, { facingCarrier: true }))).toBeGreaterThan(
      scoreCandidate(cand(10, 8)),
    );
  });
});

describe('selectPassTarget', () => {
  it('picks the best-scored candidate in the cone and ignores ineligible ones', () => {
    const best = cand(5, 8);
    const worse = cand(20, 8);
    const cooling = cand(1, 3, { eligible: false });
    expect(selectPassTarget(null, [worse, best, cooling], RELIC_PASS_CONE_DEG)).toBe(best.entity);
  });

  it('returns null when nobody is inside the cone', () => {
    expect(selectPassTarget(null, [cand(40, 8)], RELIC_PASS_CONE_DEG)).toBeNull();
  });

  it('sticks with the previous target against a marginally better challenger', () => {
    const prev = cand(20, 8);
    const slightlyBetter = cand(14, 8);
    expect(
      selectPassTarget(prev.entity, [prev, slightlyBetter], RELIC_PASS_CONE_DEG),
    ).toBe(prev.entity);
  });

  it('switches when a challenger clearly outscores the lock', () => {
    const prev = cand(33, 14);
    const clearlyBetter = cand(2, 4);
    expect(
      selectPassTarget(prev.entity, [prev, clearlyBetter], RELIC_PASS_CONE_DEG),
    ).toBe(clearlyBetter.entity);
  });

  it('keeps the lock outside the aim cone until the release cone breaks', () => {
    const drifted = cand(44, 8); // outside 35° aim cone, inside 48° release cone
    expect(selectPassTarget(drifted.entity, [drifted], RELIC_PASS_CONE_DEG)).toBe(drifted.entity);

    const gone = cand(50, 8); // outside the release cone — lock drops
    expect(selectPassTarget(gone.entity, [gone], RELIC_PASS_CONE_DEG)).toBeNull();
  });

  it('manual cycling steps through candidates by score order', () => {
    const a = cand(2, 5);
    const b = cand(10, 5);
    const c = cand(20, 5);
    const all = [b, c, a];
    expect(selectPassTarget(a.entity, all, RELIC_PASS_CONE_DEG, 1)).toBe(b.entity);
    expect(selectPassTarget(b.entity, all, RELIC_PASS_CONE_DEG, 1)).toBe(c.entity);
    expect(selectPassTarget(c.entity, all, RELIC_PASS_CONE_DEG, 1)).toBe(a.entity); // wraps
    expect(selectPassTarget(a.entity, all, RELIC_PASS_CONE_DEG, -1)).toBe(c.entity);
  });
});

describe('flight math', () => {
  it('clamps duration into the snappy window', () => {
    expect(passDurationMs(1)).toBe(RELIC_PASS_DURATION_MIN_S * 1000);
    expect(passDurationMs(8)).toBeCloseTo(400);
    expect(passDurationMs(100)).toBe(RELIC_PASS_DURATION_MAX_S * 1000);
  });

  it('clamps arc height and lifts the midpoint', () => {
    const low = bezierControl([0, 1, 0], [0.1, 1, 0]);
    expect(low[1] - 1).toBeCloseTo(RELIC_PASS_ARC_MIN);
    const high = bezierControl([0, 1, 0], [30, 1, 0]);
    expect(high[1] - 1).toBeCloseTo(RELIC_PASS_ARC_MAX);
  });

  it('bezier hits its endpoints and arcs above the chord', () => {
    const p0: [number, number, number] = [0, 1, 0];
    const p2: [number, number, number] = [10, 1, 0];
    const p1 = bezierControl(p0, p2);
    const out: [number, number, number] = [0, 0, 0];
    expect(sampleBezier(p0, p1, p2, 0, out)).toEqual(p0);
    expect(sampleBezier(p0, p1, p2, 1, [0, 0, 0])).toEqual(p2);
    sampleBezier(p0, p1, p2, 0.5, out);
    expect(out[1]).toBeGreaterThan(1);
  });

  it('pans sound toward the source in the camera frame', () => {
    // Camera yaw 0: forward is -Z, camera-right is +X.
    expect(stereoPanFor([0, 0, 0], [5, 0, 0], 0)).toBeCloseTo(0.8); // hard right
    expect(stereoPanFor([0, 0, 0], [-5, 0, 0], 0)).toBeCloseTo(-0.8); // hard left
    expect(stereoPanFor([0, 0, 0], [0, 0, -5], 0)).toBeCloseTo(0); // dead ahead
    // Same source, camera spun 180°: left and right swap.
    expect(stereoPanFor([0, 0, 0], [5, 0, 0], Math.PI)).toBeCloseTo(-0.8);
    expect(stereoPanFor([0, 0, 0], [0, 0, 0], 0)).toBe(0); // degenerate: on the listener
  });

  it('predicts the catch socket slightly ahead of a moving receiver', () => {
    const receiver: Entity = {
      transform: { position: [0, 0, 0], rotationY: 0 },
      velocity: { linear: [4, 0, 0] },
    };
    const p = predictCatchPos(receiver);
    expect(p[0]).toBeCloseTo(0.6); // 4 u/s × 0.15 s
    expect(p[1]).toBeCloseTo(RELIC_CATCH_SOCKET_Y);
  });
});
