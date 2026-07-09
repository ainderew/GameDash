import { useEffect, useMemo } from 'react';
import { InstancedMesh, Object3D, StaticDrawUsage } from 'three';
import type { BufferGeometry, Group, Mesh } from 'three';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@/game/world/Terrain';
import { pathMask } from '@/game/world/terrainHeight';

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
  scale: number;
}

/** Scatter `count` items in an annulus [rMin, rMax], avoiding tall hills and the trail. */
const scatter = (
  rng: () => number,
  count: number,
  rMin: number,
  rMax: number,
  scaleMin: number,
  scaleMax: number,
  maxHeight = 4,
  avoidPath = true,
): Item[] => {
  const items: Item[] = [];
  let guard = 0;
  while (items.length < count && guard < count * 6) {
    guard++;
    const r = rMin + rng() * (rMax - rMin);
    const a = rng() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y > maxHeight) continue; // keep off the steep peaks
    if (avoidPath && pathMask(x, z) > 0.35) continue; // keep plants off the dirt trail
    items.push({
      x,
      y,
      z,
      rotY: rng() * Math.PI * 2,
      scale: scaleMin + rng() * (scaleMax - scaleMin),
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
    const mesh = new InstancedMesh(geo, src.material, items.length);
    mesh.instanceMatrix.setUsage(StaticDrawUsage);
    items.forEach((it, i) => {
      dummy.position.set(it.x, it.y - 0.02, it.z);
      dummy.rotation.set(0, it.rotY, 0);
      dummy.scale.setScalar(it.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.castShadow = cast;
    mesh.receiveShadow = receive;
    return mesh;
  });
};

export const Scatter = () => {
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

  const meshes = useMemo(() => {
    const rng = mulberry32(20260708);
    const out: InstancedMesh[] = [];
    const add = (scenes: Group[], items: Item[], cast: boolean, receive: boolean) =>
      partition(items, scenes.length).forEach((bucket, i) =>
        out.push(...buildInstanced(scenes[i]!, bucket, cast, receive)),
      );

    // Mid-size rocks (natural height ≈ 2m) — the only scatter worth a shadow pass.
    add([rock1.scene, rock2.scene, rock3.scene], scatter(rng, 70, 6, 80, 0.35, 1.4, 6), true, true);
    // Tiny pebbles (≈ 10cm natural) sprinkled everywhere — the trail included.
    add(
      [pebble1.scene, pebble2.scene, pebble3.scene],
      scatter(rng, 120, 4, 70, 0.9, 2.2, 4, false),
      false,
      true,
    );
    // Clover patches hug the ground between grass tufts — sells a "textured" floor.
    // (Kept small and sparse: the purple blossoms get loud fast.)
    add([clover1.scene, clover2.scene], scatter(rng, 110, 3, 58, 0.18, 0.34), false, true);
    // Low broadleaf ground cover.
    add([plant.scene], scatter(rng, 130, 3, 58, 1.0, 2.0), false, true);
    // Sparse flowers for colour accents (multi-material: stem + petal meshes).
    add([flower3.scene], scatter(rng, 45, 4, 55, 0.35, 0.55), false, true);
    add([flower4.scene], scatter(rng, 35, 4, 55, 0.35, 0.55), false, true);
    // Ferns toward the treeline, mushrooms in the open — preview-render dressing.
    add([fern.scene], scatter(rng, 45, 10, 70, 0.3, 0.55, 5), false, true);
    add([mushroom.scene], scatter(rng, 24, 6, 55, 0.6, 1.1), false, true);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rock1, rock2, rock3, pebble1, pebble2, pebble3, clover1, clover2, plant, flower3, flower4, fern, mushroom]);

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
].forEach((p) => useGameModel.preload(p));
