import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { Color, Object3D } from 'three';
import type { InstancedMesh } from 'three';
import { monsters } from '@/game/ecs/world';
import { MONSTER_ARCHETYPES } from '@shared/monsters';
import { MAX_MONSTERS } from '@shared/balance';

const dummy = new Object3D();
const color = new Color();
const flash = new Color('#ffffff');

/**
 * All monsters in one InstancedMesh — a single draw call regardless of count.
 * Matrices + colors are written imperatively from the ECS each frame (no React state).
 */
export const Monsters = () => {
  const ref = useRef<InstancedMesh>(null);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const now = performance.now();
    let i = 0;
    for (const m of monsters) {
      if (i >= MAX_MONSTERS) break;
      const def = MONSTER_ARCHETYPES[m.monster];
      const r = m.radius ?? 0.5;
      const [x, , z] = m.transform.position;
      dummy.position.set(x, r, z);
      dummy.rotation.set(0, m.transform.rotationY, 0);
      dummy.scale.setScalar(r * 2);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);

      const flashing = (m.hitFlashUntil ?? 0) > now;
      mesh.setColorAt(i, flashing ? flash : color.set(def.color));
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, MAX_MONSTERS]} castShadow receiveShadow>
      <sphereGeometry args={[0.5, 12, 12]} />
      <meshStandardMaterial />
    </instancedMesh>
  );
};
