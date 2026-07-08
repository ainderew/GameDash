import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { Color, Object3D } from 'three';
import type { InstancedMesh } from 'three';
import { pickups } from '@/game/ecs/world';

const dummy = new Object3D();
const common = new Color('#34d399');
const rare = new Color('#fbbf24');
const MAX_PICKUPS = 128;

/** Material pickups — spinning gems, instanced. Green = common, gold = rare. */
export const Pickups = () => {
  const ref = useRef<InstancedMesh>(null);

  useFrame((_, dt) => {
    const mesh = ref.current;
    if (!mesh) return;
    const t = performance.now() * 0.003;
    let i = 0;
    for (const p of pickups) {
      if (i >= MAX_PICKUPS) break;
      const [x, , z] = p.transform.position;
      dummy.position.set(x, 0.5 + Math.sin(t + i) * 0.12, z);
      dummy.rotation.set(0, t, Math.PI / 4);
      dummy.scale.setScalar(0.35);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.setColorAt(i, p.pickup.tableId === 'rare' ? rare : common);
      i++;
    }
    mesh.count = i;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    void dt;
  });

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, MAX_PICKUPS]} castShadow>
      <octahedronGeometry args={[1, 0]} />
      <meshStandardMaterial toneMapped={false} />
    </instancedMesh>
  );
};
