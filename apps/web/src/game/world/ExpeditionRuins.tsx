import { useMemo } from 'react';
import type { MutableRefObject } from 'react';
import type { Group, Mesh } from 'three';
import {
  EXPEDITION_RUIN_PLACEMENTS,
  type ExpeditionRuinAsset,
  type ExpeditionRuinPlacement,
} from '@sim/terrain/expeditionRuins';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@/game/world/Terrain';

const RUIN_MODEL_PATHS: Readonly<Record<ExpeditionRuinAsset, string>> = {
  wallTallA: '/models/ruins/ruin_wall_tall_a.glb',
  wallLowB: '/models/ruins/ruin_wall_low_b.glb',
  archBroken: '/models/ruins/ruin_arch_broken.glb',
  columnIntact: '/models/ruins/ruin_column_intact.glb',
  columnBroken: '/models/ruins/ruin_column_broken.glb',
  rubbleLarge: '/models/ruins/ruin_rubble_large.glb',
  rubbleSmall: '/models/ruins/ruin_rubble_small.glb',
  foundationSlab: '/models/ruins/ruin_foundation_slab.glb',
};

const RuinModel = ({ placement }: { placement: ExpeditionRuinPlacement }) => {
  const gltf = useGameModel(RUIN_MODEL_PATHS[placement.asset]);
  const object = useMemo(() => {
    const clone = gltf.scene.clone(true);
    clone.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    return clone;
  }, [gltf.scene]);
  const [x, z] = placement.position;
  const y = heightAt(x, z) + (placement.yOffset ?? 0);

  return (
    <group position={[x, y, z]} rotation={[0, placement.rotationY, 0]} scale={placement.scale ?? 1}>
      <primitive object={object} />
    </group>
  );
};

/** The expedition's architectural shell; the broken arch has no portal VFX or interaction. */
export const ExpeditionRuins = ({
  rootRef,
}: {
  rootRef: MutableRefObject<Group | null>;
}) => (
  <group ref={rootRef} name="expedition-outside-town-ruins">
    {EXPEDITION_RUIN_PLACEMENTS.map((placement) => (
      <RuinModel key={placement.id} placement={placement} />
    ))}
  </group>
);

Object.values(RUIN_MODEL_PATHS).forEach((path) => useGameModel.preload(path));
