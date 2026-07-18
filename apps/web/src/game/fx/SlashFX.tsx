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
const SLASH_FX_MS = 500;
/** Angular half-width of a directional streak, radians. */
const STREAK_HALF = 0.34;
/** Width of the dissolve front as a fraction of the streak, tail → head. */
const FADE_FEATHER = 0.35;
/** Angular half-width of the full swept arc for horizontal slashes, radians. */
const SWEEP_HALF = Math.PI / 2.4;
/** Fraction of the FX lifetime the head takes to cross the arc; the rest is tail burn-off. */
const SWEEP_END = 0.45;
/** Length of the glowing tail behind the head, as a fraction of the arc. */
const TRAIL = 0.35;
/** Soft edge ahead of the head, as a fraction of the arc. */
const HEAD_FEATHER = 0.12;
/** Overbright multiplier at the head so it visibly outshines the dying tail. */
const HEAD_GLOW = 1.4;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

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
  g.setAttribute('color', new Float32BufferAttribute(new Float32Array(pos.length).fill(1), 3));
  g.setIndex(idx);
  return g;
};

const smooth = (t: number): number => t * t * (3 - 2 * t);
const COOL = new Color('#dff0ff');
const WARM = new Color('#ffe6a8');

/**
 * The visible slash: a bright additive accent for all four complete authored attacks.
 */
export const SlashFX = () => {
  const meshRef = useRef<Mesh>(null);
  const streak = useMemo(() => buildArc(STREAK_HALF, 0.5, 1.08), []);
  const sweepArc = useMemo(() => buildArc(SWEEP_HALF + STREAK_HALF, 0.5, 1.08), []);
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        vertexColors: true,
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
      mesh.geometry = key === 'overhead' || key === 'thrust' ? streak : sweepArc;
      material.color.copy(key === 'overhead' || key === 'thrust' ? WARM : COOL);
    }

    const at = (now - playingSince.current) / SLASH_FX_MS;
    if (at < 0 || at > 1) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    material.opacity = Math.min(1, at / 0.12) * 0.95;

    const [x, y, z] = p.transform.position;
    const rot = p.transform.rotationY;
    const key = comboAt(moveIdx.current).key;
    const isSweep = key !== 'overhead' && key !== 'thrust';

    // The arc stays put; a bright head travels across it and the tail dissolves behind it,
    // so the streak visibly dies from where the swing started toward where it ended.
    const colorAttr = mesh.geometry.getAttribute('color') as Float32BufferAttribute;
    const colors = colorAttr.array as Float32Array;
    const seg = colors.length / 6 - 1;
    const head = smooth(Math.min(1, at / SWEEP_END));
    const tailEdge = at * (1 + TRAIL) - TRAIL;
    const cut = (1 - at) * (1 + FADE_FEATHER);
    const direction = key === 'reverse' ? -1 : 1;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      for (let v = 0; v < 2; v++) {
        let b: number;
        if (isSweep) {
          // w = 0 where the swing starts, 1 where it ends.
          const w = direction === 1 ? 1 - t : t;
          const tailFade = smooth(clamp01((w - tailEdge) / TRAIL));
          const headFade = 1 - smooth(clamp01((w - head) / HEAD_FEATHER));
          const hot = smooth(clamp01(1 - Math.abs(w - head) / 0.15));
          b = tailFade * headFade * (1 + hot * HEAD_GLOW);
        } else {
          // Radial dissolve: inner rim (tail) dies first, outer rim (head) last.
          const u = v === 1 ? 0 : 1;
          b = smooth(clamp01((cut - u) / FADE_FEATHER));
        }
        const o = (i * 2 + v) * 3;
        colors[o] = b;
        colors[o + 1] = b;
        colors[o + 2] = b;
      }
    }
    colorAttr.needsUpdate = true;

    if (key === 'overhead') {
      mesh.position.set(x, y + 1.8 - smooth(at) * 1.35, z);
      mesh.rotation.set(0, rot, 0);
      const grow = 1.05 - at * 0.35;
      mesh.scale.set(grow, 1, grow);
    } else if (key === 'thrust') {
      mesh.position.set(x, y + 0.95, z);
      mesh.rotation.set(0, rot, 0);
      mesh.scale.set(0.5 + at * 0.8, 1, 0.7);
    } else {
      mesh.position.set(x, y + 1.0, z);
      mesh.rotation.set(0, rot, 0);
      const grow = 0.85 + at * 0.25;
      mesh.scale.set(grow, 1, grow);
    }
  });

  return (
    <mesh ref={meshRef} geometry={streak} material={material} frustumCulled={false} visible={false} />
  );
};
