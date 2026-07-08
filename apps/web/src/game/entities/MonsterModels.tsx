import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Box3, Object3D, Vector3 } from 'three';
import type { BufferGeometry, InstancedMesh, Material, Mesh } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { monsters } from '@/game/ecs/world';
import { useGameModel } from '@/lib/loaders';
import type { MonsterArchetype } from '@shared/monsters';
import { MAX_MONSTERS } from '@shared/balance';

interface ArchMeta {
  path: string;
  /** World-space display height, world units. */
  height: number;
  /** Y-rotation to correct the model's forward axis (Tripo tends to face +X). */
  faceOffset: number;
}

const ARCHES: Record<MonsterArchetype, ArchMeta> = {
  chaser: { path: '/models/monster-chaser.glb', height: 1.4, faceOffset: -Math.PI / 2 },
  spitter: { path: '/models/monster-spitter.glb', height: 1.3, faceOffset: -Math.PI / 2 },
  brute: { path: '/models/monster-brute.glb', height: 2.7, faceOffset: -Math.PI / 2 },
};

const dummy = new Object3D();

/** Full duration of the attack lunge, ms. */
const ATTACK_MS = 500;
const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * Procedural melee jab keyed on attack progress `at` (0..1): a short anticipation
 * (rear back + crouch), a snappy strike (lunge forward + stretch), then an eased
 * recovery. Returns [forwardFactor, scaleY, scaleXZ]; outside 0..1 it's the rest pose.
 */
const attackPose = (at: number): [number, number, number] => {
  if (at < 0 || at > 1) return [0, 1, 1];
  if (at < 0.22) {
    const k = smooth(at / 0.22);
    return [-0.28 * k, 1 - 0.12 * k, 1 + 0.08 * k];
  }
  if (at < 0.42) {
    const k = smooth((at - 0.22) / 0.2);
    return [-0.28 + 1.28 * k, 0.88 + 0.24 * k, 1.08 - 0.16 * k];
  }
  const k = smooth((at - 0.42) / 0.58);
  return [1 - k, 1.12 - 0.12 * k, 0.92 + 0.08 * k];
};

/** Bake a GLB scene into a single unit-height geometry (feet at y=0, centered in XZ). */
const bake = (scene: Object3D): { geometry: BufferGeometry; material: Material } => {
  scene.updateWorldMatrix(true, true);
  const geoms: BufferGeometry[] = [];
  let material: Material | undefined;
  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry.clone();
    g.applyMatrix4(mesh.matrixWorld);
    geoms.push(g);
    if (!material) material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)!;
  });
  let geometry = geoms[0]!;
  if (geoms.length > 1) {
    try {
      geometry = mergeGeometries(geoms, false) ?? geoms[0]!;
    } catch {
      geometry = geoms[0]!;
    }
  }
  const box = new Box3().setFromBufferAttribute(
    geometry.getAttribute('position') as never,
  );
  const size = box.getSize(new Vector3());
  geometry.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  const h = size.y || 1;
  geometry.scale(1 / h, 1 / h, 1 / h);
  return { geometry, material: material! };
};

/** One instanced draw call per archetype, matrices written from the ECS each frame. */
const ArchetypeInstances = ({ archetype }: { archetype: MonsterArchetype }) => {
  const meta = ARCHES[archetype];
  const { scene } = useGameModel(meta.path);
  const ref = useRef<InstancedMesh>(null);
  const { geometry, material } = useMemo(() => bake(scene.clone(true)), [scene]);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const now = performance.now();
    let i = 0;
    for (const m of monsters) {
      if (m.monster !== archetype) continue;
      if (i >= MAX_MONSTERS) break;
      const [x, , z] = m.transform.position;
      // Brief scale "pop" on hit for feedback (per-instance, no shader needed).
      const pop = (m.hitFlashUntil ?? 0) > now ? 1.15 : 1;

      // Attack lunge: shove the model toward whoever it faces + squash/stretch.
      const at = (now - (m.attackStartedAt ?? -1e9)) / ATTACK_MS;
      const [fwd, sy, sxz] = attackPose(at);
      const lunge = fwd * meta.height * 0.5;
      dummy.position.set(
        x + Math.sin(m.transform.rotationY) * lunge,
        0,
        z + Math.cos(m.transform.rotationY) * lunge,
      );
      dummy.rotation.set(0, m.transform.rotationY + meta.faceOffset, 0);
      dummy.scale.set(meta.height * sxz * pop, meta.height * sy * pop, meta.height * sxz * pop);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={ref}
      args={[geometry, material, MAX_MONSTERS]}
      castShadow
      receiveShadow
      frustumCulled={false}
    />
  );
};

/** Real monster models replacing the grey-box spheres, one instanced mesh per archetype. */
export const MonsterModels = () => (
  <>
    <ArchetypeInstances archetype="chaser" />
    <ArchetypeInstances archetype="spitter" />
    <ArchetypeInstances archetype="brute" />
  </>
);
