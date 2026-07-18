import { useEffect, useMemo, useRef } from 'react';
import { RigidBody } from '@react-three/rapier';
import type { Group, Mesh, Object3D } from 'three';
import { Terrain } from '@/game/world/Terrain';
import { Scatter } from '@/game/world/Scatter';
import { GrassField } from '@/game/world/GrassField';
import { Trees } from '@/game/world/Trees';
import { heightAt } from '@/game/world/Terrain';
import { useGameModel } from '@/lib/loaders';
import { enhanceRockMaterial } from '@/game/world/natureMaterials';
import { ExpeditionRuins } from '@/game/world/ExpeditionRuins';
import { inExpeditionRuinKeepout } from '@sim/terrain/expeditionRuins';
import { ExpeditionSkyline } from '@/game/world/ExpeditionSkyline';
import { inExpeditionSkylineKeepout } from '@sim/terrain/expeditionSkyline';
import { ExpeditionCrystalClusters } from '@/game/world/CrystalClusters';
import { inExpeditionCrystalKeepout } from '@sim/terrain/crystalClusters';
import { GroundMist } from '@/game/world/GroundMist';
import { ExpeditionLanterns } from '@/game/world/ExpeditionLanterns';
import { ExpeditionBanners } from '@/game/world/WindBanner';
import {
  EXPEDITION_LANTERNS,
  expeditionWetnessAt,
} from '@/game/world/expeditionEnvironment';

interface Props {
  /** Camera de-occlusion reads these landmark meshes. */
  obstacles: React.MutableRefObject<Object3D[]>;
}

/** Nature-pack boulder for the landmarks (base pivot, ≈1.9m tall unscaled). */
const BOULDER_PATH = '/models/nature/Rock_Medium_2.gltf';

// A few large landmark boulders framing the arena — also the camera's occluders.
const LANDMARKS: { pos: [number, number]; scale: number; rotY: number }[] = [
  { pos: [30, -3], scale: 1.3, rotY: 0.7 },
  { pos: [-30, -4], scale: 1.45, rotY: 2.1 },
  { pos: [9, 30], scale: 1.4, rotY: 3.9 },
  { pos: [-22, 25], scale: 1.55, rotY: 5.2 },
];

const inExpeditionSceneryKeepout = (x: number, z: number): boolean =>
  inExpeditionRuinKeepout(x, z) ||
  inExpeditionSkylineKeepout(x, z) ||
  inExpeditionCrystalKeepout(x, z) ||
  EXPEDITION_LANTERNS.some((lantern) => Math.hypot(x - lantern.position[0], z - lantern.position[1]) < 1.15);

const inExpeditionGrassKeepout = (x: number, z: number): boolean =>
  inExpeditionSceneryKeepout(x, z) || expeditionWetnessAt(x, z) > 0.12;

/** The stylized-fantasy zone: grassy valley, vegetation, and landmark boulders. */
export const Zone = ({ obstacles }: Props) => {
  const rockRefs = useRef<(Mesh | null)[]>([]);
  const ruinRoot = useRef<Group | null>(null);
  const boulderGltf = useGameModel(BOULDER_PATH);

  const boulder = useMemo(() => {
    let mesh: Mesh | undefined;
    boulderGltf.scene.traverse((child) => {
      const m = child as Mesh;
      if (m.isMesh && !mesh) mesh = m;
    });
    if (!mesh) throw new Error('boulder model has no mesh');
    const clone = mesh.clone();
    clone.material = enhanceRockMaterial(mesh.material);
    return clone;
  }, [boulderGltf.scene]);

  useEffect(() => {
    const meshes = rockRefs.current.filter((m): m is Mesh => m !== null);
    ruinRoot.current?.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) meshes.push(mesh);
    });
    obstacles.current = meshes;
    return () => {
      obstacles.current = [];
    };
  }, [obstacles]);

  return (
    <>
      <Terrain />
      <GrassField avoid={inExpeditionGrassKeepout} purplePlants />
      <Scatter avoid={inExpeditionSceneryKeepout} purplePlants />
      <Trees avoid={inExpeditionSceneryKeepout} />
      <ExpeditionRuins rootRef={ruinRoot} />
      <ExpeditionCrystalClusters />
      <ExpeditionLanterns />
      <ExpeditionBanners />
      <GroundMist />
      <ExpeditionSkyline />
      {LANDMARKS.map((rock, i) => {
        const [x, z] = rock.pos;
        const y = heightAt(x, z);
        return (
          <RigidBody key={i} type="fixed" position={[x, y, z]}>
            <mesh
              ref={(m) => (rockRefs.current[i] = m)}
              geometry={boulder.geometry}
              material={boulder.material}
              scale={rock.scale}
              rotation={[0, rock.rotY, 0]}
              castShadow
              receiveShadow
            />
          </RigidBody>
        );
      })}
    </>
  );
};

useGameModel.preload(BOULDER_PATH);
