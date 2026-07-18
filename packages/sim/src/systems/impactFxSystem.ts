import type { World } from 'miniplex';
import type { Entity } from '../components';

/**
 * Age out impact VFX (spark bursts / shockwave rings). Driven by REAL time so they play
 * to completion and clean up even while the sim is frozen for hitstop.
 */
export const impactFxSystem = (world: World<Entity>, realNow: number): void => {
  const expired = new Set<Entity>();
  for (const e of world.with('impactFx')) {
    if (realNow - e.impactFx.spawnedAtReal > e.impactFx.lifetimeMs) expired.add(e);
  }
  // Blender flipbooks use a separate client-only marker but share the same real-time lifetime.
  // Removing these entities matters even after their pooled quad is released: otherwise every
  // sword hit remains indexed in the ECS for the rest of the session.
  for (const e of world.with('blenderImpactFx')) {
    if (realNow - e.blenderImpactFx.spawnedAtReal > e.blenderImpactFx.lifetimeMs) expired.add(e);
  }
  for (const e of expired) world.remove(e);
};
