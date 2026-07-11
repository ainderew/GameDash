import type { World } from 'miniplex';
import type { Entity } from '../components';
import type { EventQueue } from '../events';
import { REVIVE_HP_FRACTION, REVIVE_MS, REVIVE_RANGE } from '@shared/balance';

const REVIVE_RANGE_SQ = REVIVE_RANGE * REVIVE_RANGE;

/**
 * CO-OP REVIVE (Phase 4, new mechanic). A downed player (0 HP, kept in the world) is
 * brought back by a LIVING teammate holding the revive input within REVIVE_RANGE for
 * REVIVE_MS of contiguous contact. Progress resets the instant no reviver is in contact —
 * the hold must be continuous. Pure over (world, dt, now); server-authoritative.
 *
 * Runs after healthSystem so a player downed this tick is revivable next tick, and before
 * the session's all-downed HuntFailed check reads the final downed set.
 */
export const reviveSystem = (
  world: World<Entity>,
  dt: number,
  events: EventQueue,
): void => {
  const revivers = [...world.with('playerControlled', 'transform', 'health')].filter(
    (p) => !p.downed && p.reviving && p.health.current > 0,
  );
  if (revivers.length === 0) {
    // Nobody reviving anyone → every downed player's progress lapses.
    for (const d of world.with('playerControlled', 'health')) {
      if (d.downed) d.reviveProgressMs = 0;
    }
    return;
  }

  for (const d of world.with('playerControlled', 'transform', 'health')) {
    if (!d.downed) continue;
    const dp = d.transform.position;
    let inContact = false;
    for (const r of revivers) {
      if (r === d) continue;
      const rx = r.transform.position[0] - dp[0];
      const rz = r.transform.position[2] - dp[2];
      if (rx * rx + rz * rz <= REVIVE_RANGE_SQ) {
        inContact = true;
        break;
      }
    }
    if (!inContact) {
      d.reviveProgressMs = 0;
      continue;
    }
    d.reviveProgressMs = (d.reviveProgressMs ?? 0) + dt * 1000;
    if (d.reviveProgressMs >= REVIVE_MS) {
      d.downed = false;
      d.reviveProgressMs = 0;
      d.health.current = Math.max(1, Math.round(d.health.max * REVIVE_HP_FRACTION));
      events.emit({ type: 'PlayerRevived', id: d.id });
    }
  }
};
