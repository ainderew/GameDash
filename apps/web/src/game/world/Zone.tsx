import { useEffect, useMemo, useRef } from 'react';
import { RigidBody } from '@react-three/rapier';
import type { Mesh, Object3D } from 'three';
import { Terrain } from '@/game/world/Terrain';
import { Scatter } from '@/game/world/Scatter';
import { GrassField } from '@/game/world/GrassField';
import { Trees } from '@/game/world/Trees';
import { heightAt } from '@/game/world/Terrain';
import { useGameModel } from '@/lib/loaders';
import { enhanceNatureMaterial } from '@/game/world/natureMaterials';

interface Props {
  /** Camera de-occlusion reads these landmark meshes. */
  obstacles: React.MutableRefObject<Object3D[]>;
}

/** Nature-pack boulder for the landmarks (base pivot, ≈1.9m tall unscaled). */
const BOULDER_PATH = '/models/nature/Rock_Medium_2.gltf';

// A few large landmark boulders framing the arena — also the camera's occluders.
const LANDMARKS: { pos: [number, number]; scale: number; rotY: number }[] = [
  { pos: [22, -8], scale: 2.0, rotY: 0.7 },
  { pos: [-24, -14], scale: 2.5, rotY: 2.1 },
  { pos: [6, 26], scale: 1.8, rotY: 3.9 },
  { pos: [-18, 20], scale: 2.2, rotY: 5.2 },
];

/** The stylized-fantasy zone: grassy valley, vegetation, and landmark boulders. */
export const Zone = ({ obstacles }: Props) => {
  const rockRefs = useRef<(Mesh | null)[]>([]);
  const boulderGltf = useGameModel(BOULDER_PATH);

  const boulder = useMemo(() => {
    let mesh: Mesh | undefined;
    boulderGltf.scene.traverse((child) => {
      const m = child as Mesh;
      if (m.isMesh && !mesh) mesh = m;
    });
    if (!mesh) throw new Error('boulder model has no mesh');
    const clone = mesh.clone();
    clone.material = enhanceNatureMaterial(mesh.material);
    return clone;
  }, [boulderGltf.scene]);

  useEffect(() => {
    obstacles.current = rockRefs.current.filter((m): m is Mesh => m !== null);
  }, [obstacles]);

  return (
    <>
      <Terrain />
      <GrassField />
      <Scatter />
      <Trees />
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
