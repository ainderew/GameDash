/**
 * Static obstacle collision layer — a reusable, headless broad+narrow phase for the
 * ECS-driven controllers (player, monsters) whose transforms are owned by movementSystem,
 * not by Rapier. Cheap XZ circle-vs-circle resolution, exactly like resolveHubCollisions'
 * hand-rolled landmark push-outs, but data-driven and scalable.
 *
 * DESIGN (why it scales / why it's netcode-safe):
 *  - Colliders are STATIC (world scenery). We bake them once into a uniform-grid spatial
 *    hash so a moving body only tests the handful of obstacles in its neighbouring cells
 *    (broad phase), not every rock in the field — O(1) amortised instead of O(n).
 *  - COLLISION LAYERS are bitmasks (Box2D / Unity style): every obstacle carries a `layer`,
 *    every query passes a `mask`; an obstacle is only considered when `layer & mask`. This
 *    lets one field serve many consumers (players collide with OBSTACLE, a future flying
 *    enemy might ignore it, projectiles might use a separate mask) without duplicate fields.
 *  - Buckets hold obstacle INDICES and resolution walks candidates in index order, so the
 *    outcome never depends on Map/grid iteration internals — the server authority and every
 *    client prediction replay resolve to the identical position (no-rubberband contract).
 */

/** Collision layer bitflags. Combine into masks with `|`; test with `&`. */
export const CollisionLayer = {
  NONE: 0,
  /** Solid world scenery (rocks, boulders, static props). */
  OBSTACLE: 1 << 0,
  /** Player-controlled bodies. */
  PLAYER: 1 << 1,
  /** Monster bodies. */
  MONSTER: 1 << 2,
  /** Everything. */
  ALL: 0xffff,
} as const;

export type CollisionLayerMask = number;

/** A static circular footprint in the XZ plane. */
export interface CircleObstacle {
  x: number;
  z: number;
  radius: number;
  /** Which layer(s) this obstacle belongs to (bitmask). */
  layer: CollisionLayerMask;
}

const cellKey = (cx: number, cz: number): number =>
  // Pack two signed 16-bit cell coords into one number key (fast, GC-free, no string alloc).
  ((cx & 0xffff) << 16) | (cz & 0xffff);

/**
 * A baked, immutable set of static circle obstacles with a uniform spatial hash over them.
 * Build once (obstacles are world scenery); query every frame.
 */
export class CollisionField {
  private readonly cellSize: number;
  /** cell → indices into `obstacles` registered in that cell. */
  private readonly grid = new Map<number, number[]>();
  /** Insertion-ordered obstacle list — the canonical, deterministic iteration order. */
  readonly obstacles: readonly CircleObstacle[];

  constructor(obstacles: readonly CircleObstacle[], cellSize = 4) {
    this.cellSize = cellSize;
    this.obstacles = obstacles;
    obstacles.forEach((o, index) => {
      // Register the obstacle in every cell its bounding box overlaps, so a query circle
      // that touches it necessarily shares at least one cell with it.
      const minX = Math.floor((o.x - o.radius) / cellSize);
      const maxX = Math.floor((o.x + o.radius) / cellSize);
      const minZ = Math.floor((o.z - o.radius) / cellSize);
      const maxZ = Math.floor((o.z + o.radius) / cellSize);
      for (let cx = minX; cx <= maxX; cx++) {
        for (let cz = minZ; cz <= maxZ; cz++) {
          const key = cellKey(cx, cz);
          let bucket = this.grid.get(key);
          if (!bucket) this.grid.set(key, (bucket = []));
          bucket.push(index);
        }
      }
    });
  }

  /**
   * Gather every obstacle whose cell the circle at (x,z,radius) overlaps, deduped and
   * returned in canonical (bake-index) order so resolution is deterministic. Reuses a
   * caller-provided scratch set/array to stay allocation-light on the hot path.
   */
  private candidates(
    x: number,
    z: number,
    radius: number,
    mask: CollisionLayerMask,
    seen: Set<number>,
    out: number[],
  ): number[] {
    seen.clear();
    out.length = 0;
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize);
    const maxZ = Math.floor((z + radius) / this.cellSize);
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.grid.get(cellKey(cx, cz));
        if (!bucket) continue;
        for (const i of bucket) {
          if (seen.has(i)) continue;
          if ((this.obstacles[i]!.layer & mask) === 0) continue;
          seen.add(i);
          out.push(i);
        }
      }
    }
    // Canonical order: sort by bake index so push-out order never depends on grid scan
    // direction or Map internals — identical on server and every client.
    out.sort((a, b) => a - b);
    return out;
  }

  private readonly _seen = new Set<number>();
  private readonly _cand: number[] = [];

  /**
   * Push a circle of `radius` at (x,z) out of every overlapping obstacle in `mask`.
   * Runs a few relaxation passes so a body wedged in a corner between two rocks settles
   * instead of popping through one. Returns the resolved [x, z].
   */
  resolveCircle(
    x: number,
    z: number,
    radius: number,
    mask: CollisionLayerMask = CollisionLayer.OBSTACLE,
    iterations = 4,
  ): [number, number] {
    for (let pass = 0; pass < iterations; pass++) {
      let moved = false;
      const near = this.candidates(x, z, radius, mask, this._seen, this._cand);
      for (const i of near) {
        const o = this.obstacles[i]!;
        const dx = x - o.x;
        const dz = z - o.z;
        const minDist = o.radius + radius;
        const distSq = dx * dx + dz * dz;
        if (distSq >= minDist * minDist) continue;
        const dist = Math.sqrt(distSq);
        // Degenerate exact-centre overlap: pick a stable axis so it's still deterministic.
        const nx = dist > 1e-6 ? dx / dist : 1;
        const nz = dist > 1e-6 ? dz / dist : 0;
        x = o.x + nx * minDist;
        z = o.z + nz * minDist;
        moved = true;
      }
      if (!moved) break; // settled — no further passes needed
    }
    return [x, z];
  }

  /** True if a circle at (x,z,radius) overlaps any obstacle in `mask` (no mutation). */
  overlaps(x: number, z: number, radius: number, mask: CollisionLayerMask = CollisionLayer.OBSTACLE): boolean {
    const near = this.candidates(x, z, radius, mask, this._seen, this._cand);
    for (const i of near) {
      const o = this.obstacles[i]!;
      const dx = x - o.x;
      const dz = z - o.z;
      const minDist = o.radius + radius;
      if (dx * dx + dz * dz < minDist * minDist) return true;
    }
    return false;
  }
}
