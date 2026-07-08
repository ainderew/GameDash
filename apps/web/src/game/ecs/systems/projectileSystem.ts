import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { dealDamage } from '@/game/ecs/systems/combatHelpers';
import { isProjectileExpired } from '@/game/ecs/systems/weaponSystem';
import { PROJECTILE_RADIUS } from '@shared/balance';

const ARENA_LIMIT = 30;

/**
 * Move projectiles, resolve their sensor-style overlaps, and despawn on hit,
 * lifetime, or leaving the arena. Player projectiles hit monsters; monster
 * projectiles hit the player.
 */
export const projectileSystem = (world: World<Entity>, dt: number, now: number): void => {
  const toRemove: Entity[] = [];

  for (const p of world.with('transform', 'velocity', 'projectile')) {
    const pos = p.transform.position;
    pos[0] += p.velocity.linear[0] * dt;
    pos[1] += p.velocity.linear[1] * dt;
    pos[2] += p.velocity.linear[2] * dt;

    if (
      isProjectileExpired(p, now) ||
      Math.abs(pos[0]) > ARENA_LIMIT ||
      Math.abs(pos[2]) > ARENA_LIMIT
    ) {
      toRemove.push(p);
      continue;
    }

    const wantFaction = p.faction === 'player' ? 'monster' : 'player';
    let hit = false;
    for (const target of world.with('transform', 'health', 'faction')) {
      if (target.faction !== wantFaction) continue;
      const dx = target.transform.position[0] - pos[0];
      const dz = target.transform.position[2] - pos[2];
      const reach = PROJECTILE_RADIUS + (target.radius ?? 0.5);
      if (dx * dx + dz * dz > reach * reach) continue;
      dealDamage(world, target, p.damage ?? 0, now);
      hit = true;
      break;
    }
    if (hit) toRemove.push(p);
  }

  for (const p of toRemove) world.remove(p);
};
