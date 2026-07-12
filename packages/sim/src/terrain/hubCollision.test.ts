import { describe, expect, it } from 'vitest';
import type { Entity } from '../components';
import { resolveHubCollisions, resolveObstacleCollisions } from './hubCollision';
import { HUB_CLEARING_RADIUS, HUB_LANDMARK_POSITIONS } from './hubGeometry';
import { buildHubRockObstacles, hubCollisionField } from './hubObstacles';
import { CollisionLayer } from './collisionField';

const playerAt = (x: number, z: number): Entity => ({
  transform: { position: [x, 0, z], rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  playerControlled: true,
  radius: 0.45,
});

const monsterAt = (x: number, z: number): Entity => ({
  transform: { position: [x, 0, z], rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  monster: 'chaser',
  radius: 0.5,
});

describe('resolveHubCollisions', () => {
  it('pushes the player out of the shrine footprint', () => {
    const player = playerAt(...HUB_LANDMARK_POSITIONS.shrine);
    resolveHubCollisions(player);
    const position = player.transform!.position;
    expect(
      Math.hypot(
        position[0] - HUB_LANDMARK_POSITIONS.shrine[0],
        position[2] - HUB_LANDMARK_POSITIONS.shrine[1],
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  it('keeps the player inside the authored clearing', () => {
    const player = playerAt(100, 0);
    resolveHubCollisions(player);
    const position = player.transform!.position;
    expect(Math.hypot(position[0], position[2])).toBeCloseTo(HUB_CLEARING_RADIUS);
  });

  // A body walking into a rock is pushed clear of THAT rock along the contact normal (the
  // realistic case — bodies approach from outside and resolve every frame). We nudge it just
  // inside the rim so the normal is well defined, then assert it ends on/outside the surface.
  const clearOf = (rx: number, rz: number, rRadius: number, x: number, z: number, bodyR: number) =>
    Math.hypot(x - rx, z - rz) >= rRadius + bodyR - 1e-6;

  it('pushes the player out of a solid scenery rock', () => {
    const rock = buildHubRockObstacles().find((r) => Math.hypot(r.x, r.z) < HUB_CLEARING_RADIUS - 3)!;
    const player = playerAt(rock.x + rock.radius * 0.3, rock.z);
    resolveHubCollisions(player);
    const [x, , z] = player.transform!.position;
    expect(clearOf(rock.x, rock.z, rock.radius, x, z, player.radius!)).toBe(true);
  });

  it('pushes a monster out of a solid rock too (shared obstacle field)', () => {
    const rock = buildHubRockObstacles().find((r) => Math.hypot(r.x, r.z) < HUB_CLEARING_RADIUS - 3)!;
    const monster = monsterAt(rock.x + rock.radius * 0.3, rock.z);
    resolveObstacleCollisions(monster, CollisionLayer.OBSTACLE);
    const [x, , z] = monster.transform!.position;
    expect(clearOf(rock.x, rock.z, rock.radius, x, z, monster.radius!)).toBe(true);
  });
});
