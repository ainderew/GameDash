import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Object3D } from 'three';
import type { BufferGeometry, InstancedMesh, Material, Mesh } from 'three';
import {
  EXPEDITION_SKYLINE_PLACEMENTS,
  type ExpeditionSkylineAsset,
  type ExpeditionSkylinePlacement,
} from '@sim/terrain/expeditionSkyline';
import { heightAt } from '@sim/terrain/terrainHeight';
import { useGameModel } from '@/lib/loaders';

const SKYLINE_MODEL_PATHS: Readonly<Record<ExpeditionSkylineAsset, string>> = {
  towerA: '/models/ruins/ruin_tower_silhouette_a.glb',
  towerB: '/models/ruins/ruin_tower_silhouette_b.glb',
  distantArch: '/models/ruins/ruin_arch_distant.glb?v=grounded-v2',
};

const placementsByAsset: Record<ExpeditionSkylineAsset, readonly ExpeditionSkylinePlacement[]> = {
  towerA: EXPEDITION_SKYLINE_PLACEMENTS.filter((placement) => placement.asset === 'towerA'),
  towerB: EXPEDITION_SKYLINE_PLACEMENTS.filter((placement) => placement.asset === 'towerB'),
  distantArch: EXPEDITION_SKYLINE_PLACEMENTS.filter(
    (placement) => placement.asset === 'distantArch',
  ),
};

const extractMesh = (root: Object3D): { geometry: BufferGeometry; material: Material } => {
  root.updateMatrixWorld(true);
  let source: Mesh | undefined;
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (mesh.isMesh && !source) source = mesh;
  });
  if (!source) throw new Error('skyline GLB contains no mesh');

  const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const material = Array.isArray(source.material) ? source.material[0] : source.material;
  if (!material) throw new Error('skyline GLB contains no material');
  return { geometry, material };
};

const SkylineInstances = ({
  geometry,
  material,
  placements,
  name,
}: {
  geometry: BufferGeometry;
  material: Material;
  placements: readonly ExpeditionSkylinePlacement[];
  name: string;
}) => {
  const ref = useRef<InstancedMesh>(null);

  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const transform = new Object3D();
    placements.forEach((placement, index) => {
      const [x, z] = placement.position;
      transform.position.set(x, heightAt(x, z) + placement.yOffset, z);
      transform.rotation.set(0, placement.rotationY, 0);
      transform.scale.setScalar(placement.scale);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [placements]);

  return (
    <instancedMesh
      ref={ref}
      name={name}
      args={[geometry, material, placements.length]}
      castShadow={false}
      receiveShadow
    />
  );
};

/** Eighteen landmarks in two depth bands, rendered as one instanced batch per source GLB. */
export const ExpeditionSkyline = () => {
  const towerA = useGameModel(SKYLINE_MODEL_PATHS.towerA);
  const towerB = useGameModel(SKYLINE_MODEL_PATHS.towerB);
  const distantArch = useGameModel(SKYLINE_MODEL_PATHS.distantArch);

  const assets = useMemo(() => {
    const a = extractMesh(towerA.scene);
    const b = extractMesh(towerB.scene);
    const arch = extractMesh(distantArch.scene);
    // All three GLBs use the same ruin_dark_rock material. Reusing A's material keeps the
    // skyline on one shader/material instance and avoids duplicate GPU texture uploads.
    return {
      towerA: { geometry: a.geometry, material: a.material },
      towerB: { geometry: b.geometry, material: a.material },
      distantArch: { geometry: arch.geometry, material: a.material },
    };
  }, [towerA.scene, towerB.scene, distantArch.scene]);

  useEffect(
    () => () => {
      assets.towerA.geometry.dispose();
      assets.towerB.geometry.dispose();
      assets.distantArch.geometry.dispose();
    },
    [assets],
  );

  return (
    <group name="expedition-distant-skyline">
      <SkylineInstances
        name="skyline-tower-a-instances"
        geometry={assets.towerA.geometry}
        material={assets.towerA.material}
        placements={placementsByAsset.towerA}
      />
      <SkylineInstances
        name="skyline-tower-b-instances"
        geometry={assets.towerB.geometry}
        material={assets.towerB.material}
        placements={placementsByAsset.towerB}
      />
      <SkylineInstances
        name="skyline-arch-instances"
        geometry={assets.distantArch.geometry}
        material={assets.distantArch.material}
        placements={placementsByAsset.distantArch}
      />
    </group>
  );
};

Object.values(SKYLINE_MODEL_PATHS).forEach((path) => useGameModel.preload(path));
