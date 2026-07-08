import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';
import { isInIFrames } from '@shared/combat';

const HIT_FLASH_MS = 120;
const DAMAGE_NUMBER_MS = 750;

/**
 * Apply damage to a target, respecting i-frames. Returns true if damage landed.
 * Pure over (entity, amount, now) apart from mutating the target — unit-testable.
 */
export const applyDamage = (target: Entity, amount: number, now: number): boolean => {
  if (!target.health) return false;
  if (isInIFrames(target, now)) return false;
  target.health.current = Math.max(0, target.health.current - amount);
  target.hitFlashUntil = now + HIT_FLASH_MS;
  return true;
};

/**
 * Apply damage AND spawn a floating damage number if it landed. Use this from
 * systems (which have world access); keep the pure `applyDamage` for unit tests.
 */
export const dealDamage = (
  world: World<Entity>,
  target: Entity,
  amount: number,
  now: number,
  crit = false,
): boolean => {
  const landed = applyDamage(target, amount, now);
  if (landed && target.transform) {
    world.add({
      transform: {
        position: [
          target.transform.position[0] + (((now % 7) - 3) / 6) * 0.4,
          target.transform.position[1] + 1.4,
          target.transform.position[2],
        ],
        rotationY: 0,
      },
      floatingNumber: { amount, spawnedAt: now, crit },
    });
  }
  return landed;
};

/** Age out floating damage numbers past their lifetime. */
export const floatingNumberSystem = (world: World<Entity>, now: number): void => {
  const expired: Entity[] = [];
  for (const e of world.with('floatingNumber')) {
    if (now - e.floatingNumber.spawnedAt > DAMAGE_NUMBER_MS) expired.push(e);
  }
  for (const e of expired) world.remove(e);
};

export const DAMAGE_NUMBER_LIFETIME_MS = DAMAGE_NUMBER_MS;

/** Squared XZ distance between two entities (cheap; avoids sqrt). */
export const distSqXZ = (a: Entity, b: Entity): number => {
  const ap = a.transform?.position;
  const bp = b.transform?.position;
  if (!ap || !bp) return Infinity;
  const dx = ap[0] - bp[0];
  const dz = ap[2] - bp[2];
  return dx * dx + dz * dz;
};
