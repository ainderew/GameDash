import {
  createGameWorld,
  movableOf,
  mortalOf,
  pickupsOf,
  playersOf,
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

/** Render query for monsters. Replicated multiplayer monsters intentionally have no
 * `aiBrain` (the server owns AI), so this must be broader than sim's `monstersOf`. */
export const monsters = world.with('transform', 'health', 'monster');

/** Render query for projectiles. Replicated projectiles are snapshot-driven and therefore
 * carry no local `velocity`; the authoritative server still uses the stricter sim query. */
export const projectiles = world.with('transform', 'projectile');

/** Query archetype: collectible material pickups. */
export const pickups = pickupsOf(world);

/** Query archetype: anything with health (damage/death resolution). */
export const mortal = mortalOf(world);

/** Query archetype: the (single) living Relic. */
export const relics = relicsOf(world);
