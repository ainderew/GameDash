import { useFrame } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimationMixer, Box3, LoopOnce, Vector3 } from 'three';
import type { AnimationAction, AnimationClip, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { monsters } from '@/game/ecs/world';
import type { Entity } from '@/game/ecs/components';
import { useGameModel } from '@/lib/loaders';
import { collectNodeNames, prepareClip } from '@/lib/animClips';
import { hitSquash } from '@/game/entities/hitSquash';
import { gameNow } from '@/game/feel/time';
import { feel } from '@/game/feel/config';

/**
 * The MAIN enemy: a skinned, skeletally-animated mutant driving the `chaser`
 * archetype (spitter/brute remain baked instanced meshes in MonsterModels).
 * Skinned meshes can't share an InstancedMesh, so each live chaser gets a
 * SkeletonUtils clone with its own mixer — fine at wave-sized counts.
 *
 * Death: the ECS removes a monster the same tick it dies, so the dying clip is
 * played by a short-lived view-side "corpse" spawned from the removal event.
 */

// Named like the hero's set (hero.glb + anim-*.glb); raw FBX sources in assets/raw/enemy-anims.
const MODEL_PATH = '/models/enemy/enemy.glb';
const CLIP_PATHS = {
  idle: '/models/enemy/anim-idle.glb',
  walk: '/models/enemy/anim-walk.glb',
  attackL1: '/models/enemy/anim-attack-l1.glb', // Mutant Punch
  attackL2: '/models/enemy/anim-attack-l2.glb', // Mutant Swiping
  death: '/models/enemy/anim-death.glb',
} as const;

/** World-space display height, world units. */
const HEIGHT = 2.4;
/**
 * Feet correction, MODEL units (scales with HEIGHT): the Tripo model's bind pose is
 * center-normalized (mesh feet at y=-0.499) while the Mixamo clips animate the feet
 * to ≈ y=-0.012 — same convention mismatch as the hero (heroConfig.yOffsetAdd).
 * Measured via the __scene dev handle: skinned world-box min.y minus entity ground.
 */
const FEET_ADJUST = -0.487;
/** Moving faster than this plays the walk clip. */
const WALK_THRESHOLD = 0.3;
/** Attack clips play sped up so the swing reads snappy (damage lands at swing start). */
const ATTACK_TIMESCALE = 1.4;
const FADE = 0.15;
const FADE_FAST = 0.06;
/** Corpse lingers this long after the dying clip finishes, then unmounts. */
const CORPSE_LINGER_MS = 1500;
const MAX_CORPSES = 8;

type MutantState = 'idle' | 'walk' | 'attack-l1' | 'attack-l2';
type MutantClips = Record<'idle' | 'walk' | 'attackL1' | 'attackL2' | 'death', AnimationClip>;

interface Norm {
  scale: number;
  yOffset: number;
}

interface Corpse {
  id: number;
  position: [number, number, number];
  rotationY: number;
}

/** Stable React keys for ECS entities (miniplex entities are plain objects). */
let nextKey = 1;
const keys = new WeakMap<Entity, number>();
const keyFor = (e: Entity): number => {
  let k = keys.get(e);
  if (!k) {
    k = nextKey++;
    keys.set(e, k);
  }
  return k;
};

/** Load the mutant model + clips and derive the shared normalization. */
const useMutantAssets = () => {
  const model = useGameModel(MODEL_PATH);
  const idle = useGameModel(CLIP_PATHS.idle);
  const walk = useGameModel(CLIP_PATHS.walk);
  const attackL1 = useGameModel(CLIP_PATHS.attackL1);
  const attackL2 = useGameModel(CLIP_PATHS.attackL2);
  const death = useGameModel(CLIP_PATHS.death);

  const rigBones = useMemo(() => collectNodeNames(model.scene), [model.scene]);

  const clips = useMemo<MutantClips>(
    () => ({
      idle: prepareClip(idle.animations[0]!, 'idle', rigBones),
      walk: prepareClip(walk.animations[0]!, 'walk', rigBones),
      attackL1: prepareClip(attackL1.animations[0]!, 'attack-l1', rigBones),
      attackL2: prepareClip(attackL2.animations[0]!, 'attack-l2', rigBones),
      death: prepareClip(death.animations[0]!, 'death', rigBones),
    }),
    [rigBones, idle.animations, walk.animations, attackL1.animations, attackL2.animations, death.animations],
  );

  const norm = useMemo<Norm>(() => {
    const box = new Box3().setFromObject(model.scene);
    const s = HEIGHT / (box.getSize(new Vector3()).y || 1);
    return { scale: s, yOffset: (-box.min.y + FEET_ADJUST) * s };
  }, [model.scene]);

  return { scene: model.scene, clips, norm };
};

interface Rig {
  root: Object3D;
  mixer: AnimationMixer;
  flashMats: { mat: MeshStandardMaterial; base: [number, number, number] }[];
}

/** Skinned clone with per-instance materials (for independent hit flash) + mixer. */
const buildRig = (srcScene: Object3D): Rig => {
  const root = cloneSkeleton(srcScene);
  const flashMats: Rig['flashMats'] = [];
  root.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // skinned bounds jitter; don't cull mid-swing
    const cloned = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) =>
      (m as MeshStandardMaterial).clone(),
    );
    mesh.material = Array.isArray(mesh.material) ? cloned : cloned[0]!;
    for (const m of cloned) {
      if (m.isMeshStandardMaterial) flashMats.push({ mat: m, base: [m.emissive.r, m.emissive.g, m.emissive.b] });
    }
  });
  return { root, mixer: new AnimationMixer(root), flashMats };
};

const disposeRig = (rig: Rig): void => {
  rig.mixer.stopAllAction();
  rig.flashMats.forEach(({ mat }) => mat.dispose());
};

interface MutantProps {
  entity: Entity;
  scene: Object3D;
  clips: MutantClips;
  norm: Norm;
}

/** One live chaser: transform mirrored from the ECS, clips resolved from AI state. */
const Mutant = ({ entity, scene, clips, norm }: MutantProps) => {
  const group = useRef<Group>(null);
  const rig = useMemo(() => buildRig(scene), [scene]);

  const actions = useMemo(() => {
    const a: Record<MutantState, AnimationAction> = {
      idle: rig.mixer.clipAction(clips.idle),
      walk: rig.mixer.clipAction(clips.walk),
      'attack-l1': rig.mixer.clipAction(clips.attackL1),
      'attack-l2': rig.mixer.clipAction(clips.attackL2),
    };
    for (const attack of [a['attack-l1'], a['attack-l2']]) {
      attack.setLoop(LoopOnce, 1);
      attack.clampWhenFinished = true;
      attack.timeScale = ATTACK_TIMESCALE;
    }
    return a;
  }, [rig, clips]);

  const current = useRef<MutantState>('idle');
  const lastAttackStamp = useRef(0);
  /** Flips before each swing, so the FIRST attack plays l1 (the punch). */
  const attackVariant = useRef<'attack-l1' | 'attack-l2'>('attack-l2');
  const attackAnimUntil = useRef(0);
  const wasFlashing = useRef(false);

  useEffect(() => {
    // (Re)start the current action HERE, not in the actions memo: StrictMode's dev
    // mount→unmount→mount runs the cleanup (stopAllAction) without re-running memos,
    // which froze never-aggroed mutants in bind pose (the T-pose bug).
    actions[current.current].reset().play();
    return () => disposeRig(rig);
  }, [rig, actions]);

  useFrame((_, delta) => {
    const g = group.current;
    const e = entity;
    if (!g || !e.transform) return;
    const now = gameNow();
    rig.mixer.update(delta);

    // A new attack stamp alternates l1 (punch) / l2 (swipe) and opens the swing window.
    const at = e.attackStartedAt ?? 0;
    if (at > lastAttackStamp.current) {
      lastAttackStamp.current = at;
      attackVariant.current = attackVariant.current === 'attack-l1' ? 'attack-l2' : 'attack-l1';
      const clip = attackVariant.current === 'attack-l1' ? clips.attackL1 : clips.attackL2;
      attackAnimUntil.current = at + (clip.duration / ATTACK_TIMESCALE) * 1000;
    }

    const [vx, , vz] = e.velocity?.linear ?? [0, 0, 0];
    const speed = Math.hypot(vx, vz);
    const next: MutantState =
      now < attackAnimUntil.current
        ? attackVariant.current
        : speed > WALK_THRESHOLD
          ? 'walk'
          : 'idle';
    if (next !== current.current) {
      const fade = next.startsWith('attack') ? FADE_FAST : FADE;
      actions[current.current].fadeOut(fade);
      actions[next].reset().fadeIn(fade).play();
      current.current = next;
    }

    // Transform from the ECS; hit-reaction squash wobbles the group scale.
    const [x, y, z] = e.transform.position;
    const [sxz, sy] = hitSquash(e, now);
    g.position.set(x, y + norm.yOffset, z);
    g.rotation.y = e.transform.rotationY; // Mixamo rigs rest-face +Z, same as atan2(dx, dz)
    g.scale.set(norm.scale * sxz, norm.scale * sy, norm.scale * sxz);

    // Per-instance hit flash on the cloned materials, fading over its window.
    const flashUntil = e.hitFlashUntil ?? 0;
    const flashing = flashUntil > now && !!e.hitFlashColor;
    if (flashing || wasFlashing.current) {
      const dur = feel.flash.durationMs[e.hitReactionStrength ?? 'light'];
      const k = flashing
        ? feel.flash.intensity * Math.max(0, Math.min(1, (flashUntil - now) / dur))
        : 0;
      const [fr, fg, fb] = e.hitFlashColor ?? [0, 0, 0];
      for (const { mat, base } of rig.flashMats) {
        mat.emissive.setRGB(base[0] + fr * k, base[1] + fg * k, base[2] + fb * k);
      }
      wasFlashing.current = flashing;
    }
  });

  return (
    <group ref={group}>
      <primitive object={rig.root} />
    </group>
  );
};

interface CorpseProps {
  corpse: Corpse;
  scene: Object3D;
  clips: MutantClips;
  norm: Norm;
  onDone: (id: number) => void;
}

/** Plays the dying clip once where the monster fell, lingers, then unmounts. */
const MutantCorpse = ({ corpse, scene, clips, norm, onDone }: CorpseProps) => {
  const rig = useMemo(() => buildRig(scene), [scene]);

  useEffect(() => {
    const action = rig.mixer.clipAction(clips.death);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    action.reset().play();
    const timer = setTimeout(() => onDone(corpse.id), clips.death.duration * 1000 + CORPSE_LINGER_MS);
    return () => {
      clearTimeout(timer);
      disposeRig(rig);
    };
  }, [rig, clips, corpse.id, onDone]);

  useFrame((_, delta) => rig.mixer.update(delta));

  return (
    <group
      position={[corpse.position[0], corpse.position[1] + norm.yOffset, corpse.position[2]]}
      rotation={[0, corpse.rotationY, 0]}
      scale={norm.scale}
    >
      <primitive object={rig.root} />
    </group>
  );
};

/** All live chaser mutants + their corpses. Mounted from MonsterModels. */
export const MutantMonsters = () => {
  const { scene, clips, norm } = useMutantAssets();
  const [live, setLive] = useState<Entity[]>([]);
  const [corpses, setCorpses] = useState<Corpse[]>([]);

  useEffect(() => {
    // Track add/remove from the event payloads — NOT by re-reading the query bucket:
    // miniplex emits onEntityRemoved while the entity is still in the bucket, so a
    // re-read keeps the dead entity and its visual lingers walking in place forever.
    setLive([...monsters].filter((m) => m.monster === 'chaser'));
    const onAdded = (e: Entity) => {
      if (e.monster !== 'chaser') return;
      setLive((prev) => (prev.includes(e) ? prev : [...prev, e]));
    };
    const onRemoved = (e: Entity) => {
      if (e.monster !== 'chaser') return;
      setLive((prev) => prev.filter((m) => m !== e));
      // Removed at ≤0 HP = died (vs. wave cleanup) — leave a corpse playing the dying clip.
      const t = e.transform;
      if ((e.health?.current ?? 1) <= 0 && t) {
        setCorpses((cs) => [
          ...cs.slice(-(MAX_CORPSES - 1)),
          {
            id: nextKey++,
            position: [...t.position] as [number, number, number],
            rotationY: t.rotationY,
          },
        ]);
      }
    };
    monsters.onEntityAdded.subscribe(onAdded);
    monsters.onEntityRemoved.subscribe(onRemoved);
    return () => {
      monsters.onEntityAdded.unsubscribe(onAdded);
      monsters.onEntityRemoved.unsubscribe(onRemoved);
    };
  }, []);

  const removeCorpse = useCallback(
    (id: number) => setCorpses((cs) => cs.filter((c) => c.id !== id)),
    [],
  );

  return (
    <>
      {live.map((e) => (
        <Mutant key={keyFor(e)} entity={e} scene={scene} clips={clips} norm={norm} />
      ))}
      {corpses.map((c) => (
        <MutantCorpse key={c.id} corpse={c} scene={scene} clips={clips} norm={norm} onDone={removeCorpse} />
      ))}
    </>
  );
};

useGameModel.preload(MODEL_PATH);
Object.values(CLIP_PATHS).forEach((p) => useGameModel.preload(p));
