import { useEffect, useMemo } from 'react';
import { Box3, Group, InstancedMesh, Object3D, StaticDrawUsage, Vector3 } from 'three';
import type { BufferGeometry, Mesh } from 'three';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@/game/world/Terrain';
import { hubRoadMask } from '@sim/terrain/terrainHeight';
import { mulberry32, scatter, scatterPass, type Item } from '@sim/terrain/scatterEngine';
import {
  HUB_SCATTER_SEED,
  HUB_MEDIUM_ROCK_PASS,
  HUB_BOULDER_PASS,
  HUB_PLAZA_ROCK_SEED,
  HUB_PLAZA_ROCK_PASS,
} from '@sim/terrain/hubObstacles';
import { enhanceNatureMaterial } from '@/game/world/natureMaterials';
import { PLAZA_DRESSING, inPlazaKeepout } from '@/game/world/hubLayout';

/**
 * Ground dressing from the Stylized Nature MegaKit, all instanced:
 * mid-size rocks (replacing the old procedural dodecahedrons), pebbles,
 * stones, sparse ferns, mushrooms, bushes, and dead vegetation.
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
  fern: '/models/nature/Fern_1.gltf',
  mushroom: '/models/nature/Mushroom_Common.gltf',
  bushes: ['/models/nature/Bush_Common.gltf'],
  deadTree: '/models/nature/DeadTree_2.gltf',
  deadTree2: '/models/nature/dead_tree_2.glb',
};

// The deterministic scatter engine (mulberry32 / clumpNoise / scatter / Item) now lives in
// @sim/terrain/scatterEngine so the headless sim can bake rock COLLIDERS from the identical
// placements it draws here — see hubObstacles.ts. This file only bakes the InstancedMeshes.

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
   * (boulders, bush thickets, dead trees), which keep the wider `clearRadius`. */
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
  const fern = useGameModel(PATHS.fern);
  const mushroom = useGameModel(PATHS.mushroom);
  const bush = useGameModel(PATHS.bushes[0]!);
  const deadTree = useGameModel(PATHS.deadTree);
  const deadTree2 = useGameModel(PATHS.deadTree2);

  // The imported dead-tree variant is an origin-centred 2u-cube export; normalize it to a
  // 1u-tall, feet-at-origin model so the scatter scale below reads directly as world height
  // (Scatter's instancer, unlike Trees.tsx, does no per-model normalization of its own).
  const deadTree2Norm = useMemo(() => {
    const scene = deadTree2.scene.clone(true);
    const box = new Box3().setFromObject(scene);
    const size = box.getSize(new Vector3());
    const s = 1 / (size.y || 1);
    scene.scale.setScalar(s);
    scene.position.set(
      -((box.min.x + box.max.x) / 2) * s,
      -box.min.y * s,
      -((box.min.z + box.max.z) / 2) * s,
    );
    const wrap = new Group();
    wrap.add(scene);
    return wrap;
  }, [deadTree2]);

  const meshes = useMemo(() => {
    const rng = mulberry32(HUB_SCATTER_SEED);
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
    // Pass config lives in @sim (HUB_MEDIUM_ROCK_PASS) so the sim bakes matching COLLIDERS
    // from the identical placement — retune it there, not here, to keep rocks solid.
    add(
      [rock1.scene, rock2.scene, rock3.scene],
      scatterPass(rng, HUB_MEDIUM_ROCK_PASS),
      true,
      true,
      groundRadius,
    );
    // BOULDERS: the same rocks scaled way up, leaning, buried a little — big landmark
    // silhouettes that break the "everything is knee height" flatness. Kept at the
    // wider clearRadius so they don't loom right over the plaza. Collider config: @sim
    // HUB_BOULDER_PASS.
    add([rock3.scene, rock1.scene], scatterPass(rng, HUB_BOULDER_PASS), true, true);
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
    // Fern GLADES near the treeline — dense pockets, empty elsewhere.
    add(
      [fern.scene],
      scatter(rng, 22, 10, 70, 0.2, 0.58, {
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
      scatter(rng, 14, 6, 55, 0.4, 1.1, {
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
      [bush.scene],
      scatter(rng, 18, 8, 66, 0.45, 1.1, {
        maxHeight: 5,
        tilt: 0.1,
        yStretch: [0.7, 1.4],
        xzJitter: 0.16,
        clump: { size: 20, offset: 4.4, power: 2 },
      }),
      true,
      true,
    );
    // DEAD TREES (imported variant): the former green pines are now bare dead trees,
    // scattered through the outer bands at strongly varied heights so the treeline reads as
    // a wasted forest rather than a uniform row. Scale range here is world height in metres —
    // the model was pre-normalized to 1u tall above.
    add(
      [deadTree2Norm],
      scatter(rng, 24, 26, 78, 6, 11, {
        maxHeight: 7,
        tilt: 0.08,
        yStretch: [0.8, 1.25],
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
      // A few irregular rock groups frame the plaza without occupying every quiet
      // patch. Purposeful hub props carry the composition; rocks are punctuation.
      // Config + dedicated seed live in @sim (HUB_PLAZA_ROCK_PASS) so the sim bakes the
      // matching COLLIDERS for the solid-sized ones — retune it there to keep them solid.
      add(
        [rock1.scene, rock2.scene, rock3.scene],
        scatterPass(mulberry32(HUB_PLAZA_ROCK_SEED), HUB_PLAZA_ROCK_PASS),
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
        scatter(rng, 32, inner, outer, 0.45, 1.2, {
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
        scatter(rng, 12, inner, outer, 0.42, 1.05, {
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
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rock1, rock2, rock3, pebble1, pebble2, pebble3, fern, mushroom, bush, deadTree2Norm, deadTree, clearRadius, groundClearRadius, plazaFill]);

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
  PATHS.fern,
  PATHS.mushroom,
  ...PATHS.bushes,
  PATHS.deadTree,
  PATHS.deadTree2,
].forEach((p) => useGameModel.preload(p));
