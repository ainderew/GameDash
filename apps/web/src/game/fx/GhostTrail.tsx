import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, MeshBasicMaterial } from 'three';
import type { Bone, Group, Object3D, SkinnedMesh } from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { localPlayers, relics, world } from '@/game/ecs/world';
import { netClient } from '@/net/client';
import { relicNet } from '@/net/relicNet';
import { corruptionPowerVisual } from '@/game/fx/corruptionPower';
import { heroRig } from '@/game/entities/heroRig';

/**
 * DASH GHOST / AFTERIMAGE TRAIL
 *
 * The glowing wireframe silhouettes strung along the dash path in the reference. During
 * a dash-slash we snapshot the hero's live skeleton pose into a pool of frozen SkinnedMesh
 * clones and fade them out — so the lunge reads as a sweep through space, not a point burst.
 *
 * How the freeze works: SkeletonUtils.clone() gives each pool slot an INDEPENDENT skeleton
 * (bone order preserved, so live↔clone bones match by index). On spawn we copy the live
 * bones' local transforms into a clone and stamp the clone's world matrix from the hero's
 * current world matrix, then never touch it again — the pose is frozen in place while the
 * hero dashes on. An additive wireframe MeshBasicMaterial gives the energy-outline look
 * (skinning is automatic for basic materials on a SkinnedMesh in modern three).
 */

const POOL = 9;
const GHOST_LIFE_MS = 760; // afterimages linger a good while before dissolving
const GHOST_INTERVAL_MS = 72; // spacing between snapshots
const GHOST_DASH_MAX = 3; // at most this many afterimages per dash
const GHOST_MAX_OPACITY = 0.5;
// Per-trigger tint: the dash skill keeps its cool cyan-white; the corruption trail alternates
// violet/red so it reads as corruption. Colour is set per snapshot on each ghost's material.
const GHOST_COLOR_SKILL = new Color(0.55, 0.85, 1.15);
const GHOST_COLOR_VIOLET = new Color(0.85, 0.32, 1.5);
const GHOST_COLOR_RED = new Color(1.6, 0.16, 0.4);
/** Midpoint subdivisions applied to the ghost mesh — each level quadruples the triangle
 *  count, so the wireframe reads far denser than the low-poly hero silhouette. */
const GHOST_SUBDIVISIONS = 1;

// Corruption trigger: while the LOCAL player carries the relic at Volatile (tier 3) or above
// and is moving, leave a slower stream of afterimages — a "powered up" movement trail.
const GHOST_CORRUPT_TIER = 2; // Charged and above
const GHOST_CORRUPT_INTERVAL_MS = 150; // sparser afterimages than the dash
const GHOST_CORRUPT_MIN_SPEED = 1.6;

/** Corruption on the relic IF the local player is its carrier, else null (any net mode). */
const localCarrierCorruption = (): number | null => {
  const net = relicNet.state;
  if (net.phase !== 'absent') {
    if (net.phase === 'carried' && net.carrierId === netClient.localEntityId()) return net.corruption;
    return null;
  }
  const relic = relics.first?.relic;
  if (relic?.phase === 'carried' && relic.carrier === localPlayers.first) return relic.corruption ?? 0;
  return null;
};

type IntArrayCtor = Uint8ArrayConstructor | Uint16ArrayConstructor | Uint32ArrayConstructor;

/**
 * Midpoint-subdivide a skinned geometry, carrying skinIndex/skinWeight so the result still
 * deforms with the skeleton. Each new edge-midpoint copies its skin binding from one parent
 * vertex — imperceptible on a fast-fading wireframe, and it sidesteps the hard problem of
 * blending across differing bone-index sets. Position-only (normals/uv are irrelevant to a
 * wireframe). Falls back to the input if it isn't an indexed skinned mesh.
 */
const subdivideSkinned = (geo: BufferGeometry, levels: number): BufferGeometry => {
  const posA = geo.getAttribute('position');
  const siA = geo.getAttribute('skinIndex');
  const swA = geo.getAttribute('skinWeight');
  if (!geo.index || !posA || !siA || !swA) return geo;

  const SIType = siA.array.constructor as IntArrayCtor;
  const positions = Array.from(posA.array);
  const skinIdx = Array.from(siA.array);
  const skinWgt = Array.from(swA.array);
  let indices = Array.from(geo.index.array);
  let vertCount = posA.count;

  for (let lvl = 0; lvl < levels; lvl++) {
    const cache = new Map<string, number>();
    const out: number[] = [];
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const m = vertCount++;
      positions.push(
        (positions[a * 3]! + positions[b * 3]!) / 2,
        (positions[a * 3 + 1]! + positions[b * 3 + 1]!) / 2,
        (positions[a * 3 + 2]! + positions[b * 3 + 2]!) / 2,
      );
      const p = a; // copy skin binding from one parent
      skinIdx.push(skinIdx[p * 4]!, skinIdx[p * 4 + 1]!, skinIdx[p * 4 + 2]!, skinIdx[p * 4 + 3]!);
      skinWgt.push(skinWgt[p * 4]!, skinWgt[p * 4 + 1]!, skinWgt[p * 4 + 2]!, skinWgt[p * 4 + 3]!);
      cache.set(key, m);
      return m;
    };
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]!;
      const b = indices[i + 1]!;
      const c = indices[i + 2]!;
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      out.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    indices = out;
  }

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('skinIndex', new BufferAttribute(new SIType(skinIdx), 4));
  g.setAttribute('skinWeight', new BufferAttribute(new Float32Array(skinWgt), 4));
  g.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  return g;
};

interface Ghost {
  root: Object3D;
  mat: MeshBasicMaterial;
  bones: Bone[];
  spawnedAt: number;
}

const players = world.with('playerControlled', 'transform');

const collectBones = (root: Object3D): Bone[] => {
  const bones: Bone[] = [];
  root.traverse((o) => {
    if ((o as Bone).isBone) bones.push(o as Bone);
  });
  return bones;
};

export const GhostTrail = () => {
  const groupRef = useRef<Group>(null);
  const pool = useRef<Ghost[] | null>(null);
  const liveBones = useRef<Bone[]>([]);
  const builtFor = useRef<Object3D | null>(null);
  const head = useRef(0);
  const lastSpawn = useRef(0);
  const corruptTick = useRef(0);
  const dashGhosts = useRef(0);
  const dashStamp = useRef<number | undefined>(undefined);

  // Recreate the pool from scratch (also used to tear down on character swap).
  const build = useMemo(
    () => (live: Object3D) => {
      const group = groupRef.current;
      if (!group) return;
      // Dispose any previous pool.
      if (pool.current) {
        for (const g of pool.current) {
          group.remove(g.root);
          g.mat.dispose();
        }
      }
      liveBones.current = collectBones(live);
      // Subdivide each unique source geometry ONCE and share the result across the pool.
      const subCache = new Map<string, BufferGeometry>();
      const ghosts: Ghost[] = [];
      for (let i = 0; i < POOL; i++) {
        const root = skeletonClone(live);
        root.matrixAutoUpdate = false;
        root.visible = false;
        const mat = new MeshBasicMaterial({
          color: GHOST_COLOR_SKILL,
          wireframe: true,
          transparent: true,
          opacity: 0,
          blending: AdditiveBlending,
          depthWrite: false,
        });
        root.traverse((o) => {
          const sm = o as SkinnedMesh;
          if (sm.isSkinnedMesh) {
            const key = sm.geometry.uuid;
            let sub = subCache.get(key);
            if (!sub) {
              sub = subdivideSkinned(sm.geometry, GHOST_SUBDIVISIONS);
              subCache.set(key, sub);
            }
            sm.geometry = sub;
            sm.material = mat;
            sm.frustumCulled = false;
          }
        });
        group.add(root);
        ghosts.push({ root, mat, bones: collectBones(root), spawnedAt: -1e9 });
      }
      pool.current = ghosts;
    },
    [],
  );

  const snapshot = (now: number, color: Color): void => {
    const live = heroRig.root;
    const ghosts = pool.current;
    if (!live || !ghosts) return;
    live.updateWorldMatrix(true, false);
    const g = ghosts[head.current++ % POOL]!;
    g.mat.color.copy(color);
    // Stamp the clone's world matrix from the hero's current world transform...
    g.root.matrix.copy(live.matrixWorld);
    // ...then freeze the animated pose by copying every live bone's local transform.
    const lb = liveBones.current;
    for (let i = 0; i < g.bones.length && i < lb.length; i++) {
      g.bones[i]!.position.copy(lb[i]!.position);
      g.bones[i]!.quaternion.copy(lb[i]!.quaternion);
      g.bones[i]!.scale.copy(lb[i]!.scale);
    }
    g.root.visible = true;
    g.root.updateMatrixWorld(true);
    g.mat.opacity = GHOST_MAX_OPACITY;
    g.spawnedAt = now;
  };

  useFrame(() => {
    const live = heroRig.root;
    // Build (or rebuild after a character swap) once the rig is available.
    if (live && builtFor.current !== live) {
      build(live);
      builtFor.current = live;
    }
    const ghosts = pool.current;
    if (!ghosts) return;

    const now = performance.now();
    const player = players.first;
    const active = player?.attackState?.dashSlash === true;
    const stamp = player?.attackState?.startedAt;

    if (active && stamp !== dashStamp.current) {
      dashStamp.current = stamp;
      dashGhosts.current = 1;
      snapshot(now, GHOST_COLOR_SKILL); // seed one on the exact start frame
      lastSpawn.current = now;
    }
    if (
      active &&
      dashGhosts.current < GHOST_DASH_MAX &&
      now - lastSpawn.current >= GHOST_INTERVAL_MS
    ) {
      dashGhosts.current++;
      snapshot(now, GHOST_COLOR_SKILL);
      lastSpawn.current = now;
    }

    // Corruption tier-3+ powered movement afterimages (separate, slower cadence).
    if (!active) {
      const corr = localCarrierCorruption();
      if (corr !== null && corruptionPowerVisual(corr).tierIndex >= GHOST_CORRUPT_TIER) {
        const v = player?.velocity?.linear;
        const speed = v ? Math.hypot(v[0], v[2]) : 0;
        if (speed > GHOST_CORRUPT_MIN_SPEED && now - lastSpawn.current >= GHOST_CORRUPT_INTERVAL_MS) {
          // Alternate violet/red so the corruption trail reads as red-and-violet.
          snapshot(now, corruptTick.current++ % 2 === 0 ? GHOST_COLOR_VIOLET : GHOST_COLOR_RED);
          lastSpawn.current = now;
        }
      }
    }

    // Fade + retire active ghosts.
    for (const g of ghosts) {
      if (!g.root.visible) continue;
      const age = now - g.spawnedAt;
      if (age >= GHOST_LIFE_MS) {
        g.root.visible = false;
        continue;
      }
      g.mat.opacity = GHOST_MAX_OPACITY * (1 - age / GHOST_LIFE_MS);
    }
  });

  return <group ref={groupRef} />;
};
