import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { Color, Object3D } from 'three';
import type { InstancedMesh } from 'three';
import { projectiles } from '@/game/ecs/world';
import { PROJECTILE_RADIUS } from '@shared/balance';

const dummy = new Object3D();
const playerColor = new Color('#38bdf8');
const monsterColor = new Color('#c084fc');
const MAX_PROJECTILES = 128;

/** All projectiles in one instanced draw call; blue = player, purple = monster. */
export const Projectiles = () => {
  const ref = useRef<InstancedMesh>(null);

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    let i = 0;
    for (const p of projectiles) {
      if (i >= MAX_PROJECTILES) break;
      const [x, y, z] = p.transform.position;
      dummy.position.set(x, y, z);
      dummy.scale.setScalar(1);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, p.faction === 'monster' ? monsterColor : playerColor);
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, MAX_PROJECTILES]}>
      <sphereGeometry args={[PROJECTILE_RADIUS, 8, 8]} />
      <meshStandardMaterial emissiveIntensity={0.6} toneMapped={false} />
    </instancedMesh>
  );
};
