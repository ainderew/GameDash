import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import { world } from '@/game/ecs/world';
import type { Entity } from '@/game/ecs/components';
import { DAMAGE_NUMBER_LIFETIME_MS } from '@/game/ecs/systems/combatHelpers';

const POOL = 24;

/* eslint-disable @typescript-eslint/no-explicit-any */
type TextRef = any;

/**
 * Floating damage numbers via a fixed pool of Troika text meshes, mapped to
 * floatingNumber entities with stable slots. Numbers rise and fade over their
 * lifetime. Imperative updates — no per-frame React re-render.
 */
export const DamageNumbers = () => {
  const refs = useRef<(TextRef | null)[]>([]);
  const slotOf = useRef(new Map<Entity, number>());
  const free = useRef<number[]>(Array.from({ length: POOL }, (_, i) => i));

  useFrame(() => {
    const now = performance.now();
    const active = new Set<Entity>();

    for (const e of world.with('floatingNumber', 'transform')) {
      active.add(e);
      let slot = slotOf.current.get(e);
      if (slot === undefined) {
        const next = free.current.pop();
        if (next === undefined) continue; // pool exhausted
        slot = next;
        slotOf.current.set(e, slot);
        const t = refs.current[slot];
        if (t) {
          t.text = `${e.floatingNumber.crit ? '✦' : ''}${e.floatingNumber.amount}`;
          t.color = e.floatingNumber.crit ? '#fbbf24' : '#ffffff';
          t.sync?.();
        }
      }
      const t = refs.current[slot];
      if (!t) continue;
      const age = (now - e.floatingNumber.spawnedAt) / DAMAGE_NUMBER_LIFETIME_MS;
      const [x, y, z] = e.transform.position;
      t.visible = true;
      t.position.set(x, y + age * 1.3, z);
      if (t.material) {
        t.material.transparent = true;
        t.material.depthTest = false;
        t.material.opacity = Math.max(0, 1 - age);
      }
    }

    // Release slots whose entities have expired.
    for (const [e, slot] of slotOf.current) {
      if (active.has(e)) continue;
      slotOf.current.delete(e);
      free.current.push(slot);
      const t = refs.current[slot];
      if (t) t.visible = false;
    }
  });

  return (
    <>
      {Array.from({ length: POOL }, (_, i) => (
        <Text
          key={i}
          ref={(r: TextRef) => (refs.current[i] = r)}
          visible={false}
          fontSize={0.6}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.04}
          outlineColor="#000000"
          renderOrder={999}
        >
          {' '}
        </Text>
      ))}
    </>
  );
};
