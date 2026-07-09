import type { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';

/**
 * Age out impact VFX (spark bursts / shockwave rings). Driven by REAL time so they play
 * to completion and clean up even while the sim is frozen for hitstop.
 */
export const impactFxSystem = (world: World<Entity>, realNow: number): void => {
  const expired: Entity[] = [];
  for (const e of world.with('impactFx')) {
    if (realNow - e.impactFx.spawnedAtReal > e.impactFx.lifetimeMs) expired.push(e);
  }
  for (const e of expired) world.remove(e);
};
