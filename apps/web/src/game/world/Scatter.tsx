import { useEffect, useMemo } from 'react';
import { InstancedMesh, Object3D, StaticDrawUsage } from 'three';
import type { BufferGeometry, Group, Mesh } from 'three';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@/game/world/Terrain';
import { pathMask, hubRoadMask } from '@sim/terrain/terrainHeight';
import { enhanceNatureMaterial } from '@/game/world/natureMaterials';
import { PLAZA_DRESSING, inPlazaKeepout } from '@/game/world/hubLayout';

/**
 * Ground dressing from the Stylized Nature MegaKit, all instanced:
 * mid-size rocks (replacing the old procedural dodecahedrons), pebbles,
 * clover + broadleaf ground cover, and sparse flower accents.
 * Trees live in Trees.tsx; grass tufts in GrassField.tsx.
 */
const PATHS = {
  rocks: [
    '/models/nature/Rock_Medium_1.gltf',
    '/models/nature/Rock_Medium_2.gltf',
    '/models/nature/Rock_Medium_3.gltf',
  ],
  pebbles: [
    '/models/nature/Pebble_Round_1.gltf',
    '/models/nature/Pebble_Round_2.gltf',
    '/models/nature/Pebble_Round_3.gltf',
  ],
  clover: ['/models/nature/Clover_1.gltf', '/models/nature/Clover_2.gltf'],
  plant: '/models/nature/Plant_7.gltf',
  flowers: ['/models/nature/Flower_3_Single.gltf', '/models/nature/Flower_4_Single.gltf'],
  fern: '/models/nature/Fern_1.gltf',
  mushroom: '/models/nature/Mushroom_Common.gltf',
  bushes: ['/models/nature/Bush_Common.gltf', '/models/nature/Bush_Common_Flowers.gltf'],
  pines: [
    '/models/nature/Pine_1.gltf',
    '/models/nature/Pine_3.gltf',
    '/models/nature/Pine_5.gltf',
  ],
  deadTree: '/models/nature/DeadTree_2.gltf',
};

/** Smooth (bilinear) value noise for CLUMPED placement — thickets, glades and bare
 * patches instead of an even sprinkle. Each kind samples a different offset so fern
 * glades, flower beds and bush thickets don't all share the same footprint. */
const cellHash = (ix: number, iz: number) => {
  const s = Math.sin(ix * 157.31 + iz * 271.9) * 43758.5453;
  return s - Math.floor(s);
};
const clumpNoise = (x: number, z: number): number => {
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

/** Deterministic PRNG so the world looks identical every load. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Item {
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

interface ScatterOpts {
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
const scatter = (
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

/** Split items round-robin across n variant buckets. */
const partition = (items: Item[], n: number) => {
  const out: Item[][] = Array.from({ length: n }, () => []);
  items.forEach((it, i) => out[i % n]!.push(it));
  return out;
};

const dummy = new Object3D();

/**
 * Bake one glTF model + placements into InstancedMeshes — one per source mesh, so
 * multi-material models (e.g. flower stem + petals) become aligned instanced pairs.
 * Geometries are cloned (node transform baked in); materials stay in the loader cache.
 */
const buildInstanced = (scene: Group, items: Item[], cast: boolean, receive: boolean) => {
  scene.updateMatrixWorld(true);
  const sources: Mesh[] = [];
  scene.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh) sources.push(mesh);
  });
  return sources.map((src) => {
    const geo = (src.geometry as BufferGeometry).clone().applyMatrix4(src.matrixWorld);
    const mesh = new InstancedMesh(geo, enhanceNatureMaterial(src.material), items.length);
    mesh.instanceMatrix.setUsage(StaticDrawUsage);
    items.forEach((it, i) => {
      dummy.position.set(it.x, it.y - 0.02, it.z);
      dummy.rotation.set(it.rotX, it.rotY, it.rotZ);
      dummy.scale.set(it.scale * it.sx, it.scale * it.sy, it.scale * it.sz);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    return mesh;
  });
};

export const Scatter = ({
  clearRadius = 0,
  groundClearRadius,
  plazaFill = false,
}: {
  clearRadius?: number;
  /** Tighter clear radius for low ground dressing (rocks, pebbles, clover, flowers,
   * fern, mushroom) so it can hug the hub plaza closer than tall obstruction items
   * (boulders, bush thickets, pines, dead trees), which keep the wider `clearRadius`. */
  groundClearRadius?: number;
  /** Also dress the inner plaza dirt (inside the clear radius) with small rocks,
   * pebbles, clover, weeds and flowers, dodging the cobbles/buildings/lamps. */
  plazaFill?: boolean;
}) => {
  const rock1 = useGameModel(PATHS.rocks[0]!);
  const rock2 = useGameModel(PATHS.rocks[1]!);
  const rock3 = useGameModel(PATHS.rocks[2]!);
  const pebble1 = useGameModel(PATHS.pebbles[0]!);
  const pebble2 = useGameModel(PATHS.pebbles[1]!);
  const pebble3 = useGameModel(PATHS.pebbles[2]!);
  const clover1 = useGameModel(PATHS.clover[0]!);
  const clover2 = useGameModel(PATHS.clover[1]!);
  const plant = useGameModel(PATHS.plant);
  const flower3 = useGameModel(PATHS.flowers[0]!);
  const flower4 = useGameModel(PATHS.flowers[1]!);
  const fern = useGameModel(PATHS.fern);
  const mushroom = useGameModel(PATHS.mushroom);
  const bush = useGameModel(PATHS.bushes[0]!);
  const bushFlowers = useGameModel(PATHS.bushes[1]!);
  const pine1 = useGameModel(PATHS.pines[0]!);
  const pine3 = useGameModel(PATHS.pines[1]!);
  const pine5 = useGameModel(PATHS.pines[2]!);
  const deadTree = useGameModel(PATHS.deadTree);

  const meshes = useMemo(() => {
    const rng = mulberry32(20260708);
    const out: InstancedMesh[] = [];
    const groundRadius = groundClearRadius ?? clearRadius;
    const withClearing = (items: Item[], radius: number) =>
      radius > 0 ? items.filter((item) => Math.hypot(item.x, item.z) >= radius) : items;
    const add = (
      scenes: Group[],
      items: Item[],
      cast: boolean,
      receive: boolean,
      radius: number = clearRadius,
    ) =>
      partition(withClearing(items, radius), scenes.length).forEach((bucket, i) =>
        out.push(...buildInstanced(scenes[i]!, bucket, cast, receive)),
      );

    // Mid-size rocks — tilted and sunk into the soil with squashed/stretched heights
    // AND independent X/Z jitter, so no two read as the same rock rescaled. Ground
    // band: allowed to hug the plaza edge, so the hub doesn't sit in a dead ring.
    add(
      [rock1.scene, rock2.scene, rock3.scene],
      scatter(rng, 56, 6, 80, 0.32, 1.6, {
        maxHeight: 6,
        tilt: 0.26,
        sink: 0.08,
        yStretch: [0.6, 1.45],
        xzJitter: 0.24,
        clump: { size: 26, offset: 3.7, bias: 0.22 },
      }),
      true,
      true,
      groundRadius,
    );
    // BOULDERS: the same rocks scaled way up, leaning, buried a little — big landmark
    // silhouettes that break the "everything is knee height" flatness. Kept at the
    // wider clearRadius so they don't loom right over the plaza.
    add(
      [rock3.scene, rock1.scene],
      scatter(rng, 13, 14, 78, 1.7, 3.1, {
        maxHeight: 6,
        tilt: 0.28,
        sink: 0.14,
        yStretch: [0.65, 1.15],
        xzJitter: 0.2,
        clump: { size: 34, offset: 9.2, bias: 0.1 },
      }),
      true,
      true,
    );
    // Sparse pebble clusters, including the trail. Empty ground between groups is as
    // important as the stones: it keeps the terrain readable from the gameplay camera.
    add(
      [pebble1.scene, pebble2.scene, pebble3.scene],
      scatter(rng, 92, 4, 70, 0.72, 2.15, {
        avoidPath: false,
        tilt: 0.45,
        sink: 0.1,
        yStretch: [0.55, 1.3],
        xzJitter: 0.3,
        clump: { size: 13, offset: 9.6, bias: 0.16, power: 2.25 },
      }),
      false,
      true,
      groundRadius,
    );
    // Clover in coherent patches between the grass drifts.
    add(
      [clover1.scene, clover2.scene],
      scatter(rng, 72, 3, 58, 0.14, 0.34, { clump: { size: 14, offset: 1.3 } }),
      false,
      true,
      groundRadius,
    );
    // Low broadleaf ground cover, drifting in and out with its own patch noise.
    add(
      [plant.scene],
      scatter(rng, 190, 3, 58, 0.9, 2.2, {
        clump: { size: 18, offset: 5.1, bias: 0.14 },
        yStretch: [0.7, 1.55],
      }),
      false,
      true,
      groundRadius,
    );
    // Flower BEDS (tight clumps) instead of an even confetti sprinkle.
    add(
      [flower3.scene],
      scatter(rng, 84, 4, 55, 0.28, 0.56, { clump: { size: 12, offset: 7.7, power: 2.5 } }),
      false,
      true,
      groundRadius,
    );
    add(
      [flower4.scene],
      scatter(rng, 68, 4, 55, 0.28, 0.56, { clump: { size: 12, offset: 15.2, power: 2.5 } }),
      false,
      true,
      groundRadius,
    );
    // Fern GLADES near the treeline — dense pockets, empty elsewhere.
    add(
      [fern.scene],
      scatter(rng, 80, 10, 70, 0.22, 0.7, {
        maxHeight: 5,
        clump: { size: 16, offset: 2.9, power: 2.5 },
        yStretch: [0.75, 1.4],
      }),
      false,
      true,
      groundRadius,
    );
    // Mushrooms cluster in small families — lumpy caps, not matching domes.
    add(
      [mushroom.scene],
      scatter(rng, 36, 6, 55, 0.45, 1.35, {
        tilt: 0.22,
        yStretch: [0.7, 1.4],
        xzJitter: 0.25,
        clump: { size: 8, offset: 11.4, power: 3 },
      }),
      false,
      true,
      groundRadius,
    );
    // BUSH THICKETS: mid-height mass between grass and trees — the layer that was
    // missing entirely. A share of them flowering. Squashed/stretched footprints so
    // the thicket doesn't read as identical spheres.
    add(
      [bush.scene, bush.scene, bushFlowers.scene],
      scatter(rng, 46, 8, 66, 0.5, 1.3, {
        maxHeight: 5,
        tilt: 0.1,
        yStretch: [0.7, 1.4],
        xzJitter: 0.16,
        clump: { size: 20, offset: 4.4, power: 2 },
      }),
      true,
      true,
    );
    // PINES: a second tree species with a completely different silhouette, mixed into
    // the outer bands at strongly varied heights so the treeline stops being uniform.
    add(
      [pine1.scene, pine3.scene, pine5.scene],
      scatter(rng, 24, 26, 78, 0.7, 1.7, {
        maxHeight: 7,
        tilt: 0.05,
        yStretch: [0.85, 1.3],
        clump: { size: 30, offset: 6.6, bias: 0.2 },
      }),
      true,
      true,
    );
    // A few dead trees — lonely, crooked accents.
    add(
      [deadTree.scene],
      scatter(rng, 6, 18, 70, 0.7, 1.25, { maxHeight: 6, tilt: 0.12, yStretch: [0.9, 1.25] }),
      true,
      true,
    );

    // ── PLAZA DIRT DRESSING ──────────────────────────────────────────────────
    // The brown haven plaza was bare. Sprinkle low, patchy ground cover across the
    // dirt disk — denser toward the hub (uniform-in-radius over-weights the inner
    // band) — dodging the cobbles, buildings and lamp posts. radius = 0 on `add` so
    // the clearing filter can't strip these (they intentionally live inside it).
    if (plazaFill) {
      const { inner, outer } = PLAZA_DRESSING;
      // Keep plaza dressing off the cobbles/buildings/lamps AND off the dirt roads.
      const plazaAvoid = (x: number, z: number) => inPlazaKeepout(x, z) || hubRoadMask(x, z) > 0.4;
      // A few irregular rock groups, firmly embedded in the packed earth.
      add(
        [rock1.scene, rock2.scene, rock3.scene],
        scatter(rng, 26, inner, outer, 0.22, 0.76, {
          maxHeight: 10,
          avoidPath: false,
          avoid: plazaAvoid,
          tilt: 0.32,
          sink: 0.14,
          yStretch: [0.55, 1.4],
          xzJitter: 0.3,
          clump: { size: 8, offset: 2.2, bias: 0.12, power: 2.35 },
        }),
        true,
        true,
        0,
      );
      // Authored path stones guarantee a few strong accents in every camera-facing road
      // instead of trusting random rejection to land them in these narrow strips.
      const authoredPathRocks: Item[] = [
        [-0.28, 8.1, 0.31, 0.4, 0.9, 1.12, 0.82],
        [0.34, 10.7, 0.23, 1.9, 1.12, 0.72, 1.18],
        [-0.22, 13.35, 0.19, 2.7, 0.82, 0.62, 1.2],
        [0.26, -8.3, 0.28, 0.8, 1.16, 0.76, 0.9],
        [-0.31, -11.2, 0.21, 2.35, 0.78, 0.68, 1.2],
        [-5.8, -5.0, 0.25, 1.4, 1.14, 0.7, 0.88],
        [-8.0, -6.45, 0.19, 2.8, 0.84, 0.62, 1.2],
        [6.0, -4.15, 0.24, 0.3, 1.18, 0.72, 0.86],
        [8.1, -5.55, 0.2, 1.85, 0.82, 0.65, 1.16],
      ].map(([x, z, scale, rotY, sx, sy, sz], i) => ({
        x: x!,
        y: heightAt(x!, z!) - scale! * 0.18,
        z: z!,
        rotY: rotY!,
        rotX: i % 2 === 0 ? 0.12 : -0.09,
        rotZ: i % 3 === 0 ? -0.11 : 0.08,
        scale: scale!,
        sx: sx!,
        sy: sy!,
        sz: sz!,
      }));
      add(
        [rock1.scene, rock2.scene, rock3.scene],
        authoredPathRocks,
        true,
        true,
        0,
      );
      // Smaller embedded pebble clusters worn into the dirt, with deliberate quiet gaps.
      add(
        [pebble1.scene, pebble2.scene, pebble3.scene],
        scatter(rng, 48, inner, outer, 0.55, 1.55, {
          avoidPath: false,
          avoid: inPlazaKeepout,
          tilt: 0.5,
          sink: 0.12,
          yStretch: [0.5, 1.3],
          xzJitter: 0.32,
          clump: { size: 7, offset: 13.1, bias: 0.14, power: 2.2 },
        }),
        false,
        true,
        0,
      );
      add(
        [pebble1.scene, pebble2.scene, pebble3.scene],
        scatter(rng, 18, inner, outer, 0.5, 1.35, {
          avoidPath: false,
          avoid: (x, z) => inPlazaKeepout(x, z) || hubRoadMask(x, z) < 0.18,
          tilt: 0.5,
          sink: 0.14,
          yStretch: [0.5, 1.2],
          xzJitter: 0.34,
        }),
        false,
        true,
        0,
      );
      // Only a few low weeds survive around the plaza margins.
      add(
        [plant.scene],
        scatter(rng, 26, inner, outer, 0.45, 1.15, {
          avoidPath: false,
          avoid: plazaAvoid,
          yStretch: [0.6, 1.5],
          clump: { size: 9, offset: 6.3, bias: 0.1 },
        }),
        false,
        true,
        0,
      );
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rock1, rock2, rock3, pebble1, pebble2, pebble3, clover1, clover2, plant, flower3, flower4, fern, mushroom, bush, bushFlowers, pine1, pine3, pine5, deadTree, clearRadius, groundClearRadius, plazaFill]);

  // Cloned geometries are ours to dispose; materials belong to the loader cache.
  useEffect(
    () => () =>
      meshes.forEach((m) => {
        m.geometry.dispose();
        m.dispose();
      }),
    [meshes],
  );

  return (
    <group>
      {meshes.map((mesh, i) => (
        <primitive key={i} object={mesh} />
      ))}
    </group>
  );
};

[
  ...PATHS.rocks,
  ...PATHS.pebbles,
  ...PATHS.clover,
  PATHS.plant,
  ...PATHS.flowers,
  PATHS.fern,
  PATHS.mushroom,
  ...PATHS.bushes,
  ...PATHS.pines,
  PATHS.deadTree,
].forEach((p) => useGameModel.preload(p));
