import {
  createGameWorld,
  movableOf,
  monstersOf,
  mortalOf,
  pickupsOf,
  playersOf,
  projectilesOf,
  relicsOf,
} from '@sim/world';
import { EventQueue } from '@sim/events';

/**
 * The CLIENT's single ECS world instance + event queue for the running game session.
 * The sim itself is per-instance (`createGameWorld` — the room server makes one per
 * session); the client simply owns one for its whole lifetime. Renderers import the
 * memoized queries below exactly as before the sim extraction.
 */
export const world = createGameWorld();

/** The client's per-world event queue, drained once per tick by stepSim (SystemRunner). */
export const events = new EventQueue();

// Dev-only console handle (same pattern as window.__scene / __cameraRig) so tooling
// can poke entities — e.g. deal damage from the console to exercise combat visuals.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __world?: typeof world }).__world = world;
}

/** Query archetype: everything that moves. */
export const movable = movableOf(world);

/** Query archetype: every player-controlled entity (ours or, later, remote). */
export const players = playersOf(world);

/** Query archetype: THE locally-owned player entity (HUD, camera, input). */
export const localPlayers = world.with('transform', 'velocity', 'playerControlled', 'localPlayer');

/** Query archetype: living monsters. */
export const monsters = monstersOf(world);

/** Query archetype: in-flight projectiles. */
export const projectiles = projectilesOf(world);

/** Query archetype: collectible material pickups. */
export const pickups = pickupsOf(world);

/** Query archetype: anything with health (damage/death resolution). */
export const mortal = mortalOf(world);

/** Query archetype: the (single) living Relic. */
export const relics = relicsOf(world);
