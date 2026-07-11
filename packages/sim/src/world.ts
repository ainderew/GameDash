import { World } from 'miniplex';
import type { Entity } from './components';
import { createSpawnState, type SpawnState } from './systems/spawnSystem';

/**
 * The ECS world, one per running game session. Was a module singleton; now a factory so
 * the room server can run one isolated world per session while the client keeps a single
 * instance (see apps/web/src/game/ecs/world.ts, which also owns the dev `window.__world`
 * handle — DOM stays out of this package).
 */
export class GameWorld extends World<Entity> {
  /** Wave/spawn progression — per-world so sessions can't bleed into each other. */
  readonly spawn: SpawnState = createSpawnState();

  private nextEntityId = 1;

  /**
   * Adds an entity, stamping a stable per-world numeric id. Object refs can't cross the
   * wire — snapshots and events address entities by `entity.id`.
   */
  override add<D extends Entity>(entity: D): D & Entity {
    if (entity.id === undefined) entity.id = this.nextEntityId++;
    return super.add(entity);
  }
}

export const createGameWorld = (): GameWorld => new GameWorld();

// ── Query archetypes ─────────────────────────────────────────────────────────
// miniplex memoizes queries per world, so these helpers are cheap to call every tick.

/** Everything that moves. */
export const movableOf = (world: World<Entity>) => world.with('transform', 'velocity');

/** Every player-controlled entity (any human — local or remote). */
export const playersOf = (world: World<Entity>) =>
  world.with('transform', 'velocity', 'playerControlled');

/** Living monsters. */
export const monstersOf = (world: World<Entity>) =>
  world.with('transform', 'health', 'aiBrain', 'monster');

/** In-flight projectiles. */
export const projectilesOf = (world: World<Entity>) =>
  world.with('transform', 'velocity', 'projectile');

/** Collectible material pickups. */
export const pickupsOf = (world: World<Entity>) => world.with('transform', 'pickup');

/** Anything with health (damage/death resolution). */
export const mortalOf = (world: World<Entity>) => world.with('health');

/** The (single) living Relic. */
export const relicsOf = (world: World<Entity>) => world.with('transform', 'relic');
