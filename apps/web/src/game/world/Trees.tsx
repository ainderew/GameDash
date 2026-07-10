import { useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Box3, Vector3 } from 'three';
import type { Group, Mesh } from 'three';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@/game/world/Terrain';
import { enhanceNatureMaterial } from '@/game/world/natureMaterials';

/**
 * Stylized Nature MegaKit trees: five CommonTree variants for the treeline
 * (3.2–6.3k tris each — the old sculpted trees were ~57k each), plus a couple
 * of huge TwistedTrees as fixed landmarks framing the arena.
 */
const MODEL_PATHS = [
  '/models/nature/CommonTree_1.gltf',
  '/models/nature/CommonTree_2.gltf',
  '/models/nature/CommonTree_3.gltf',
  '/models/nature/CommonTree_4.gltf',
  '/models/nature/CommonTree_5.gltf',
  '/models/nature/TwistedTree_1.gltf', // landmarks only, never in the treeline
  '/models/nature/TwistedTree_2.gltf',
];
/** How many MODEL_PATHS entries the scattered treeline cycles through. */
const TREELINE_VARIANTS = 5;

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
  /** Which MODEL_PATHS entry this tree uses. */
  variant: number;
  /** Wind sway randomization so the treeline doesn't rock in unison. */
  swayPhase: number;
  swaySpeed: number;
  swayAmp: number;
}

/** Base height (world units) a tree is normalized to before per-instance scaling. */
const BASE_HEIGHT = 8;

/** Ancient twisted trees anchoring the arena — normalized then scaled to ~13m. */
const LANDMARK_TREES = [
  { x: 34, z: -32, variant: 5, scale: 1.7, rotY: 0.8 },
  { x: -40, z: 16, variant: 6, scale: 1.9, rotY: 2.4 },
  { x: 8, z: 46, variant: 5, scale: 1.55, rotY: 4.4 },
];

/** Scatter tree placements in an annulus, skipping the steep peaks. */
const placeTrees = (count: number, clearRadius: number): Placement[] => {
  const rng = mulberry32(773311);
  const rMin = Math.max(14, clearRadius);
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
      variant: items.length % TREELINE_VARIANTS,
      swayPhase: rng() * Math.PI * 2,
      swaySpeed: 0.5 + rng() * 0.5,
      swayAmp: 0.012 + rng() * 0.014,
    });
  }
  // Landmark twisted trees: fixed spots, heavier trunks sway slower and less.
  for (const t of LANDMARK_TREES) {
    items.push({
      x: t.x,
      y: heightAt(t.x, t.z),
      z: t.z,
      rotY: t.rotY,
      scale: t.scale,
      variant: t.variant,
      swayPhase: t.x * 0.7 + t.z * 0.3,
      swaySpeed: 0.35,
      swayAmp: 0.006,
    });
  }
  return items;
};

/**
 * Pack tree variants, normalized to feet-at-y=0 and BASE_HEIGHT tall, scattered as
 * lightweight clones (shared geometry/material). Each tree's group pivots at its base
 * and gently sways (rotation only — no vertex work) to keep the world alive.
 */
export const Trees = ({ clearRadius = 0 }: { clearRadius?: number }) => {
  const scenes: Group[] = [
    useGameModel(MODEL_PATHS[0]!).scene,
    useGameModel(MODEL_PATHS[1]!).scene,
    useGameModel(MODEL_PATHS[2]!).scene,
    useGameModel(MODEL_PATHS[3]!).scene,
    useGameModel(MODEL_PATHS[4]!).scene,
    useGameModel(MODEL_PATHS[5]!).scene,
    useGameModel(MODEL_PATHS[6]!).scene,
  ];
  const swayRefs = useRef<(Group | null)[]>([]);

  const placements = useMemo(() => placeTrees(30, clearRadius), [clearRadius]);

  // Normalize each source model once: scale to BASE_HEIGHT, feet at the group origin.
  // (yLift is in unscaled model units — the group's scale carries it to world units.)
  const norms = useMemo(
    () =>
      scenes.map((scene) => {
        const box = new Box3().setFromObject(scene);
        const size = box.getSize(new Vector3());
        return { baseScale: BASE_HEIGHT / (size.y || 1), yLift: -box.min.y };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    scenes,
  );

  // Clone the right variant per instance and flip shadow flags on the clones' meshes.
  const trees = useMemo(
    () =>
      placements.map((p) => {
        const object = scenes[p.variant]!.clone(true);
        object.traverse((child) => {
          const mesh = child as Mesh;
          if (mesh.isMesh) {
            mesh.material = enhanceNatureMaterial(mesh.material);
            mesh.castShadow = true;
            mesh.receiveShadow = true;
          }
        });
        return { p, object };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placements, ...scenes],
  );

  // Wind: tilt each tree around its base, per-instance phase/speed/amplitude.
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    for (let i = 0; i < placements.length; i++) {
      const g = swayRefs.current[i];
      const p = placements[i];
      if (!g || !p) continue;
      const w = t * p.swaySpeed + p.swayPhase;
      g.rotation.x = Math.sin(w) * p.swayAmp;
      g.rotation.z = Math.cos(w * 0.83) * p.swayAmp * 1.4;
    }
  });

  return (
    <group>
      {trees.map(({ p, object }, i) => {
        const n = norms[p.variant]!;
        return (
          <group
            key={i}
            ref={(el) => (swayRefs.current[i] = el)}
            position={[p.x, p.y, p.z]}
            rotation={[0, p.rotY, 0]}
            scale={n.baseScale * p.scale}
          >
            <primitive object={object} position={[0, n.yLift, 0]} />
          </group>
        );
      })}
    </group>
  );
};

MODEL_PATHS.forEach((p) => useGameModel.preload(p));
