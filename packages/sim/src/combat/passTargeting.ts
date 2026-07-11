import type { Entity } from '../components';
import type { Vector3Tuple } from '@shared/types';
import {
  RELIC_LEAD_S,
  RELIC_PASS_ARC_MAX,
  RELIC_PASS_ARC_MIN,
  RELIC_PASS_CONE_DEG,
  RELIC_PASS_DURATION_MAX_S,
  RELIC_PASS_DURATION_MIN_S,
  RELIC_PASS_RANGE,
  RELIC_PASS_SPEED,
  RELIC_CATCH_SOCKET_Y,
  RELIC_RELEASE_CONE_DEG,
  RELIC_SWITCH_MARGIN,
} from '@shared/balance';

/**
 * Soft auto-aim for Relic passes. Pure math over plain data — no camera, no world —
 * so every rule (cone, scoring weights, hysteresis) is unit-testable. The camera
 * communicates intent; this module picks the most likely teammate inside that intent.
 */

export interface Candidate {
  entity: Entity;
  /** Degrees off the camera-forward direction (0 = dead center). */
  angleDeg: number;
  /** XZ distance from the carrier, world units. */
  dist: number;
  /** True when the receiver faces the carrier (they're ready for it). */
  facingCarrier: boolean;
  /** False while inside their post-pass re-catch cooldown (shown hollow, unselectable). */
  eligible: boolean;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/**
 * Spec scoring: angle dominates (the camera IS the intent), distance breaks ties,
 * small readiness nudge. The resonance term keeps its slot at 0 until chains exist.
 */
export const scoreCandidate = (c: Candidate): number => {
  const angleScore = 1 - clamp01(c.angleDeg / RELIC_PASS_CONE_DEG);
  const distanceScore = 1 - clamp01(c.dist / RELIC_PASS_RANGE);
  const resonanceBonus = 0;
  const receiverReadyBonus = c.facingCarrier ? 1 : 0;
  return angleScore * 0.65 + distanceScore * 0.2 + resonanceBonus * 0.1 + receiverReadyBonus * 0.05;
};

/**
 * Pick the pass target with stickiness. The previously selected target is kept until it
 * leaves the wider release cone, becomes ineligible, or another candidate beats its score
 * by a clear margin — without this, markers flicker between teammates in a scrum.
 * `cycle` (mouse wheel steps) hard-switches to the next candidate by score order.
 */
export const selectPassTarget = (
  prev: Entity | null,
  candidates: Candidate[],
  coneDeg: number,
  cycle = 0,
): Entity | null => {
  const inCone = candidates.filter((c) => c.eligible && c.angleDeg <= coneDeg);
  if (inCone.length === 0 && !prev) return null;

  const ranked = [...inCone].sort((a, b) => scoreCandidate(b) - scoreCandidate(a));

  // Manual cycling hard-prefers the picked target: order by score, step through.
  if (cycle !== 0 && ranked.length > 0) {
    const prevIdx = ranked.findIndex((c) => c.entity === prev);
    const idx = ((prevIdx < 0 ? 0 : prevIdx + cycle) % ranked.length + ranked.length) % ranked.length;
    return ranked[idx]?.entity ?? null;
  }

  const prevCand = prev ? candidates.find((c) => c.entity === prev) : undefined;
  const prevHolds =
    prevCand !== undefined && prevCand.eligible && prevCand.angleDeg <= RELIC_RELEASE_CONE_DEG;
  const best = ranked[0];

  if (prevHolds && prevCand) {
    if (!best || best.entity === prev) return prev;
    // A challenger only steals the lock by a clear margin.
    return scoreCandidate(best) - scoreCandidate(prevCand) >= RELIC_SWITCH_MARGIN
      ? best.entity
      : prev;
  }
  return best?.entity ?? null;
};

// ── Deterministic flight (quadratic Bézier, not a physics grenade) ─────────

/** Where a receiver catches: chest socket, led slightly by their current velocity. */
export const predictCatchPos = (receiver: Entity): Vector3Tuple => {
  const p = receiver.transform!.position;
  const v = receiver.velocity?.linear ?? [0, 0, 0];
  return [
    p[0] + v[0] * RELIC_LEAD_S,
    p[1] + RELIC_CATCH_SOCKET_Y,
    p[2] + v[2] * RELIC_LEAD_S,
  ];
};

/** Arc control point: midpoint lifted by a distance-scaled height. */
export const bezierControl = (p0: Vector3Tuple, p2: Vector3Tuple): Vector3Tuple => {
  const dist = Math.hypot(p2[0] - p0[0], p2[2] - p0[2]);
  const arc = Math.min(RELIC_PASS_ARC_MAX, Math.max(RELIC_PASS_ARC_MIN, 0.55 + dist * 0.11));
  return [(p0[0] + p2[0]) / 2, (p0[1] + p2[1]) / 2 + arc, (p0[2] + p2[2]) / 2];
};

/** Flight time scales with distance inside a snappy window (250–650 ms). */
export const passDurationMs = (dist: number): number =>
  Math.min(RELIC_PASS_DURATION_MAX_S, Math.max(RELIC_PASS_DURATION_MIN_S, dist / RELIC_PASS_SPEED)) *
  1000;

/**
 * Stereo pan for a world-space sound source, from the listener's camera frame:
 * -1 = fully left, +1 = fully right. Scaled to ±0.8 so nothing sits in one ear.
 */
export const stereoPanFor = (
  listener: Vector3Tuple,
  source: Vector3Tuple,
  cameraYaw: number,
): number => {
  const dx = source[0] - listener[0];
  const dz = source[2] - listener[2];
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return 0;
  // Camera-right on XZ (same derivation as the aim shoulder shift).
  const rightX = Math.cos(cameraYaw);
  const rightZ = -Math.sin(cameraYaw);
  const dot = (dx / len) * rightX + (dz / len) * rightZ;
  return Math.min(1, Math.max(-1, dot)) * 0.8;
};

/** Evaluate the quadratic Bézier at t ∈ [0, 1], writing into `out`. */
export const sampleBezier = (
  p0: Vector3Tuple,
  p1: Vector3Tuple,
  p2: Vector3Tuple,
  t: number,
  out: Vector3Tuple,
): Vector3Tuple => {
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const c = t * t;
  out[0] = a * p0[0] + b * p1[0] + c * p2[0];
  out[1] = a * p0[1] + b * p1[1] + c * p2[1];
  out[2] = a * p0[2] + b * p1[2] + c * p2[2];
  return out;
};

/**
 * The complete, self-contained description of one relic flight (Phase 5 netcode). The
 * server computes these at release from its own predicted catch position and broadcasts
 * them in `RelicPassLaunched`; every client reconstructs the IDENTICAL arc from the params
 * alone — no per-client state, so two screens sample the same path bit-for-bit. The server
 * remains the sole arbiter of arrival (it homes + resolves the catch against LIVE positions;
 * the broadcast params are the release-time arc, and the ≤ RELIC_HOMING_MAX_CORRECTION budget
 * bounds the visual gap, folded away when `RelicCaught` snaps the relic to the catcher).
 */
export interface RelicFlightParams {
  /** 'pass' = quadratic Bézier to a receiver socket; 'lob' = parabola to a ground point. */
  mode: 'pass' | 'lob';
  from: Vector3Tuple;
  /** Bézier control point (pass); ignored for lobs. */
  control: Vector3Tuple;
  to: Vector3Tuple;
  /** Parabola peak above the from→to chord (lob); ignored for passes. */
  arcHeight: number;
  /** Sim-time (ms) the flight started — the shared clock every client samples against. */
  startedAt: number;
  flightMs: number;
}

/**
 * Position of a relic flight at sim-time `now`, written into `out`. Pure function of the
 * launch params — the single source of truth both the server's arrival check and every
 * client's render share, so a pass "looks identical on both screens" by construction.
 */
export const sampleRelicFlight = (
  p: RelicFlightParams,
  now: number,
  out: Vector3Tuple,
): Vector3Tuple => {
  const t = Math.min(1, Math.max(0, (now - p.startedAt) / (p.flightMs || 1)));
  if (p.mode === 'pass') return sampleBezier(p.from, p.control, p.to, t, out);
  // Untargeted lob: straight XZ line with a parabolic lift (matches relicSystem's lob branch).
  out[0] = p.from[0] + (p.to[0] - p.from[0]) * t;
  out[2] = p.from[2] + (p.to[2] - p.from[2]) * t;
  out[1] = p.from[1] + (p.to[1] - p.from[1]) * t + p.arcHeight * 4 * t * (1 - t);
  return out;
};
