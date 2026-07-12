/**
 * Plaza dressing geometry — where the haven's inner dirt disk is decorated and what that
 * decoration must dodge (cobbles, buildings, lamps, benches, crystal clusters). Lives in
 * @sim (no three/react) so the headless sim can reproduce the collidable plaza rocks the
 * renderer draws — the SAME reason the scatter engine moved here. Re-exported by the web's
 * hubLayout.ts so existing UI imports keep their path.
 */
import { HUB_LANDMARK_POSITIONS } from './hubGeometry';

/** The dirt-disk annulus the plaza dressing fills: just outside the cobbles to just
 *  inside the outer brick ring. Density is concentrated toward the inner edge (the hub). */
export const PLAZA_DRESSING = { inner: 2.0, outer: 23.5 } as const;

/** Circular keep-outs so plaza dressing never sprouts on the cobbles, through a
 *  building, or up a lamp post. [x, z, radius]. */
export const PLAZA_KEEPOUT: readonly (readonly [number, number, number])[] = [
  [0, 0, 6.45], // cobblestone circle + campfire
  [HUB_LANDMARK_POSITIONS.lodge[0], HUB_LANDMARK_POSITIONS.lodge[1], 5.6],
  [HUB_LANDMARK_POSITIONS.shrine[0], HUB_LANDMARK_POSITIONS.shrine[1], 3.4],
  [HUB_LANDMARK_POSITIONS.gate[0], HUB_LANDMARK_POSITIONS.gate[1], 5.1],
  [-7.8, 8.0, 1.0], // lamp
  [7.8, 8.0, 1.0], // lamp
  [-18.0, -1.5, 1.0], // lamp
  [18.0, -1.5, 1.0], // lamp
  [-7.2, -17.1, 0.9], // portal approach lamp
  [7.2, -17.1, 0.9], // portal approach lamp
  [-6.5, 5.8, 2.2], // hearth bench
  [6.5, 5.8, 2.2], // hearth bench
  [-5.2, -18.1, 1.0], // expedition banner
  [5.2, -18.1, 1.0], // expedition banner
  [-19.0, -13.5, 1.5], // crystal cluster
  [19.0, -13.5, 1.5], // crystal cluster
  [-17.5, 12.0, 1.1], // crystal cluster
  [17.5, 12.0, 1.1], // crystal cluster
] as const;

/** True when (x, z) sits on a plaza structure and must stay clear of dressing. */
export const inPlazaKeepout = (x: number, z: number): boolean => {
  for (const [cx, cz, r] of PLAZA_KEEPOUT) {
    if ((x - cx) * (x - cx) + (z - cz) * (z - cz) < r * r) return true;
  }
  return false;
};
