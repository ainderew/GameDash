import { useMemo } from 'react';
import { Box3, Vector3 } from 'three';
import type { Mesh } from 'three';
import { useGameModel } from '@/lib/loaders';

interface Props {
  /** Path under public/, e.g. '/models/test-monster.glb'. */
  path: string;
  /** Desired height in world units; the model is uniformly scaled to fit. */
  targetHeight?: number;
  /** Extra Y-rotation (radians) to correct the model's forward axis. */
  faceOffset?: number;
}

/**
 * Loads a GLB, auto-fits it to `targetHeight`, and plants its feet at y=0
 * so it drops into the pivot-at-feet convention used by entities.
 * Reused for monsters in Phase 6.
 */
export const CharacterModel = ({ path, targetHeight = 1.8, faceOffset = 0 }: Props) => {
  const { scene } = useGameModel(path);

  const { object, scale, yOffset } = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    const box = new Box3().setFromObject(clone);
    const size = box.getSize(new Vector3());
    const height = size.y || 1;
    const s = targetHeight / height;
    // After scaling, lift so the lowest point sits on the ground.
    const offset = -box.min.y * s;
    return { object: clone, scale: s, yOffset: offset };
  }, [scene, targetHeight]);

  return (
    <group position={[0, yOffset, 0]} rotation={[0, faceOffset, 0]} scale={scale}>
      <primitive object={object} />
    </group>
  );
};
