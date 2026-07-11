import type { TransformUpdateMessage, RelayedTransform } from '@shared/net/messages';
import {
  HUB_BOUNDS_RADIUS,
  RELAY_MAX_SPEED,
  RELAY_MAX_Y,
  RELAY_MIN_Y,
  RELAY_SPEED_TOLERANCE,
} from '@shared/net/constants';
import type { RelayTransform, SessionManager } from './session';

/**
 * ██ TEMPORARY — Phase 2 hub presence relay. ██
 *
 * Clients publish their own transforms and the server rebroadcasts them with sanity
 * clamps. This is deliberate throwaway work (02-phase plan, "Scope honesty"): Phase 3
 * replaces this ENTIRE file with the input-authoritative pipeline (binary InputCmds →
 * server stepSim → snapshots) and this module must be DELETED then, together with the
 * `transformUpdate`/`transformBatch` messages. The hub has no gameplay stakes, so
 * temporary client trust is acceptable ONLY here.
 */

/**
 * Sanity-clamp an incoming client transform against the last accepted one:
 * - horizontal displacement capped at RELAY_MAX_SPEED × elapsed × tolerance (teleports
 *   collapse to a fast walk instead of a jump-cut),
 * - XZ kept inside the hub clearing (mirror of resolveHubCollisions' outer bound),
 * - Y kept in a plausible range.
 * Pure over (prev, next, now) — unit-tested directly.
 */
export const clampRelayTransform = (
  prev: RelayTransform | null,
  next: TransformUpdateMessage,
  now: number,
): { p: [number, number, number]; r: number; a: number } => {
  let [x, y, z] = next.p;

  if (prev) {
    // Elapsed since the last ACCEPTED update; floored so a burst of packets can't multiply
    // the allowance, capped so a long gap doesn't authorize a cross-map teleport.
    const dtSec = Math.min(Math.max((now - prev.t) / 1000, 1 / 60), 0.5);
    const maxDist = RELAY_MAX_SPEED * RELAY_SPEED_TOLERANCE * dtSec;
    const dx = x - prev.p[0];
    const dz = z - prev.p[2];
    const dist = Math.hypot(dx, dz);
    if (dist > maxDist) {
      const k = maxDist / dist;
      x = prev.p[0] + dx * k;
      z = prev.p[2] + dz * k;
    }
  }

  // Hub bounds: same outer clearing clamp the sim applies (resolveHubCollisions).
  const radial = Math.hypot(x, z);
  if (radial > HUB_BOUNDS_RADIUS) {
    x = (x / radial) * HUB_BOUNDS_RADIUS;
    z = (z / radial) * HUB_BOUNDS_RADIUS;
  }

  y = Math.min(Math.max(y, RELAY_MIN_Y), RELAY_MAX_Y);

  return { p: [x, y, z], r: next.r, a: next.a };
};

/**
 * 15 Hz flush: for every session, gather transforms dirtied since the last flush and
 * send each member a batch of everyone ELSE's. Called from index.ts's relay interval.
 */
export const flushTransforms = (manager: SessionManager): void => {
  for (const session of manager.allSessions()) {
    if (session.players.size < 2) continue;

    const dirty: RelayedTransform[] = [];
    for (const player of session.players.values()) {
      const tf = player.transform;
      if (!tf?.dirty) continue;
      tf.dirty = false;
      dirty.push({ id: player.id, p: tf.p, r: tf.r, a: tf.a, t: tf.t });
    }
    if (dirty.length === 0) continue;

    for (const player of session.players.values()) {
      const transforms = dirty.filter((t) => t.id !== player.id);
      if (transforms.length > 0) player.link.send({ type: 'transformBatch', transforms });
    }
  }
};
