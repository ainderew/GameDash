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
import { COMBO_MOVES, comboAt, moveActiveWindow } from '@sim/combat/combo';
import { currentWeapon } from '@/game/combat/weaponStore';
import { gameNow } from '@/game/feel/time';
import { heightAt } from '@sim/terrain/terrainHeight';
import { MELEE_RANGE } from '@shared/balance';

const players = world.with('playerControlled', 'transform');

/** Inner radius of the sector as a fraction of reach — leaves the feet visible. */
const INNER = 0.18;
/** Height above the terrain, world units — clears grass roots without floating. */
const LIFT = 0.05;

const TELEGRAPH = new Color('#7fc4ff'); // windup: cool "incoming" tint
const ACTIVE = new Color('#ff8a3c'); // hitbox live: hot
const OPACITY_TELEGRAPH = 0.22;
const OPACITY_ACTIVE = 0.55;
const OPACITY_TAIL = 0.28; // start of the post-hit fade

/**
 * Unit-radius flat ring sector in the XZ plane centered on +Z (the entity's facing once the
 * mesh takes the player's rotationY) — same convention as SlashFX. Scaled to reach at render.
 */
const buildSector = (halfArc: number): BufferGeometry => {
  const SEG = halfArc > 1 ? 48 : 24;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= SEG; i++) {
    const ang = Math.PI / 2 - halfArc + (i / SEG) * halfArc * 2;
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    pos.push(c * INNER, 0, s * INNER);
    pos.push(c, 0, s);
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

/**
 * Ground-projected attack area: while a swing runs, draws the EXACT sector weaponSystem
 * tests (move.halfArc × MELEE_RANGE × weapon reach) at the player's feet. Cool + faint during
 * windup (the telegraph), hot while the hitbox is live, then fades out over the recovery tail.
 * Vanishes instantly on a dodge-cancel (attackAnimUntil is zeroed). Cosmetic only.
 */
export const AttackArcIndicator = () => {
  const meshRef = useRef<Mesh>(null);
  // One prebuilt sector per combo move (halfArc differs: slash 60°, spin = full circle…).
  const sectors = useMemo(() => COMBO_MOVES.map((m) => buildSector(m.halfArc)), []);
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

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const p = players.first;
    const now = gameNow();
    const until = p?.attackAnimUntil ?? 0;
    if (!p?.transform || now >= until) {
      mesh.visible = false;
      return;
    }

    const moveIdx = ((p.meleeCombo ?? 0) % COMBO_MOVES.length + COMBO_MOVES.length) % COMBO_MOVES.length;
    const move = comboAt(moveIdx);
    const geo = sectors[moveIdx]!;
    if (mesh.geometry !== geo) mesh.geometry = geo;

    // Phase → look. Ages are on the game clock, so hitstop freezes the indicator too.
    const age = now - (p.meleeStartedAt ?? now);
    const { start, end } = moveActiveWindow(move);
    if (age < start) {
      material.color.copy(TELEGRAPH);
      material.opacity = OPACITY_TELEGRAPH * (0.5 + 0.5 * (age / Math.max(start, 1)));
    } else if (age < end) {
      material.color.copy(ACTIVE);
      material.opacity = OPACITY_ACTIVE;
    } else {
      const tail = Math.max(until - (p.meleeStartedAt ?? 0) - end, 1);
      material.color.copy(ACTIVE);
      material.opacity = OPACITY_TAIL * Math.max(0, 1 - (age - end) / tail);
    }

    const [x, , z] = p.transform.position;
    mesh.visible = true;
    mesh.position.set(x, heightAt(x, z) + LIFT, z);
    mesh.rotation.y = p.transform.rotationY;
    const reach = MELEE_RANGE * currentWeapon().reachMul;
    mesh.scale.set(reach, 1, reach);
  });

  return (
    <mesh
      ref={meshRef}
      name="attack-arc-indicator"
      geometry={sectors[0]}
      material={material}
      frustumCulled={false}
      visible={false}
    />
  );
};
