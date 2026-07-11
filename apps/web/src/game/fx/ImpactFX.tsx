import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  RingGeometry,
} from 'three';
import { world } from '@/game/ecs/world';
import type { Entity } from '@sim/components';
import { feel } from '@/game/feel/config';

/**
 * CONTACT IMPACT VFX
 *
 * A high-end hit needs a very short, white-hot read at the contact point, followed by a
 * small number of sword-directed sparks. This uses geometry rather than a flipbook: no
 * texture fetches, no runtime asset loading, and no alpha-sheet overdraw. Every renderer
 * object and GPU buffer is preallocated; a hit only claims a slot and writes its dynamic
 * vertices. Animation deliberately uses real time, so the burst blooms during hitstop.
 */

const SPARK_POOL = 12;
const RING_POOL = 12;
const MAX_SHARDS = 16;

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const smoothstep = (t: number): number => t * t * (3 - 2 * t);

interface SparkSlot {
  points: Points;
  streaks: LineSegments;
  pointGeometry: BufferGeometry;
  streakGeometry: BufferGeometry;
  pointMaterial: PointsMaterial;
  streakMaterial: LineBasicMaterial;
  /** Local-space spark directions, seeded once when the pooled slot is claimed. */
  dirs: Float32Array;
}

interface RingSlot {
  mesh: Mesh;
  material: MeshBasicMaterial;
}

const makeSparkSlot = (): SparkSlot => {
  const pointGeometry = new BufferGeometry();
  const pointPositions = new Float32BufferAttribute(new Float32Array(MAX_SHARDS * 3), 3);
  const pointColors = new Float32BufferAttribute(new Float32Array(MAX_SHARDS * 3), 3);
  pointPositions.setUsage(DynamicDrawUsage);
  pointGeometry.setAttribute('position', pointPositions);
  pointGeometry.setAttribute('color', pointColors);

  const streakGeometry = new BufferGeometry();
  // Three connected segments per shard: tail → zig-zag bend → tip, plus a small fork.
  // LineSegments needs two vertices for each independent segment (six vertices total).
  const streakPositions = new Float32BufferAttribute(new Float32Array(MAX_SHARDS * 6 * 3), 3);
  const streakColors = new Float32BufferAttribute(new Float32Array(MAX_SHARDS * 6 * 3), 3);
  streakPositions.setUsage(DynamicDrawUsage);
  streakGeometry.setAttribute('position', streakPositions);
  streakGeometry.setAttribute('color', streakColors);

  const pointMaterial = new PointsMaterial({
    size: 0.16,
    vertexColors: true,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const streakMaterial = new LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const points = new Points(pointGeometry, pointMaterial);
  const streaks = new LineSegments(streakGeometry, streakMaterial);
  points.visible = false;
  streaks.visible = false;
  points.frustumCulled = false;
  streaks.frustumCulled = false;
  return {
    points,
    streaks,
    pointGeometry,
    streakGeometry,
    pointMaterial,
    streakMaterial,
    dirs: new Float32Array(MAX_SHARDS * 3),
  };
};

/** Bounded, pooled fantasy sword impacts. There are never more than 24 cosmetic drawables. */
export const ImpactFX = () => {
  const sparks = useMemo<SparkSlot[]>(
    () => Array.from({ length: SPARK_POOL }, makeSparkSlot),
    [],
  );
  const rings = useMemo<RingSlot[]>(
    () =>
      Array.from({ length: RING_POOL }, () => {
        // Low segment count is intentional: bloom rounds the silhouette while preserving a
        // faceted, magical flash and keeping fragment/vertex work negligible.
        const geometry = new RingGeometry(0.42, 1, 24);
        const material = new MeshBasicMaterial({
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          side: DoubleSide,
          depthWrite: false,
        });
        const mesh = new Mesh(geometry, material);
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
  // Reused frame markers avoid allocating Sets every frame on the render hot path.
  const activeSparks = useRef(new Uint8Array(SPARK_POOL));
  const activeRings = useRef(new Uint8Array(RING_POOL));

  useFrame((state) => {
    const now = performance.now();
    const sparkMarks = activeSparks.current;
    const ringMarks = activeRings.current;
    sparkMarks.fill(0);
    ringMarks.fill(0);

    for (const e of world.with('impactFx', 'transform')) {
      const fx = e.impactFx;
      const age = (now - fx.spawnedAtReal) / fx.lifetimeMs;
      if (age < 0 || age > 1) continue;
      const [x, y, z] = e.transform.position;

      if (fx.kind === 'spark') {
        let slot = sparkSlotOf.current.get(e);
        if (slot === undefined) {
          const next = sparkFree.current.pop();
          if (next === undefined) continue; // cosmetic cap: gameplay never waits for VFX
          slot = next;
          sparkSlotOf.current.set(e, slot);
          const s = sparks[slot]!;
          const pointColors = s.pointGeometry.getAttribute('color') as Float32BufferAttribute;
          const streakColors = s.streakGeometry.getAttribute('color') as Float32BufferAttribute;
          const pc = pointColors.array as Float32Array;
          const sc = streakColors.array as Float32Array;
          const count = Math.min(fx.count, MAX_SHARDS);

          for (let i = 0; i < count; i++) {
            // Bias the burst outward from the blade. The random cone is sampled once per
            // impact, not per frame, producing clean, coherent streaks instead of jitter.
            const lateral = (Math.random() - 0.5) * 1.35;
            const forward = 0.55 + Math.random() * 0.8;
            let dx = fx.dirX * forward - fx.dirZ * lateral;
            let dz = fx.dirZ * forward + fx.dirX * lateral;
            if (Math.abs(fx.dirX) + Math.abs(fx.dirZ) < 0.01) {
              const a = Math.random() * Math.PI * 2;
              dx = Math.cos(a);
              dz = Math.sin(a);
            }
            const dy = 0.12 + Math.random() * 0.9;
            const len = Math.hypot(dx, dy, dz) || 1;
            s.dirs[i * 3] = dx / len;
            s.dirs[i * 3 + 1] = dy / len;
            s.dirs[i * 3 + 2] = dz / len;

            // White-hot core + a rotating fantasy palette: hue comes from static vertex
            // colors, so colourful shards cost neither another material nor texture fetch.
            const white = i % 4 === 0;
            const color = feel.vfx.sparkColors[fx.strength][i % feel.vfx.sparkColors[fx.strength].length]!;
            // Values above one deliberately cross the Bloom threshold for a short electric
            // flash; this is cheaper than adding a light or an extra glow sprite per hit.
            const r = white ? 1.8 : color[0] * 1.35;
            const g = white ? 1.55 : color[1] * 1.35;
            const b = white ? 1.15 : color[2] * 1.35;
            pc[i * 3] = r;
            pc[i * 3 + 1] = g;
            pc[i * 3 + 2] = b;
            for (let vertex = 0; vertex < 6; vertex++) {
              const offset = i * 18 + vertex * 3;
              sc[offset] = r;
              sc[offset + 1] = g;
              sc[offset + 2] = b;
            }
          }
          pointColors.needsUpdate = true;
          streakColors.needsUpdate = true;
          s.pointGeometry.setDrawRange(0, count);
          s.streakGeometry.setDrawRange(0, count * 6);
        }
        sparkMarks[slot] = 1;
        const s = sparks[slot]!;
        const count = Math.min(fx.count, MAX_SHARDS);
        const burst = Math.min(1, age / 0.1);
        const reach = fx.radius * easeOut(age) * burst;
        const pointPositions = s.pointGeometry.getAttribute('position') as Float32BufferAttribute;
        const streakPositions = s.streakGeometry.getAttribute('position') as Float32BufferAttribute;
        const pp = pointPositions.array as Float32Array;
        const sp = streakPositions.array as Float32Array;

        for (let i = 0; i < count; i++) {
          const dx = s.dirs[i * 3]!;
          const dy = s.dirs[i * 3 + 1]!;
          const dz = s.dirs[i * 3 + 2]!;
          const distance = reach * (0.5 + (i % 5) * 0.12);
          const px = dx * distance;
          const py = dy * distance - age * age * 0.45;
          const pz = dz * distance;
          pp[i * 3] = px;
          pp[i * 3 + 1] = py;
          pp[i * 3 + 2] = pz;
          // Lightning spreads as a zig-zag rather than a straight tracer. The lateral bend
          // is stable for a burst, so it reads as an electric crack—not frame-to-frame noise.
          const tail = Math.max(0, distance - fx.radius * (0.22 + age * 0.18));
          const sign = i % 2 === 0 ? 1 : -1;
          const zig = fx.radius * (0.06 + (i % 3) * 0.025) * (1 - age * 0.35);
          const middle = tail + (distance - tail) * 0.55;
          const mx = dx * middle - dz * zig * sign;
          const my = dy * middle - age * age * 0.45 + zig * 0.2;
          const mz = dz * middle + dx * zig * sign;
          // Every third spark forks; the other lines collapse their fork to a zero-length
          // segment. This preserves the fixed buffer and draw count for every hit strength.
          const forkLength = i % 3 === 0 ? fx.radius * (fx.strength === 'heavy' ? 0.26 : 0.16) : 0;
          const fx2 = mx - dz * forkLength * sign + dx * forkLength * 0.2;
          const fy2 = my - forkLength * 0.35;
          const fz2 = mz + dx * forkLength * sign + dz * forkLength * 0.2;
          const offset = i * 18;
          sp[offset] = dx * tail;
          sp[offset + 1] = dy * tail - age * age * 0.45;
          sp[offset + 2] = dz * tail;
          sp[offset + 3] = mx;
          sp[offset + 4] = my;
          sp[offset + 5] = mz;
          sp[offset + 6] = mx;
          sp[offset + 7] = my;
          sp[offset + 8] = mz;
          sp[offset + 9] = px;
          sp[offset + 10] = py;
          sp[offset + 11] = pz;
          sp[offset + 12] = mx;
          sp[offset + 13] = my;
          sp[offset + 14] = mz;
          sp[offset + 15] = fx2;
          sp[offset + 16] = fy2;
          sp[offset + 17] = fz2;
        }
        pointPositions.needsUpdate = true;
        streakPositions.needsUpdate = true;
        const fade = 1 - smoothstep(age);
        s.pointMaterial.opacity = fade;
        s.streakMaterial.opacity = fade * 0.9;
        s.pointMaterial.size = (0.13 + (1 - burst) * 0.2) * (1 - age * 0.35);
        s.points.position.set(x, y, z);
        s.streaks.position.set(x, y, z);
        s.points.visible = true;
        s.streaks.visible = true;
      } else {
        let slot = ringSlotOf.current.get(e);
        if (slot === undefined) {
          const next = ringFree.current.pop();
          if (next === undefined) continue;
          slot = next;
          ringSlotOf.current.set(e, slot);
          rings[slot]!.material.color.setRGB(fx.color[0], fx.color[1], fx.color[2]);
        }
        ringMarks[slot] = 1;
        const r = rings[slot]!;
        const bloomIn = Math.min(1, age / 0.08);
        const scale = Math.max(0.001, fx.radius * (0.2 + 0.8 * easeOut(age)) * bloomIn);
        r.mesh.position.set(x, y, z);
        // Billboard halo: readable at any camera pitch and attached to the enemy's contact
        // point rather than hovering as an unrelated, horizontal ring.
        r.mesh.quaternion.copy(state.camera.quaternion);
        r.mesh.rotateZ(Math.atan2(fx.dirX, fx.dirZ));
        r.mesh.scale.setScalar(scale);
        r.material.opacity = (1 - smoothstep(age)) * (fx.strength === 'heavy' ? 0.95 : 0.7);
        r.mesh.visible = true;
      }
    }

    for (const [e, slot] of sparkSlotOf.current) {
      if (sparkMarks[slot]) continue;
      sparkSlotOf.current.delete(e);
      sparkFree.current.push(slot);
      sparks[slot]!.points.visible = false;
      sparks[slot]!.streaks.visible = false;
    }
    for (const [e, slot] of ringSlotOf.current) {
      if (ringMarks[slot]) continue;
      ringSlotOf.current.delete(e);
      ringFree.current.push(slot);
      rings[slot]!.mesh.visible = false;
    }
  });

  return (
    <>
      {sparks.map((s, i) => (
        <group key={`spark-${i}`}>
          <primitive object={s.streaks} />
          <primitive object={s.points} />
        </group>
      ))}
      {rings.map((r, i) => (
        <primitive key={`ring-${i}`} object={r.mesh} />
      ))}
    </>
  );
};
