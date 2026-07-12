import { HUB_LANDMARK_POSITIONS } from '@sim/terrain/hubGeometry';

export { HUB_LANDMARK_POSITIONS } from '@sim/terrain/hubGeometry';
// Plaza dressing geometry moved into the sim (so it can bake collidable plaza rocks); the
// hub's visual/UX layer still imports it from here.
export { PLAZA_DRESSING, inPlazaKeepout } from '@sim/terrain/hubPlaza';

export type HubStationId = 'roster' | 'summoning' | 'expedition';

export interface HubStation {
  id: HubStationId;
  title: string;
  description: string;
  position: readonly [number, number];
  radius: number;
  action?: string;
}

/** A widened mirrored hub: every permanent verb remains visible across a larger plaza. */
export const HUB_STATIONS: readonly HubStation[] = [
  {
    id: 'roster',
    title: 'Roster Lodge',
    description: 'Choose who leads the next expedition.',
    position: [HUB_LANDMARK_POSITIONS.lodge[0], HUB_LANDMARK_POSITIONS.lodge[1] + 4.7],
    radius: 4.2,
    action: 'Switch adventurer',
  },
  {
    id: 'summoning',
    title: 'Summoning Shrine',
    description: 'Recruitment unlocks after expedition rewards are connected.',
    position: HUB_LANDMARK_POSITIONS.shrine,
    radius: 3.1,
  },
  {
    id: 'expedition',
    title: 'Expedition Gate',
    description: 'Leave the haven and begin the current combat run.',
    // Centered on the gate model / portal VFX. Radius must stay just OUTSIDE the
    // gate's collision footprint (1.95 + player 0.45 = 2.4 in sim/hubCollision): the player
    // is walled off at 2.4 from center, so a smaller trigger can never be entered. 3.0 gives
    // a snug reachable ring — departure fires the moment you press up against the portal,
    // and nowhere near as early as the old wide zone. (This region is the proximity TRIGGER.)
    position: HUB_LANDMARK_POSITIONS.gate,
    radius: 3.0,
    action: 'Begin expedition',
  },
] as const;

export const HUB_SPAWN: readonly [number, number, number] = [0, 0, 13.5];

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
