import { World } from 'miniplex';
import type { Entity } from '@/game/ecs/components';

/** The single ECS world for the running game session. */
export const world = new World<Entity>();

/** Query archetype: everything that moves. */
export const movable = world.with('transform', 'velocity');

/** Query archetype: the player. */
export const players = world.with('transform', 'velocity', 'playerControlled');

/** Query archetype: living monsters. */
export const monsters = world.with('transform', 'health', 'aiBrain', 'monster');

/** Query archetype: in-flight projectiles. */
export const projectiles = world.with('transform', 'velocity', 'projectile');

/** Query archetype: collectible material pickups. */
export const pickups = world.with('transform', 'pickup');

/** Query archetype: anything with health (damage/death resolution). */
export const mortal = world.with('health');
