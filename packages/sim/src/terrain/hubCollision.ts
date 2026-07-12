import type { Entity } from '../components';
import { HUB_CLEARING_RADIUS, HUB_LANDMARK_POSITIONS } from './hubGeometry';
import { CollisionLayer, type CollisionLayerMask } from './collisionField';
import { hubCollisionField } from './hubObstacles';

/**
 * Hub collision footprints + resolver — the SIM half of the hub layout (the visual/UX
 * half — stations, plaza dressing — stays in apps/web/src/game/world/hubLayout.ts).
 * Cheap XZ collision for the ECS-driven player: Rapier colliders alone cannot stop this
 * controller because movementSystem owns its transform directly.
 */

const pushOutOfCircle = (
  x: number,
  z: number,
  cx: number,
  cz: number,
  radius: number,
): [number, number] => {
  const dx = x - cx;
  const dz = z - cz;
  const distance = Math.hypot(dx, dz);
  if (distance >= radius) return [x, z];
  const nx = distance > 1e-4 ? dx / distance : 0;
  const nz = distance > 1e-4 ? dz / distance : 1;
  return [cx + nx * radius, cz + nz * radius];
};

/**
 * Push an entity out of the static rock/obstacle field (the scalable, data-driven half of
 * hub collision). Layer-masked so callers opt in to what blocks them. Cheap: the field's
 * spatial hash only tests rocks in the body's neighbouring cells. Used for BOTH the player
 * (below) and hub monsters (stepSim), so every solid body shares one authoritative field.
 */
export const resolveObstacleCollisions = (
  entity: Entity,
  mask: CollisionLayerMask = CollisionLayer.OBSTACLE,
): void => {
  const transform = entity.transform;
  if (!transform) return;
  const [x, y, z] = transform.position;
  const radius = entity.radius ?? 0.45;
  const [nx, nz] = hubCollisionField().resolveCircle(x, z, radius, mask);
  if (nx !== x || nz !== z) transform.position = [nx, y, nz];
};

export const resolveHubCollisions = (entity: Entity): void => {
  const transform = entity.transform;
  if (!transform) return;
  let [x, , z] = transform.position;
  const y = transform.position[1];
  const playerRadius = entity.radius ?? 0.45;

  // Landmark footprints. The lodge remains open at the front; only the rear mass and
  // structural corner posts block movement, so the player can walk into its roster bay.
  const [shrineX, shrineZ] = HUB_LANDMARK_POSITIONS.shrine;
  const [gateX, gateZ] = HUB_LANDMARK_POSITIONS.gate;
  const [lodgeX, lodgeZ] = HUB_LANDMARK_POSITIONS.lodge;
  [x, z] = pushOutOfCircle(x, z, shrineX, shrineZ, 1.55 + playerRadius);
  [x, z] = pushOutOfCircle(x, z, gateX, gateZ, 1.95 + playerRadius);
  // Central campfire.
  [x, z] = pushOutOfCircle(x, z, 0, 0, 0.85 + playerRadius);
  [x, z] = pushOutOfCircle(x, z, lodgeX - 4.2, lodgeZ + 2.25, 0.75 + playerRadius);
  [x, z] = pushOutOfCircle(x, z, lodgeX + 4.2, lodgeZ + 2.25, 0.75 + playerRadius);

  // Lodge rear wall: clamp to the nearest face of a shallow rectangle.
  const rear = {
    minX: lodgeX - 4.6 - playerRadius,
    maxX: lodgeX + 4.6 + playerRadius,
    minZ: lodgeZ - 1.8,
    maxZ: lodgeZ + 0.4 + playerRadius,
  };
  if (x > rear.minX && x < rear.maxX && z > rear.minZ && z < rear.maxZ) {
    const toLeft = x - rear.minX;
    const toRight = rear.maxX - x;
    const toFront = rear.maxZ - z;
    const min = Math.min(toLeft, toRight, toFront);
    if (min === toLeft) x = rear.minX;
    else if (min === toRight) x = rear.maxX;
    else z = rear.maxZ;
  }

  // Solid scenery rocks: push out of the data-driven obstacle field (spatial-hash broad
  // phase + circle push-out). Runs after the bespoke landmark footprints and before the
  // clearing clamp, so a rock near the perimeter still resolves, then the clamp keeps the
  // player inside the ring.
  [x, z] = hubCollisionField().resolveCircle(x, z, playerRadius, CollisionLayer.OBSTACLE);

  // Keep the player inside the authored clearing instead of wandering into scenery.
  const distance = Math.hypot(x, z);
  const maxRadius = HUB_CLEARING_RADIUS;
  if (distance > maxRadius) {
    x = (x / distance) * maxRadius;
    z = (z / distance) * maxRadius;
  }

  transform.position = [x, y, z];
};
