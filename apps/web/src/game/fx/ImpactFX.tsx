import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  RingGeometry,
} from 'three';
import { world } from '@/game/ecs/world';
import type { Entity } from '@/game/ecs/components';

/**
 * IMPACT VFX — a spark burst + an expanding shockwave ring at every contact point.
 *
 * Both are pooled and animated on REAL time (`performance.now()` vs the FX's own
 * `spawnedAtReal`), so on the frozen hitstop frame the characters hang mid-clash while the
 * sparks fly and the ring blooms. That contrast is the whole point.
 *
 * `impactFxSystem` (real-time) removes the marker entities when their lifetime ends.
 */

const SPARK_POOL = 16;
const RING_POOL = 16;
const MAX_SHARDS = 16;

/** Decelerating ease — fast out of the gate, settling toward the end. */
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

interface SparkSlot {
  points: Points;
  geometry: BufferGeometry;
  material: PointsMaterial;
  /** Per-shard unit direction, filled on assignment. */
  dirs: Float32Array;
}

interface RingSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
}

export const ImpactFX = () => {
  const sparks = useMemo<SparkSlot[]>(
    () =>
      Array.from({ length: SPARK_POOL }, () => {
        const geometry = new BufferGeometry();
        geometry.setAttribute(
          'position',
          new Float32BufferAttribute(new Float32Array(MAX_SHARDS * 3), 3),
        );
        const material = new PointsMaterial({
          size: 0.22,
          transparent: true,
          blending: AdditiveBlending,
          depthWrite: false,
          sizeAttenuation: true,
        });
        const points = new Points(geometry, material);
        points.visible = false;
        points.frustumCulled = false;
        return { points, geometry, material, dirs: new Float32Array(MAX_SHARDS * 3) };
      }),
    [],
  );

  const rings = useMemo<RingSlot[]>(
    () =>
      Array.from({ length: RING_POOL }, () => {
        const geometry = new RingGeometry(0.62, 1.0, 40);
        const material = new MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          side: DoubleSide,
          depthWrite: false,
        });
        const mesh = new Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2; // lie flat on the ground plane
        mesh.visible = false;
        mesh.frustumCulled = false;
        return { mesh, material };
      }),
    [],
  );

  const sparkSlotOf = useRef(new Map<Entity, number>());
  const sparkFree = useRef<number[]>(Array.from({ length: SPARK_POOL }, (_, i) => i));
  const ringSlotOf = useRef(new Map<Entity, number>());
  const ringFree = useRef<number[]>(Array.from({ length: RING_POOL }, (_, i) => i));

  useFrame(() => {
    const now = performance.now();
    const activeSpark = new Set<Entity>();
    const activeRing = new Set<Entity>();

    for (const e of world.with('impactFx', 'transform')) {
      const fx = e.impactFx;
      const age = (now - fx.spawnedAtReal) / fx.lifetimeMs;
      if (age < 0 || age > 1) continue;
      const [x, y, z] = e.transform.position;

      if (fx.kind === 'spark') {
        activeSpark.add(e);
        let slot = sparkSlotOf.current.get(e);
        if (slot === undefined) {
          const next = sparkFree.current.pop();
          if (next === undefined) continue;
          slot = next;
          sparkSlotOf.current.set(e, slot);
          const s = sparks[slot]!;
          // Randomize shard directions once (biased upward + outward).
          for (let i = 0; i < MAX_SHARDS; i++) {
            const a = Math.random() * Math.PI * 2;
            const up = 0.3 + Math.random() * 0.9;
            const r = Math.random();
            s.dirs[i * 3] = Math.cos(a) * r;
            s.dirs[i * 3 + 1] = up;
            s.dirs[i * 3 + 2] = Math.sin(a) * r;
          }
          s.material.color.setRGB(fx.color[0], fx.color[1], fx.color[2]);
          s.geometry.setDrawRange(0, fx.count);
        }
        const s = sparks[slot]!;
        const reach = fx.radius * easeOut(age);
        const pos = s.geometry.getAttribute('position') as Float32BufferAttribute;
        const arr = pos.array as Float32Array;
        for (let i = 0; i < fx.count; i++) {
          arr[i * 3] = x + s.dirs[i * 3]! * reach;
          arr[i * 3 + 1] = y + s.dirs[i * 3 + 1]! * reach - age * age * 0.6; // slight gravity
          arr[i * 3 + 2] = z + s.dirs[i * 3 + 2]! * reach;
        }
        pos.needsUpdate = true;
        s.material.opacity = 1 - age;
        s.material.size = 0.24 * (1 - age * 0.6);
        s.points.visible = true;
      } else {
        activeRing.add(e);
        let slot = ringSlotOf.current.get(e);
        if (slot === undefined) {
          const next = ringFree.current.pop();
          if (next === undefined) continue;
          slot = next;
          ringSlotOf.current.set(e, slot);
          rings[slot]!.material.color.setRGB(fx.color[0], fx.color[1], fx.color[2]);
        }
        const r = rings[slot]!;
        const scale = fx.radius * easeOut(age);
        r.mesh.position.set(x, y + 0.06, z);
        r.mesh.scale.setScalar(Math.max(0.001, scale));
        r.material.opacity = (1 - age) * 0.85;
        r.mesh.visible = true;
      }
    }

    // Release slots whose FX entities have expired/despawned.
    for (const [e, slot] of sparkSlotOf.current) {
      if (activeSpark.has(e)) continue;
      sparkSlotOf.current.delete(e);
      sparkFree.current.push(slot);
      sparks[slot]!.points.visible = false;
    }
    for (const [e, slot] of ringSlotOf.current) {
      if (activeRing.has(e)) continue;
      ringSlotOf.current.delete(e);
      ringFree.current.push(slot);
      rings[slot]!.mesh.visible = false;
    }
  });

  return (
    <>
      {sparks.map((s, i) => (
        <primitive key={`spark-${i}`} object={s.points} />
      ))}
      {rings.map((r, i) => (
        <primitive key={`ring-${i}`} object={r.mesh} />
      ))}
    </>
  );
};
