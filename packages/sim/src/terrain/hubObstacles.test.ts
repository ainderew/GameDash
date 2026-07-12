import { describe, expect, it } from 'vitest';
import {
  buildHubRockObstacles,
  hubCollisionField,
  ROCK_MIN_COLLIDER_RADIUS,
} from './hubObstacles';
import { CollisionLayer } from './collisionField';
import { HUB_CLEARING_RADIUS } from './hubGeometry';

describe('buildHubRockObstacles', () => {
  it('is deterministic — identical footprints every rebuild (netcode: server === client)', () => {
    expect(buildHubRockObstacles()).toEqual(buildHubRockObstacles());
  });

  it('produces solid rocks: all on the OBSTACLE layer, all above the min footprint', () => {
    const rocks = buildHubRockObstacles();
    expect(rocks.length).toBeGreaterThan(0);
    for (const r of rocks) {
      expect(r.layer).toBe(CollisionLayer.OBSTACLE);
      expect(r.radius).toBeGreaterThanOrEqual(ROCK_MIN_COLLIDER_RADIUS);
      expect(Number.isFinite(r.x) && Number.isFinite(r.z)).toBe(true);
    }
  });

  it('places at least one collidable rock inside the reachable clearing', () => {
    // If every rock sat beyond the clearing clamp the player could never touch one — the
    // feature would be inert. At least one must be reachable (hypot < clearing radius).
    const reachable = buildHubRockObstacles().filter(
      (r) => Math.hypot(r.x, r.z) < HUB_CLEARING_RADIUS,
    );
    expect(reachable.length).toBeGreaterThan(0);
  });

  it('hubCollisionField caches one field over the baked obstacles', () => {
    expect(hubCollisionField()).toBe(hubCollisionField());
    expect(hubCollisionField().obstacles.length).toBe(buildHubRockObstacles().length);
  });
});
