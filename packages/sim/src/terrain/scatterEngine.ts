/**
 * Deterministic ground-scatter placement engine — the pure math behind the world's
 * instanced dressing (rocks, pebbles, ferns…). Lives in @sim (no three/react) so it is the
 * SINGLE SOURCE OF TRUTH shared by the renderer (apps/web Scatter.tsx bakes InstancedMeshes
 * from these placements) and the headless sim (hubObstacles.ts derives rock colliders from
 * the identical placements). One engine ⇒ colliders can never drift from the rocks you see.
 *
 * Uses only the shared terrain field (heightAt/pathMask), so a placement is byte-identical
 * wherever it runs — the server authority and every client agree on where a rock stands.
 */
import { heightAt, pathMask } from './terrainHeight';

/** Deterministic PRNG so the world looks identical every load. */
export const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** Smooth (bilinear) value noise for CLUMPED placement — thickets, glades and bare
 * patches instead of an even sprinkle. Each kind samples a different offset so fern
 * glades, flower beds and bush thickets don't all share the same footprint. */
const cellHash = (ix: number, iz: number) => {
  const s = Math.sin(ix * 157.31 + iz * 271.9) * 43758.5453;
  return s - Math.floor(s);
};
export const clumpNoise = (x: number, z: number): number => {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  let fx = x - ix;
  let fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fz = fz * fz * (3 - 2 * fz);
  const a = cellHash(ix, iz);
  const b = cellHash(ix + 1, iz);
  const c = cellHash(ix, iz + 1);
  const d = cellHash(ix + 1, iz + 1);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
};

export interface Item {
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Small random lean (radians) so nothing stands perfectly plumb. */
  rotX: number;
  rotZ: number;
  scale: number;
  /** Vertical stretch on top of the uniform scale — varied heights per instance. */
  sy: number;
  /** Independent footprint stretch on X/Z — breaks the "same rock, different size" look. */
  sx: number;
  sz: number;
}

export interface ScatterOpts {
  maxHeight?: number;
  avoidPath?: boolean;
  /** Clumped concentration: `size` = patch footprint in world units, `offset`
   * decorrelates kinds, `bias` is the keep-floor in bare areas, `power` sharpens
   * patch edges (higher = tighter thickets). Omit for an even sprinkle. */
  clump?: { size: number; offset: number; bias?: number; power?: number };
  /** Max random lean, radians. */
  tilt?: number;
  /** Sink into the ground by this fraction of the instance scale (embeds rocks). */
  sink?: number;
  /** Random vertical stretch range — e.g. [0.75, 1.3] varies heights ±30%. */
  yStretch?: [number, number];
  /** Independent X/Z scale jitter (fraction, e.g. 0.2 = ±20%) so instances of the
   * same source mesh don't read as uniformly-scaled clones — lumpy, not smooth. */
  xzJitter?: number;
  /** Extra rejection predicate — return true to skip a candidate (plaza keep-outs). */
  avoid?: (x: number, z: number) => boolean;
}

/** Scatter `count` items in an annulus [rMin, rMax], avoiding tall hills and the trail. */
export const scatter = (
  rng: () => number,
  count: number,
  rMin: number,
  rMax: number,
  scaleMin: number,
  scaleMax: number,
  opts: ScatterOpts = {},
): Item[] => {
  const { maxHeight = 4, avoidPath = true, clump, tilt = 0, sink = 0, yStretch, xzJitter = 0, avoid } = opts;
  const items: Item[] = [];
  let guard = 0;
  const guardMax = count * (clump ? 20 : 8);
  while (items.length < count && guard < guardMax) {
    guard++;
    const r = rMin + rng() * (rMax - rMin);
    const a = rng() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y > maxHeight) continue; // keep off the steep peaks
    if (avoid && avoid(x, z)) continue; // plaza keep-outs (cobbles, buildings, lamps)
    if (avoidPath && pathMask(x, z) > 0.35) continue; // keep plants off the dirt trail
    if (clump) {
      // Contrast remap: raw value noise huddles around 0.5, which never leaves a spot
      // truly bare. Below 0.32 → 0 (empty ground, only `bias` survives); above 0.72 → 1.
      const raw = clumpNoise(x / clump.size + clump.offset, z / clump.size - clump.offset);
      const s = Math.min(1, Math.max(0, (raw - 0.32) / 0.4));
      const n = Math.pow(s * s * (3 - 2 * s), clump.power ?? 2);
      if (rng() > (clump.bias ?? 0.05) + n) continue;
    }
    const scale = scaleMin + rng() * (scaleMax - scaleMin);
    items.push({
      x,
      y: y - sink * scale,
      z,
      rotY: rng() * Math.PI * 2,
      rotX: (rng() - 0.5) * 2 * tilt,
      rotZ: (rng() - 0.5) * 2 * tilt,
      scale,
      sy: yStretch ? yStretch[0] + rng() * (yStretch[1] - yStretch[0]) : 1,
      sx: 1 + (rng() - 0.5) * 2 * xzJitter,
      sz: 1 + (rng() - 0.5) * 2 * xzJitter,
    });
  }
  return items;
};

/**
 * A named scatter pass — the full argument set for one `scatter()` call bundled as data, so
 * the exact same placement can be run by the renderer (for meshes) and by the sim (for
 * colliders). Consuming both from one config is what keeps rocks and their colliders locked.
 */
export interface ScatterPass {
  count: number;
  rMin: number;
  rMax: number;
  scaleMin: number;
  scaleMax: number;
  opts: ScatterOpts;
}

/** Run one `ScatterPass` against `rng`. Both apps/web and hubObstacles call THIS. */
export const scatterPass = (rng: () => number, pass: ScatterPass): Item[] =>
  scatter(rng, pass.count, pass.rMin, pass.rMax, pass.scaleMin, pass.scaleMax, pass.opts);
