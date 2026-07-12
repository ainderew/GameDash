/**
 * Hub rock colliders — the authoritative footprints of the collidable scenery rocks, derived
 * from the SAME deterministic scatter passes the renderer draws (apps/web Scatter.tsx). The
 * medium-rock and boulder passes are the first two scatter calls off the shared seed with no
 * RNG draws between them, so replaying them here reproduces the on-screen rocks exactly — the
 * colliders can never sit where there is no rock, on the server or on any client.
 *
 * Both this module and Scatter.tsx consume HUB_SCATTER_SEED + the pass configs below, so the
 * two stay in lockstep by construction (no duplicated placement logic to drift).
 */
import { mulberry32, scatterPass, type Item, type ScatterPass } from './scatterEngine';
import { CollisionField, CollisionLayer, type CircleObstacle } from './collisionField';
import { HUB_CLEARING_RADIUS } from './hubGeometry';
import { PLAZA_DRESSING, inPlazaKeepout } from './hubPlaza';
import { hubRoadMask } from './terrainHeight';

/** Master seed for the hub ground scatter (Scatter.tsx threads this same value). */
export const HUB_SCATTER_SEED = 20260708;

/**
 * Radii (world units) inside which the hub Scatter clears ground dressing so the plaza stays
 * open. Scatter.tsx must pass these as its `groundClearRadius` / `clearRadius` props (see
 * SocialHub) — colliders are only baked for rocks that survive the SAME clearing filter.
 */
export const HUB_SCATTER_CLEAR = { ground: 24, boulder: 27 } as const;

/** Mid-size rocks — the first scatter pass (Scatter.tsx line "Mid-size rocks"). */
export const HUB_MEDIUM_ROCK_PASS: ScatterPass = {
  count: 56,
  rMin: 6,
  rMax: 80,
  scaleMin: 0.32,
  scaleMax: 1.6,
  opts: {
    maxHeight: 6,
    tilt: 0.26,
    sink: 0.08,
    yStretch: [0.6, 1.45],
    xzJitter: 0.24,
    clump: { size: 26, offset: 3.7, bias: 0.22 },
  },
};

/** Boulders — the second scatter pass (same rocks scaled way up). */
export const HUB_BOULDER_PASS: ScatterPass = {
  count: 13,
  rMin: 14,
  rMax: 78,
  scaleMin: 1.7,
  scaleMax: 3.1,
  opts: {
    maxHeight: 6,
    tilt: 0.28,
    sink: 0.14,
    yStretch: [0.65, 1.15],
    xzJitter: 0.2,
    clump: { size: 34, offset: 9.2, bias: 0.1 },
  },
};

/**
 * Plaza rocks keep off structures AND off the worn dirt roads, so making them solid never
 * walls a path — they sit in the quiet dirt between the roads. Web + sim share this predicate
 * so the collidable plaza rocks land in the exact spots the renderer draws them.
 */
export const hubPlazaRockAvoid = (x: number, z: number): boolean =>
  inPlazaKeepout(x, z) || hubRoadMask(x, z) > 0.4;

/** Dedicated seed for the plaza rock group — independent of the main scatter chain so it can
 *  be reproduced headlessly without replaying every decorative pass before it. */
export const HUB_PLAZA_ROCK_SEED = 51972043;

/** Small rocks framing the plaza dirt (Scatter.tsx "few irregular rock groups"). */
export const HUB_PLAZA_ROCK_PASS: ScatterPass = {
  count: 12,
  rMin: PLAZA_DRESSING.inner,
  rMax: PLAZA_DRESSING.outer,
  scaleMin: 0.18,
  scaleMax: 0.52,
  opts: {
    maxHeight: 10,
    avoidPath: false,
    avoid: hubPlazaRockAvoid,
    tilt: 0.32,
    sink: 0.14,
    yStretch: [0.55, 1.4],
    xzJitter: 0.3,
    clump: { size: 8, offset: 2.2, bias: 0.08, power: 2.35 },
  },
};

/**
 * Measured XZ half-width of the nature Rock_Medium meshes at scale 1 (glTF bounding boxes
 * average ~3.25u wide ⇒ ~1.6u half-width). The collider then sits at ROCK_COLLIDER_FIT of
 * that so it hugs just inside the (tapered, irregular) silhouette — solid, no sticky lip.
 */
export const ROCK_MODEL_HALF_WIDTH = 1.6;
export const ROCK_COLLIDER_FIT = 0.6;

/** Rocks with a smaller footprint than this are steppable clutter — no collider. */
export const ROCK_MIN_COLLIDER_RADIUS = 0.35;

const colliderRadius = (it: Item): number =>
  it.scale * ((it.sx + it.sz) / 2) * ROCK_MODEL_HALF_WIDTH * ROCK_COLLIDER_FIT;

/** Keep only items that survive the plaza-clearing filter (hypot ≥ radius), matching Scatter. */
const cleared = (items: Item[], clearRadius: number): Item[] =>
  items.filter((it) => Math.hypot(it.x, it.z) >= clearRadius);

const toObstacles = (items: Item[]): CircleObstacle[] =>
  items
    .map((it) => ({ x: it.x, z: it.z, radius: colliderRadius(it), layer: CollisionLayer.OBSTACLE }))
    .filter((o) => o.radius >= ROCK_MIN_COLLIDER_RADIUS)
    // The player is clamped inside HUB_CLEARING_RADIUS, so a rock whose near edge lies beyond
    // that ring can never be touched — drop it so the field only holds reachable colliders.
    .filter((o) => Math.hypot(o.x, o.z) - o.radius <= HUB_CLEARING_RADIUS + 0.5);

/**
 * Deterministically rebuild the hub's collidable rock footprints. Runs the medium-rock then
 * boulder passes off one seeded RNG (identical order to Scatter.tsx), applies the same
 * clearing filter, and keeps rocks large enough to block. Pure — safe to memoise.
 */
export const buildHubRockObstacles = (): CircleObstacle[] => {
  const rng = mulberry32(HUB_SCATTER_SEED);
  const medium = scatterPass(rng, HUB_MEDIUM_ROCK_PASS); // pass 1 (consumes rng first)
  const boulders = scatterPass(rng, HUB_BOULDER_PASS); //   pass 2
  // Plaza rocks come off a dedicated seed (see HUB_PLAZA_ROCK_SEED) — no clearing filter, they
  // intentionally live INSIDE the clearing, on the open dirt between roads.
  const plaza = scatterPass(mulberry32(HUB_PLAZA_ROCK_SEED), HUB_PLAZA_ROCK_PASS);
  return [
    ...toObstacles(cleared(medium, HUB_SCATTER_CLEAR.ground)),
    ...toObstacles(cleared(boulders, HUB_SCATTER_CLEAR.boulder)),
    ...toObstacles(plaza),
  ];
};

let field: CollisionField | null = null;

/** The lazily-built, cached hub rock collision field (world scenery never changes). */
export const hubCollisionField = (): CollisionField => (field ??= new CollisionField(buildHubRockObstacles()));
