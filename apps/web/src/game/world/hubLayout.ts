import type { Entity } from '@/game/ecs/components';

export type HubStationId = 'roster' | 'summoning' | 'expedition';

export interface HubStation {
  id: HubStationId;
  title: string;
  description: string;
  position: readonly [number, number];
  radius: number;
  action?: string;
}

/** The hub is deliberately compact: every permanent verb is visible from spawn. */
export const HUB_STATIONS: readonly HubStation[] = [
  {
    id: 'roster',
    title: 'Roster Lodge',
    description: 'Choose who leads the next expedition.',
    position: [-10.5, -5.8],
    radius: 4.2,
    action: 'Switch adventurer',
  },
  {
    id: 'summoning',
    title: 'Summoning Shrine',
    description: 'Recruitment unlocks after expedition rewards are connected.',
    position: [10.5, -7.4],
    radius: 3.1,
  },
  {
    id: 'expedition',
    title: 'Expedition Gate',
    description: 'Leave the haven and begin the current combat run.',
    position: [0, -14.4],
    radius: 3.2,
    action: 'Begin expedition',
  },
] as const;

export const HUB_SPAWN: readonly [number, number, number] = [0, 0, 11.5];

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
 * Cheap XZ collision for the ECS-driven player. Rapier colliders alone cannot stop this
 * controller because movementSystem owns its transform directly.
 */
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

export const nearestHubStation = (x: number, z: number): HubStation | undefined => {
  let nearest: HubStation | undefined;
  let nearestDistance = Infinity;
  for (const station of HUB_STATIONS) {
    const distance = Math.hypot(x - station.position[0], z - station.position[1]);
    if (distance <= station.radius && distance < nearestDistance) {
      nearest = station;
      nearestDistance = distance;
    }
  }
  return nearest;
};
