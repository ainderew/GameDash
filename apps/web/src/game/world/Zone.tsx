import { useEffect, useRef } from 'react';
import { RigidBody } from '@react-three/rapier';
import type { Mesh, Object3D } from 'three';
import { Terrain } from '@/game/world/Terrain';
import { Scatter } from '@/game/world/Scatter';
import { Trees } from '@/game/world/Trees';
import { heightAt } from '@/game/world/Terrain';

interface Props {
  /** Camera de-occlusion reads these landmark meshes. */
  obstacles: React.MutableRefObject<Object3D[]>;
}

// A few large landmark boulders framing the arena — also the camera's occluders.
const LANDMARKS: { pos: [number, number]; scale: number; color: string }[] = [
  { pos: [22, -8], scale: 3.4, color: '#8f867a' },
  { pos: [-24, -14], scale: 4.2, color: '#7f7669' },
  { pos: [6, 26], scale: 3.0, color: '#968d80' },
  { pos: [-18, 20], scale: 3.6, color: '#877e71' },
];

/** The stylized-fantasy zone: grassy valley, vegetation, and landmark boulders. */
export const Zone = ({ obstacles }: Props) => {
  const rockRefs = useRef<(Mesh | null)[]>([]);

  useEffect(() => {
    obstacles.current = rockRefs.current.filter((m): m is Mesh => m !== null);
  }, [obstacles]);

  return (
    <>
      <Terrain />
      <Scatter />
      <Trees />
      {LANDMARKS.map((rock, i) => {
        const [x, z] = rock.pos;
        const y = heightAt(x, z);
        return (
          <RigidBody key={i} type="fixed" position={[x, y, z]}>
            <mesh
              ref={(m) => (rockRefs.current[i] = m)}
              scale={rock.scale}
              castShadow
              receiveShadow
            >
              <dodecahedronGeometry args={[1, 0]} />
              <meshStandardMaterial color={rock.color} roughness={0.9} flatShading />
            </mesh>
          </RigidBody>
        );
      })}
    </>
  );
};
