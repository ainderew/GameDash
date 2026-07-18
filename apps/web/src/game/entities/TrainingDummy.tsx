import { Html } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color, MeshStandardMaterial } from 'three';
import type { Group } from 'three';
import type { Entity } from '@sim/components';
import { createTrainingDummy } from '@sim/systems/spawnSystem';
import { HUB_TRAINING_DUMMY_POSITION } from '@sim/terrain/hubGeometry';
import { monsters, world } from '@/game/ecs/world';
import { gameNow } from '@/game/feel/time';
import { hitSquash } from '@/game/entities/hitSquash';

const WOOD = '#765033';
const TARGET = '#8f2937';
const flashColor = new Color();

/** A visible, stationary practice target backed by a real hittable ECS entity. */
export const TrainingDummy = ({ networked }: { networked: boolean }) => {
  const root = useRef<Group>(null);
  const wood = useMemo(
    () => new MeshStandardMaterial({ color: WOOD, roughness: 0.9, metalness: 0 }),
    [],
  );
  const target = useMemo(
    () => new MeshStandardMaterial({ color: TARGET, roughness: 0.75, metalness: 0.05 }),
    [],
  );

  // Solo owns its target locally. A connected session receives the same entity from the
  // authoritative hub snapshot through NetworkedWorld.
  useEffect(() => {
    if (networked) return;
    const entity = world.add(
      createTrainingDummy([
        HUB_TRAINING_DUMMY_POSITION[0],
        HUB_TRAINING_DUMMY_POSITION[1],
        HUB_TRAINING_DUMMY_POSITION[2],
      ]),
    );
    return () => {
      world.remove(entity);
    };
  }, [networked]);

  useEffect(
    () => () => {
      wood.dispose();
      target.dispose();
    },
    [target, wood],
  );

  useFrame(() => {
    const group = root.current;
    if (!group) return;
    let entity: Entity | undefined;
    for (const candidate of monsters) {
      if (candidate.trainingDummy) {
        entity = candidate;
        break;
      }
    }
    if (!entity) {
      group.visible = false;
      return;
    }

    const transform = entity.transform;
    if (!transform) return;
    group.visible = true;
    group.position.set(...transform.position);
    group.rotation.set(0, transform.rotationY, 0);
    const [scaleXZ, scaleY] = hitSquash(entity, gameNow());
    group.scale.set(scaleXZ, scaleY, scaleXZ);

    const remaining = Math.max(0, (entity.hitFlashUntil ?? 0) - gameNow());
    const intensity = Math.min(1, remaining / 120) * 0.9;
    const rgb = entity.hitFlashColor ?? [1, 1, 1];
    flashColor.setRGB(rgb[0], rgb[1], rgb[2]).multiplyScalar(intensity);
    wood.emissive.copy(flashColor);
    target.emissive.copy(flashColor);
  });

  return (
    <group ref={root} visible={false}>
      <mesh position={[0, 0.18, 0]} material={wood} castShadow receiveShadow>
        <cylinderGeometry args={[0.7, 0.85, 0.3, 12]} />
      </mesh>
      <mesh position={[0, 1.25, 0]} material={wood} castShadow receiveShadow>
        <boxGeometry args={[0.28, 2.3, 0.28]} />
      </mesh>
      <mesh position={[0, 1.72, 0]} material={wood} castShadow receiveShadow>
        <boxGeometry args={[1.85, 0.24, 0.24]} />
      </mesh>
      <mesh position={[0, 2.33, 0]} material={wood} castShadow receiveShadow>
        <sphereGeometry args={[0.38, 16, 12]} />
      </mesh>
      <mesh position={[0, 1.22, 0.22]} rotation={[Math.PI / 2, 0, 0]} material={target} castShadow>
        <cylinderGeometry args={[0.52, 0.52, 0.16, 24]} />
      </mesh>
      <mesh position={[0, 1.22, 0.315]} material={wood}>
        <torusGeometry args={[0.31, 0.055, 8, 24]} />
      </mesh>
      <Html position={[0, 3, 0]} center distanceFactor={12} style={{ pointerEvents: 'none' }}>
        <div className="whitespace-nowrap rounded-full border border-amber-100/25 bg-[#24170f]/80 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-amber-100 shadow-lg backdrop-blur-sm">
          Training Dummy
        </div>
      </Html>
    </group>
  );
};
