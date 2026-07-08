import { useMemo, useRef } from 'react';
import { Box3, Vector3 } from 'three';
import type { Group, Mesh } from 'three';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@/game/world/Terrain';

const MODEL_PATH = '/models/tree.glb';

/** Deterministic PRNG so the treeline looks identical every load. */
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Placement {
  x: number;
  y: number;
  z: number;
  rotY: number;
  scale: number;
}

/** Base height (world units) a tree is normalized to before per-instance scaling. */
const BASE_HEIGHT = 8;

/** Scatter tree placements in an annulus, skipping the steep peaks. */
const placeTrees = (count: number): Placement[] => {
  const rng = mulberry32(773311);
  const rMin = 14;
  const rMax = 88;
  const items: Placement[] = [];
  let guard = 0;
  while (items.length < count && guard < count * 8) {
    guard++;
    const r = rMin + rng() * (rMax - rMin);
    const a = rng() * Math.PI * 2;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const y = heightAt(x, z);
    if (y > 5) continue; // keep off the steep hills
    items.push({
      x,
      y,
      z,
      rotY: rng() * Math.PI * 2,
      scale: 0.8 + rng() * 0.6,
    });
  }
  return items;
};

/**
 * Tripo-generated tree, normalized to feet-at-y=0 and BASE_HEIGHT tall, then
 * scattered as lightweight clones (shared geometry/material, one draw call per
 * mesh per instance). ~30 trees keeps this well within budget.
 */
export const Trees = () => {
  const { scene } = useGameModel(MODEL_PATH);
  const groupRef = useRef<Group>(null);

  const placements = useMemo(() => placeTrees(30), []);

  // Normalize the source model once: uniform scale to BASE_HEIGHT, feet on ground.
  const { baseScale, yOffset } = useMemo(() => {
    const box = new Box3().setFromObject(scene);
    const size = box.getSize(new Vector3());
    const s = BASE_HEIGHT / (size.y || 1);
    return { baseScale: s, yOffset: -box.min.y * s };
  }, [scene]);

  // Clone the model per instance and flip shadow flags on the clones' own meshes.
  const trees = useMemo(
    () =>
      placements.map((p) => {
        const object = scene.clone(true);
        object.traverse((child) => {
          const mesh = child as Mesh;
          if (mesh.isMesh) {
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });
        return { p, object };
      }),
    [placements, scene],
  );

  return (
    <group ref={groupRef}>
      {trees.map(({ p, object }, i) => (
        <group
          key={i}
          position={[p.x, p.y + yOffset * p.scale, p.z]}
          rotation={[0, p.rotY, 0]}
          scale={baseScale * p.scale}
        >
          <primitive object={object} />
        </group>
      ))}
    </group>
  );
};

useGameModel.preload(MODEL_PATH);
