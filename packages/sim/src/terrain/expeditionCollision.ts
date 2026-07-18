import type { Entity } from '../components';
import { EXPEDITION_RUIN_COLLIDERS } from './expeditionRuins';

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

const pushOutOfOrientedBox = (
  x: number,
  z: number,
  cx: number,
  cz: number,
  halfX: number,
  halfZ: number,
  rotationY: number,
): [number, number] => {
  const cos = Math.cos(rotationY);
  const sin = Math.sin(rotationY);
  const dx = x - cx;
  const dz = z - cz;
  let localX = dx * cos - dz * sin;
  let localZ = dx * sin + dz * cos;
  if (Math.abs(localX) >= halfX || Math.abs(localZ) >= halfZ) return [x, z];

  const toX = halfX - Math.abs(localX);
  const toZ = halfZ - Math.abs(localZ);
  if (toX < toZ) localX = (localX < 0 ? -1 : 1) * halfX;
  else localZ = (localZ < 0 ? -1 : 1) * halfZ;

  return [cx + localX * cos + localZ * sin, cz - localX * sin + localZ * cos];
};

/** Keeps ECS-driven expedition actors out of the visible ruin structure. */
export const resolveExpeditionRuinCollisions = (entity: Entity): void => {
  const transform = entity.transform;
  if (!transform) return;
  let [x, , z] = transform.position;
  const y = transform.position[1];
  const bodyRadius = entity.radius ?? 0.45;

  for (const collider of EXPEDITION_RUIN_COLLIDERS) {
    if (collider.shape === 'circle') {
      [x, z] = pushOutOfCircle(
        x,
        z,
        collider.position[0],
        collider.position[1],
        collider.radius + bodyRadius,
      );
    } else {
      [x, z] = pushOutOfOrientedBox(
        x,
        z,
        collider.position[0],
        collider.position[1],
        collider.halfExtents[0] + bodyRadius,
        collider.halfExtents[1] + bodyRadius,
        collider.rotationY,
      );
    }
  }

  transform.position = [x, y, z];
};
