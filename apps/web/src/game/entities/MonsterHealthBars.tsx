import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { Color, Object3D } from 'three';
import type { InstancedMesh } from 'three';
import { monsters } from '@/game/ecs/world';
import { MAX_MONSTERS } from '@shared/balance';

const bg = new Object3D();
const fg = new Object3D();
const dark = new Color('#1a1a1a');
const fill = new Color();
const BAR_W = 0.9;
const HIDDEN = new Object3D(); // parked off-screen for unused slots

HIDDEN.position.set(0, -9999, 0);
HIDDEN.updateMatrix();

/**
 * Billboarded HP bars above damaged monsters. Camera yaw is fixed (bars face +Z),
 * so no per-instance billboard math is needed. Two instanced meshes = 2 draw calls.
 */
export const MonsterHealthBars = () => {
  const bgRef = useRef<InstancedMesh>(null);
  const fgRef = useRef<InstancedMesh>(null);

  useFrame(() => {
    const bgm = bgRef.current;
    const fgm = fgRef.current;
    if (!bgm || !fgm) return;

    let i = 0;
    for (const m of monsters) {
      if (i >= MAX_MONSTERS) break;
      const frac = Math.max(0, Math.min(1, m.health.current / m.health.max));
      if (frac >= 1) continue; // only show once damaged

      const r = m.radius ?? 0.5;
      const [x, , z] = m.transform.position;
      const y = r * 2 + 0.5;

      bg.position.set(x, y, z);
      bg.scale.set(BAR_W, 0.14, 1);
      bg.updateMatrix();
      bgm.setMatrixAt(i, bg.matrix);

      fg.position.set(x - (BAR_W * (1 - frac)) / 2, y, z + 0.01);
      fg.scale.set(BAR_W * frac, 0.1, 1);
      fg.updateMatrix();
      fgm.setMatrixAt(i, fg.matrix);
      fill.setRGB(1 - frac, frac, 0.15);
      fgm.setColorAt(i, fill);
      i++;
    }

    bgm.count = i;
    fgm.count = i;
    bgm.instanceMatrix.needsUpdate = true;
    fgm.instanceMatrix.needsUpdate = true;
    if (fgm.instanceColor) fgm.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={bgRef} args={[undefined, undefined, MAX_MONSTERS]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial color={dark} depthTest={false} transparent opacity={0.7} />
      </instancedMesh>
      <instancedMesh ref={fgRef} args={[undefined, undefined, MAX_MONSTERS]}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial depthTest={false} toneMapped={false} />
      </instancedMesh>
    </>
  );
};
