import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { AdditiveBlending, BufferGeometry, Float32BufferAttribute, MeshBasicMaterial, Vector3 } from 'three';
import type { Mesh } from 'three';
import { world } from '@/game/ecs/world';
import { comboAt, moveActiveWindow } from '@/game/combat/combo';
import { weaponSockets } from '@/game/combat/weaponSockets';
import { currentWeapon } from '@/game/combat/weaponStore';
import { gameNow } from '@/game/feel/time';

const SAMPLES = 12;
const players = world.with('playerControlled', 'transform');

/**
 * Ribbon sampled from the weapon's real base/tip sockets. Unlike a radial decal, this shows
 * the exact arc the model's blade took during the active frames of a swing.
 */
export const BladeTrail = () => {
  const mesh = useRef<Mesh>(null);
  const material = useMemo(
    () => new MeshBasicMaterial({ transparent: true, opacity: 0, vertexColors: true, blending: AdditiveBlending, depthWrite: false }),
    [],
  );
  const geometry = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array(SAMPLES * 2 * 3), 3));
    const colors = new Float32Array(SAMPLES * 2 * 3);
    for (let i = 0; i < SAMPLES; i++) {
      const alpha = 1 - i / SAMPLES;
      for (let v = 0; v < 2; v++) {
        const at = (i * 2 + v) * 3;
        colors[at] = alpha;
        colors[at + 1] = alpha;
        colors[at + 2] = alpha;
      }
    }
    g.setAttribute('color', new Float32BufferAttribute(colors, 3));
    const index: number[] = [];
    for (let i = 0; i < SAMPLES - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    g.setIndex(index);
    return g;
  }, []);
  const history = useRef(new Float32Array(SAMPLES * 6));
  const count = useRef(0);
  const lastSwing = useRef(-1);
  const base = useMemo(() => new Vector3(), []);
  const tip = useMemo(() => new Vector3(), []);

  useFrame(() => {
    const out = mesh.current;
    const player = players.first;
    const baseSocket = weaponSockets.base;
    const tipSocket = weaponSockets.tip;
    if (!out || !player?.attackState || !baseSocket || !tipSocket) {
      if (out) out.visible = false;
      return;
    }
    const now = gameNow();
    const swing = player.attackState.startedAt;
    const age = now - swing;
    // attackState spans windup + active; only draw the real blade during its delivery.
    const { start, end } = moveActiveWindow(comboAt(player.attackState.combo ?? 0));
    if (age < start || age > end) {
      out.visible = false;
      return;
    }
    if (swing !== lastSwing.current) {
      lastSwing.current = swing;
      count.current = 0;
    }
    baseSocket.getWorldPosition(base);
    tipSocket.getWorldPosition(tip);
    const h = history.current;
    h.copyWithin(6, 0, (SAMPLES - 1) * 6);
    h[0] = base.x; h[1] = base.y; h[2] = base.z;
    h[3] = tip.x; h[4] = tip.y; h[5] = tip.z;
    count.current = Math.min(SAMPLES, count.current + 1);
    const pos = geometry.getAttribute('position') as Float32BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < count.current; i++) {
      const src = i * 6;
      const dst = i * 6;
      arr[dst] = h[src]!; arr[dst + 1] = h[src + 1]!; arr[dst + 2] = h[src + 2]!;
      arr[dst + 3] = h[src + 3]!; arr[dst + 4] = h[src + 4]!; arr[dst + 5] = h[src + 5]!;
    }
    pos.needsUpdate = true;
    material.color.set(currentWeapon().trailColor);
    material.opacity = Math.min(0.85, count.current / 4);
    out.visible = count.current > 1;
  });

  return <mesh ref={mesh} geometry={geometry} material={material} frustumCulled={false} visible={false} />;
};
