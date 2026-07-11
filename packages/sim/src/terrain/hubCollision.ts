import type { Entity } from '../components';

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

export const resolveHubCollisions = (entity: Entity): void => {
  const transform = entity.transform;
  if (!transform) return;
  let [x, , z] = transform.position;
  const y = transform.position[1];
  const playerRadius = entity.radius ?? 0.45;

  // Landmark footprints. The lodge remains open at the front; only the rear mass and
  // structural corner posts block movement, so the player can walk into its roster bay.
  [x, z] = pushOutOfCircle(x, z, 10.5, -7.4, 1.55 + playerRadius);
  [x, z] = pushOutOfCircle(x, z, 0, -17, 1.55 + playerRadius);
  // Central campfire.
  [x, z] = pushOutOfCircle(x, z, 0, 0, 0.85 + playerRadius);
  [x, z] = pushOutOfCircle(x, z, -14.7, -8.25, 0.75 + playerRadius);
  [x, z] = pushOutOfCircle(x, z, -6.3, -8.25, 0.75 + playerRadius);

  // Lodge rear wall: clamp to the nearest face of a shallow rectangle.
  const rear = { minX: -15.1 - playerRadius, maxX: -5.9 + playerRadius, minZ: -12.3, maxZ: -10.1 + playerRadius };
  if (x > rear.minX && x < rear.maxX && z > rear.minZ && z < rear.maxZ) {
    const toLeft = x - rear.minX;
    const toRight = rear.maxX - x;
    const toFront = rear.maxZ - z;
    const min = Math.min(toLeft, toRight, toFront);
    if (min === toLeft) x = rear.minX;
    else if (min === toRight) x = rear.maxX;
    else z = rear.maxZ;
  }

  // Keep the player inside the authored clearing instead of wandering into scenery.
  const distance = Math.hypot(x, z);
  const maxRadius = 28;
  if (distance > maxRadius) {
    x = (x / distance) * maxRadius;
    z = (z / distance) * maxRadius;
  }

  transform.position = [x, y, z];
};
