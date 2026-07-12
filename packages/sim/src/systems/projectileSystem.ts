import type { World } from 'miniplex';
import type { Entity } from '../components';
import { dealDamage } from './combatHelpers';
import { isProjectileExpired } from './weaponSystem';
import { NOOP_HOOKS, type SimHooks } from '../hooks';
import { PROJECTILE_RADIUS } from '@shared/balance';

const ARENA_LIMIT = 30;
const RELIC_KNOCKBACK_SCALE = { none: 0, light: 0.75, medium: 1.15, strong: 1.5 } as const;

/**
 * Move projectiles, resolve their sensor-style overlaps, and despawn on hit,
 * lifetime, or leaving the arena. Player projectiles hit monsters; monster
 * projectiles hit the player.
 */
export const projectileSystem = (
  world: World<Entity>,
  dt: number,
  now: number,
  hooks: SimHooks = NOOP_HOOKS,
): void => {
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
      if (p.projectileHitSet?.has(target)) continue;
      const dx = target.transform.position[0] - pos[0];
      const dz = target.transform.position[2] - pos[2];
      const reach = PROJECTILE_RADIUS + (target.radius ?? 0.5);
      if (dx * dx + dz * dz > reach * reach) continue;
      // Knockback follows the projectile's travel direction; spark spawns where it struck.
      const vlen = Math.hypot(p.velocity.linear[0], p.velocity.linear[2]) || 1;
      const hpBefore = target.health.current;
      const knockback = p.projectileKnockback ?? 'light';
      const landed = dealDamage(
        world,
        target,
        p.damage ?? 0,
        now,
        false,
        {
          attacker: p,
          strength: knockback === 'strong' ? 'heavy' : 'light',
          knockbackScale: RELIC_KNOCKBACK_SCALE[knockback],
          dir: [p.velocity.linear[0] / vlen, p.velocity.linear[2] / vlen],
          point: [pos[0], pos[1], pos[2]],
        },
        hooks,
      );
      if (!landed) continue;
      p.projectileHitSet?.add(target);
      const healed = (hpBefore - target.health.current) * (p.projectileLifestealPct ?? 0);
      const ownerHealth = p.projectileOwner?.health;
      if (healed > 0 && ownerHealth)
        ownerHealth.current = Math.min(ownerHealth.max, ownerHealth.current + healed);
      hit = true;
      if (!p.projectilePierce) break;
    }
    if (hit && !p.projectilePierce) toRemove.push(p);
  }

  for (const p of toRemove) world.remove(p);
};
