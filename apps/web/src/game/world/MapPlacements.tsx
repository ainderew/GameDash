import { Suspense, useMemo } from 'react';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { Mesh, Object3D } from 'three';
import { useGameModel } from '@/lib/loaders';
import { MAPS } from '@/game/world/maps/registry';

/** A shadow-casting clone of a GLTF's scene. Shared by the game and the map editor. */
export const ModelInstance = ({ asset }: { asset: string }) => {
  const gltf = useGameModel(asset);
  const instance = useMemo(() => {
    // SkeletonUtils clone handles both static props and skinned meshes.
    const clone: Object3D = skeletonClone(gltf.scene);
    clone.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    return clone;
  }, [gltf.scene]);
  return <primitive object={instance} />;
};

/** Renders every editor-authored placement for a map (visual only — no colliders yet). */
export const MapPlacements = ({ map }: { map: string }) => (
  <>
    {(MAPS[map]?.placements ?? []).map((p) => (
      <group key={p.id} position={p.position} rotation={p.rotation} scale={p.scale}>
        <Suspense fallback={null}>
          <ModelInstance asset={p.asset} />
        </Suspense>
      </group>
    ))}
  </>
);
