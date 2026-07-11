import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Color } from 'three';
import type { Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { world, relics } from '@/game/ecs/world';
import { passAim } from '@/game/combat/passAim';
import { useGameModel } from '@/lib/loaders';
import { heightAt } from '@sim/terrain/terrainHeight';
import { RELIC_GROUND_HOVER } from '@shared/balance';

/**
 * The Relic model ships as four Tripo parts, composed here to match the concept art:
 * the teal core crystal is the centerpiece, two mirrored shell claws arc around it,
 * the base hovers underneath as a pedestal, and the rune fragment is instanced three
 * times as golden orbiting shards. Emissives are added at runtime — the exports have none.
 */
const SHELL_PATH = '/models/relic/shell.glb';
const CORE_PATH = '/models/relic/core.glb';
const RUNE_PATH = '/models/relic/rune_fragment.glb';
const BASE_PATH = '/models/relic/base.glb';
useGameModel.preload(SHELL_PATH);
useGameModel.preload(CORE_PATH);
useGameModel.preload(RUNE_PATH);
useGameModel.preload(BASE_PATH);

/** Where the Relic waits at the start of a session (in front of the player spawn). */
const RELIC_SPAWN: [number, number] = [1.5, -4];

/** How fast the carried Relic's visual chases its logical anchor (higher = tighter). */
const FOLLOW_RATE = 10;

const GOLD = '#fbbf24';
const TEAL = '#5eead4';

/** Apply an emissive glow to every material under a loaded part. */
const addGlow = (root: Object3D, hex: string, intensity: number): MeshStandardMaterial | null => {
  let first: MeshStandardMaterial | null = null;
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const sm = m as MeshStandardMaterial;
      if (!sm.isMeshStandardMaterial) continue;
      sm.emissive = new Color(hex);
      sm.emissiveIntensity = intensity;
      sm.toneMapped = false;
      if (!first) first = sm;
    }
  });
  return first;
};

const RelicModel = ({ shardsRef, coreMat }: {
  shardsRef: React.MutableRefObject<Group | null>;
  coreMat: React.MutableRefObject<MeshStandardMaterial | null>;
}) => {
  const shell = useGameModel(SHELL_PATH);
  const core = useGameModel(CORE_PATH);
  const rune = useGameModel(RUNE_PATH);
  const base = useGameModel(BASE_PATH);
  // Static meshes: plain clones share geometry + materials across the instances.
  const claws = useMemo(() => [0, 1].map(() => shell.scene.clone(true)), [shell]);
  const runes = useMemo(() => [0, 1, 2].map(() => rune.scene.clone(true)), [rune]);

  useEffect(() => {
    for (const part of [...claws, base.scene]) {
      part.traverse((o) => {
        if ((o as Mesh).isMesh) o.castShadow = true;
      });
    }
    // The core runs hot so bloom reads it (same trick as projectiles); the pulse in
    // Relic's useFrame modulates this material's emissiveIntensity.
    // Moderate heat: enough for bloom to catch, low enough that the facets stay readable.
    coreMat.current = addGlow(core.scene, TEAL, 1.0);
    // Fragments share materials (clones), so one pass tints all three.
    if (runes[0]) addGlow(runes[0], GOLD, 1.2);
  }, [claws, core, base, runes, coreMat]);

  return (
    // Each Tripo part is normalized to ~1 unit tall; scales/offsets below rebuild the
    // concept-art assembly around the group origin (= the crystal's center).
    <group scale={0.85}>
      <primitive object={core.scene} scale={0.85} position={[0, 0.05, 0]} />
      {/* Mirrored claws cradling the crystal: curve plane turned inward, tips leaning out. */}
      {claws.map((c, k) => {
        const side = k === 0 ? -1 : 1;
        return (
          <primitive
            key={k}
            object={c}
            position={[side * 0.36, -0.1, 0]}
            rotation={[0, (side * Math.PI) / 2, side * 0.3]}
            scale={0.85}
          />
        );
      })}
      <primitive object={base.scene} scale={0.55} position={[0, -0.62, 0]} />
      <group ref={shardsRef}>
        {runes.map((r, k) => {
          const a = (k / 3) * Math.PI * 2;
          return (
            <primitive
              key={k}
              object={r}
              scale={0.24}
              position={[Math.cos(a) * 0.68, 0.12 + (k - 1) * 0.12, Math.sin(a) * 0.68]}
              rotation={[0, -a, 0]}
            />
          );
        })}
      </group>
    </group>
  );
};

/**
 * The living Relic: owns the ECS entity and renders it. The relicSystem authors the
 * LOGICAL position (carry anchor / flight arc / ground hover) — this component adds only
 * the life on top: trailing float while carried, bob, spin, and the pulsing core.
 */
export const Relic = () => {
  const group = useRef<Group>(null);
  const spinner = useRef<Group>(null);
  const shards = useRef<Group>(null);
  const coreMat = useRef<MeshStandardMaterial | null>(null);
  const started = useRef(false);

  useEffect(() => {
    const [sx, sz] = RELIC_SPAWN;
    const entity = world.add({
      transform: { position: [sx, heightAt(sx, sz) + RELIC_GROUND_HOVER, sz], rotationY: 0 },
      relic: { phase: 'grounded' },
    });
    return () => {
      world.remove(entity);
    };
  }, []);

  useFrame((_, dt) => {
    const g = group.current;
    const e = relics.first;
    if (!g || !e) return;
    const [x, y, z] = e.transform.position;
    const inFlight = e.relic.phase === 'inFlight';
    const t = performance.now() * 0.001;

    // Bob is render-only; catches test the logical position, so juice never changes rules.
    // Aiming steadies the float — the Relic focuses on the throw.
    const bobAmp = passAim.aiming ? 0.02 : 0.07;
    const bob = inFlight ? 0 : Math.sin(t * 2.2) * bobAmp;
    if (inFlight || !started.current) {
      // Flight is authored by the system frame-by-frame — track it exactly.
      g.position.set(x, y, z);
      started.current = true;
    } else {
      // Carried/grounded: chase the anchor so the crystal drifts like it's alive.
      const k = 1 - Math.exp(-FOLLOW_RATE * dt);
      g.position.x += (x - g.position.x) * k;
      g.position.y += (y + bob - g.position.y) * k;
      g.position.z += (z - g.position.z) * k;
    }

    if (spinner.current) spinner.current.rotation.y += dt * (inFlight ? 6 : passAim.aiming ? 0.6 : 1.3);
    if (shards.current) shards.current.rotation.y -= dt * (inFlight ? 8 : 2.1);
    // Core brightens while aiming (charging the throw), pulses gently otherwise.
    const coreBase = passAim.aiming ? 1.7 : 1.0;
    if (coreMat.current) coreMat.current.emissiveIntensity = coreBase + Math.sin(t * 3.1) * 0.35;
  });

  return (
    <group ref={group}>
      {/* Warm gold spill to match the concept art's energy; the core supplies the teal. */}
      <pointLight color="#ffcf7d" intensity={4} distance={6} decay={2} />
      <group ref={spinner}>
        <RelicModel shardsRef={shards} coreMat={coreMat} />
      </group>
    </group>
  );
};
