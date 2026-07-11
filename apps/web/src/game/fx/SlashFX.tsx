import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  MeshBasicMaterial,
} from 'three';
import type { Mesh } from 'three';
import { world } from '@/game/ecs/world';
import { comboAt } from '@sim/combat/combo';
import { gameNow } from '@/game/feel/time';
import { MELEE_RANGE } from '@shared/balance';

const players = world.with('playerControlled', 'transform');

/** How long a slash streak stays on screen, ms. */
const SLASH_FX_MS = 300;
/** Angular half-width of a directional streak, radians. */
const STREAK_HALF = 0.34;

/** A ring sector in the XZ plane centered on +Z; `thetaHalf` = π builds a full ring. */
const buildArc = (thetaHalf: number, innerMul: number, outerMul: number): BufferGeometry => {
  const inner = MELEE_RANGE * innerMul;
  const outer = MELEE_RANGE * outerMul;
  const SEG = thetaHalf > 1 ? 48 : 24;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= SEG; i++) {
    const t = i / SEG;
    const ang = Math.PI / 2 - thetaHalf + t * thetaHalf * 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    pos.push(c * inner, 0, s * inner);
    pos.push(c * outer, 0, s * outer);
  }
  for (let i = 0; i < SEG; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
};

const smooth = (t: number): number => t * t * (3 - 2 * t);
const COOL = new Color('#dff0ff');
const WARM = new Color('#ffe6a8');

/**
 * The visible slash: a bright additive arc that plays a per-combo-move flourish —
 * horizontal streaks that flip direction (slash / alt slash), a full expanding ring
 * (spin), and a rising arc (uppercut). Reads the player from the ECS; cosmetic only.
 */
export const SlashFX = () => {
  const meshRef = useRef<Mesh>(null);
  const streak = useMemo(() => buildArc(STREAK_HALF, 0.5, 1.08), []);
  const ring = useMemo(() => buildArc(Math.PI, 0.35, 1.05), []);
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        side: DoubleSide,
        depthWrite: false,
      }),
    [],
  );

  const lastStart = useRef(0);
  const playingSince = useRef(-1e9);
  const moveIdx = useRef(0);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const p = players.first;
    if (!p?.transform) {
      mesh.visible = false;
      return;
    }
    const now = gameNow();

    const start = p.attackState?.startedAt ?? 0;
    if (start > lastStart.current) {
      lastStart.current = start;
      playingSince.current = start;
      moveIdx.current = p.attackState?.combo ?? 0;
      const key = comboAt(moveIdx.current).key;
      mesh.geometry = key === 'spin' ? ring : streak;
      material.color.copy(key === 'uppercut' ? WARM : COOL);
    }

    const at = (now - playingSince.current) / SLASH_FX_MS;
    if (at < 0 || at > 1) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    material.opacity = Math.sin(at * Math.PI) * 0.95;

    const [x, y, z] = p.transform.position;
    const rot = p.transform.rotationY;
    const key = comboAt(moveIdx.current).key;

    if (key === 'spin') {
      mesh.position.set(x, y + 0.9, z);
      mesh.rotation.set(0, rot + smooth(at) * Math.PI * 2, 0);
      const grow = 0.7 + at * 0.6;
      mesh.scale.set(grow, 1, grow);
    } else if (key === 'uppercut') {
      mesh.position.set(x, y + 0.3 + smooth(at) * 2.0, z); // sweeps upward
      mesh.rotation.set(0, rot, 0);
      const grow = 1.05 - at * 0.35;
      mesh.scale.set(grow, 1, grow);
    } else {
      const dir = key === 'altSlash' ? -1 : 1;
      const sweep = (smooth(at) - 0.5) * 2 * (Math.PI / 2.4) * dir;
      mesh.position.set(x, y + 1.0, z);
      mesh.rotation.set(0, rot - sweep, 0);
      const grow = 0.8 + at * 0.35;
      mesh.scale.set(grow, 1, grow);
    }
  });

  return (
    <mesh ref={meshRef} geometry={streak} material={material} frustumCulled={false} visible={false} />
  );
};
