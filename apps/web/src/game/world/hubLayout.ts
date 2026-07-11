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

// ── Plaza ground dressing ─────────────────────────────────────────────────────
// The haven's dirt plaza (the brown disk between the cobbles and the treeline) is
// dressed with its own denser band of grass/weeds/rocks/flowers so it doesn't read
// as a flat empty plane. These describe where that dressing lives and what it dodges.

/** The dirt-disk annulus the plaza dressing fills: just outside the cobbles to just
 *  inside the outer brick ring. Density is concentrated toward the inner edge (the hub). */
export const PLAZA_DRESSING = { inner: 6.0, outer: 18.5 } as const;

/** Circular keep-outs so plaza dressing never sprouts on the cobbles, through a
 *  building, or up a lamp post. [x, z, radius]. */
const PLAZA_KEEPOUT: readonly (readonly [number, number, number])[] = [
  [0, 0, 5.9], // cobblestone circle + campfire (grass meets the stone edge)
  [-10.5, -10.5, 5.6], // Roster Lodge footprint
  [10.5, -7.4, 3.4], // Summoning Shrine + relic base
  [0, -17, 4.2], // Expedition Gate
  [-6.8, 7, 1.0], // lamp
  [6.8, 7, 1.0], // lamp
  [-14.8, -1.5, 1.0], // lamp
  [14.8, -1.5, 1.0], // lamp
] as const;

/** True when (x, z) sits on a plaza structure and must stay clear of dressing. */
export const inPlazaKeepout = (x: number, z: number): boolean => {
  for (const [cx, cz, r] of PLAZA_KEEPOUT) {
    if ((x - cx) * (x - cx) + (z - cz) * (z - cz) < r * r) return true;
  }
  return false;
};

// NOTE (multiplayer Phase 1): the collision half of the hub layout — footprint circles,
// lodge rear wall, clearing clamp — moved into the headless sim as
// @sim/terrain/hubCollision (resolveHubCollisions), because it is gameplay the server
// must run. This file keeps the VISUAL/UX layout: stations, spawn, plaza dressing.

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
