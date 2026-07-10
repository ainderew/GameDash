import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { carriedRelicOf, passRelic } from '@/game/ecs/systems/relicSystem';

/** Teammate patrol speed (walk-ish), world units/sec. */
export const TEAMMATE_SPEED = 2.2;
/** How long a teammate holds the Relic before passing it back to the player, ms. */
export const TEAMMATE_RETURN_HOLD_MS = 2000;

const isDead = (e: Entity): boolean => (e.health?.current ?? 1) <= 0;

/**
 * Stand-in behavior for other players until netcode lands: teammates patrol between two
 * points so passes must lead a moving receiver, and when one catches the Relic it plants,
 * faces the player, and passes back after a short hold — a solo-testable relay loop.
 */
export const teammateSystem = (world: World<Entity>, now: number): void => {
  for (const mate of world.with('teammate', 'transform', 'velocity')) {
    if (isDead(mate)) {
      mate.velocity.linear[0] = 0;
      mate.velocity.linear[2] = 0;
      continue;
    }

    if (carriedRelicOf(world, mate)) {
      // Holding the Relic: plant, face the player, return the pass after the hold.
      mate.velocity.linear[0] = 0;
      mate.velocity.linear[2] = 0;
      const player = world.with('playerControlled', 'transform').first;
      if (!player?.transform) continue;
      const dx = player.transform.position[0] - mate.transform.position[0];
      const dz = player.transform.position[2] - mate.transform.position[2];
      if (dx * dx + dz * dz > 1e-4) mate.transform.rotationY = Math.atan2(dx, dz);
      if (now - (mate.relicHeldSince ?? now) >= TEAMMATE_RETURN_HOLD_MS && !isDead(player)) {
        passRelic(world, mate, player, now);
      }
      continue;
    }

    const patrol = mate.patrol;
    if (!patrol) continue;
    const goal = patrol.toB ? patrol.b : patrol.a;
    const dx = goal[0] - mate.transform.position[0];
    const dz = goal[1] - mate.transform.position[2];
    const dist = Math.hypot(dx, dz);
    if (dist < 0.25) {
      patrol.toB = !patrol.toB;
      mate.velocity.linear[0] = 0;
      mate.velocity.linear[2] = 0;
      continue;
    }
    mate.velocity.linear[0] = (dx / dist) * TEAMMATE_SPEED;
    mate.velocity.linear[2] = (dz / dist) * TEAMMATE_SPEED;
    mate.transform.rotationY = Math.atan2(dx, dz);
  }
};
