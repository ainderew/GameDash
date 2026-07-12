import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Color } from 'three';
import type { Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { useGameModel } from '@/lib/loaders';

export const CORRUPT_RELIC_PATH = '/models/relic/corrupt-relic.glb';
useGameModel.preload(CORRUPT_RELIC_PATH);

const CORRUPTION_EMISSIVE = new Color('#d946ef');
const WHITE_HOT = new Color('#fff0ff');

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const cloneForCrossfade = (
  source: Object3D,
): { root: Object3D; materials: MeshStandardMaterial[] } => {
  const root = source.clone(true);
  const materials: MeshStandardMaterial[] = [];
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const sourceMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const cloned = sourceMaterials.map((material) => {
      const copy = material.clone() as MeshStandardMaterial;
      if (copy.isMeshStandardMaterial) {
        copy.transparent = true;
        copy.opacity = 0;
        copy.depthWrite = false;
        copy.emissive.copy(CORRUPTION_EMISSIVE);
        copy.emissiveIntensity = 0;
        materials.push(copy);
      }
      return copy;
    });
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!;
  });
  return { root, materials };
};

/**
 * Progressive corrupt-crystal shell shared by the solo and networked Relic renderers.
 * `progressRef` is mutated by their render loops, avoiding a React render every snapshot/frame.
 */
export const CorruptRelicLayer = ({
  progressRef,
  scale = 1.05,
}: {
  progressRef: React.MutableRefObject<number>;
  scale?: number;
}) => {
  const group = useRef<Group>(null);
  const smoothed = useRef(0);
  const gltf = useGameModel(CORRUPT_RELIC_PATH);
  const model = useMemo(() => cloneForCrossfade(gltf.scene), [gltf.scene]);

  useFrame((state, dt) => {
    const target = Math.max(0, Math.min(1, progressRef.current));
    smoothed.current += (target - smoothed.current) * (1 - Math.exp(-5 * dt));
    const progress = smoothed.current;
    const reveal = smoothstep(0.06, 0.88, progress);
    const danger = smoothstep(0.7, 1, progress);
    const pulse = 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * (3 + danger * 8));

    const g = group.current;
    if (g) {
      g.visible = reveal > 0.005;
      const visualScale = scale * (0.58 + 0.42 * smoothstep(0.02, 0.82, progress));
      g.scale.setScalar(visualScale);
      g.rotation.z = Math.sin(state.clock.elapsedTime * 2.1) * 0.035 * danger;
    }

    for (const material of model.materials) {
      material.opacity = reveal;
      material.emissive.copy(CORRUPTION_EMISSIVE).lerp(WHITE_HOT, danger * pulse * 0.45);
      material.emissiveIntensity = reveal * (0.18 + progress * 1.45 + danger * pulse * 1.8);
    }
  });

  return (
    <group ref={group} visible={false}>
      <primitive object={model.root} />
    </group>
  );
};
