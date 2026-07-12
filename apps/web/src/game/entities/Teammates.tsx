import { useFrame } from '@react-three/fiber';
import { useAnimations } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, Vector3 } from 'three';
import type { Group, Mesh } from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { relics, world } from '@/game/ecs/world';
import type { Entity } from '@sim/components';
import { useGameModel } from '@/lib/loaders';
import { collectNodeNames, prepareClip } from '@/lib/animClips';
import { deMetalize } from '@/lib/materials';
import { PLAYER_CHARACTERS } from '@/game/entities/characters';
import { heightAt } from '@sim/terrain/terrainHeight';
import { RELIC_CORRUPTION_TUNING } from '@shared/balance';
import { CorruptionArmTendrils } from '@/game/fx/CorruptionArmTendrils';

/**
 * Local stand-in teammates until real multiplayer lands: druid-model avatars driven by
 * teammateSystem (patrol / hold / return-pass). Unlike the Player's AnimatedCharacter,
 * the rig is SkeletonUtils-CLONED per instance — the cached GLTF scene can only live in
 * one place in the scene graph, and we mount several.
 */

const MODEL_PATH = PLAYER_CHARACTERS.druid.modelPath;
const IDLE_PATH = '/models/hero/anim-idle.glb';
const WALK_PATH = '/models/hero/anim-walk.glb';

/** Spawn spots + patrol legs (XZ). Spread around the player spawn at passable range. */
const TEAMMATE_SPAWNS: { pos: [number, number]; patrolTo: [number, number] }[] = [
  { pos: [-6, -8], patrolTo: [-2, -9] },
  { pos: [7, -10], patrolTo: [7, -5] },
];

/** Matches Player.tsx's thresholds: moving at all plays the walk clip. */
const WALK_SPEED_THRESHOLD = 0.5;
const FADE_S = 0.2;

const makeTeammate = (x: number, z: number, patrolTo: [number, number]): Entity => ({
  transform: { position: [x, heightAt(x, z), z], rotationY: 0 },
  velocity: { linear: [0, 0, 0] },
  health: { current: 100, max: 100 },
  faction: 'player',
  radius: 0.45,
  teammate: true,
  patrol: { a: [x, z], b: patrolTo, toB: true },
});

const TeammateAvatar = ({ entity }: { entity: Entity }) => {
  const group = useRef<Group>(null);
  const gltf = useGameModel(MODEL_PATH);
  const idle = useGameModel(IDLE_PATH);
  const walk = useGameModel(WALK_PATH);

  const scene = useMemo(() => skeletonClone(gltf.scene), [gltf.scene]);
  const armBones = useMemo(() => {
    let left: Group | null = null;
    let right: Group | null = null;
    scene.traverse((object) => {
      if (!left && /LeftForeArm$/.test(object.name)) left = object as Group;
      if (!right && /RightForeArm$/.test(object.name)) right = object as Group;
    });
    return [left, right] as const;
  }, [scene]);
  const volatileActive = useRef(false);
  const corruptionProgress = useRef(0);
  // Measure the ORIGINAL cached scene, exactly like AnimatedCharacter does — Box3 on a
  // just-cloned skinned rig reports bogus bounds (unposed skinning), which oversized the
  // dummies ~2.7× and sank them underground. yOffsetAdd is a baked WORLD-unit correction
  // (see heroConfig), so it is added raw, not scaled.
  const { scale, yOffset } = useMemo(() => {
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const s = 1.8 / (size.y || 1);
    return { scale: s, yOffset: -box.min.y * s + PLAYER_CHARACTERS.druid.yOffsetAdd };
  }, [gltf.scene]);

  const clips = useMemo(() => {
    const bones = collectNodeNames(scene);
    return [
      prepareClip(idle.animations[0]!, 'idle', bones),
      prepareClip(walk.animations[0]!, 'walk', bones),
    ];
  }, [scene, idle, walk]);
  const { actions } = useAnimations(clips, scene);
  const current = useRef<'idle' | 'walk'>('idle');

  useEffect(() => {
    deMetalize(scene);
    scene.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
      }
    });
    actions.idle?.reset().play();
  }, [scene, actions]);

  useFrame(() => {
    const g = group.current;
    const t = entity.transform;
    const v = entity.velocity;
    if (!g || !t || !v) return;
    g.position.set(t.position[0], t.position[1], t.position[2]);
    g.rotation.y = t.rotationY;
    const relic = relics.first?.relic;
    volatileActive.current = relic?.phase === 'carried' && relic.carrier === entity;
    corruptionProgress.current = Math.max(
      0,
      Math.min(1, (relic?.corruption ?? 0) / RELIC_CORRUPTION_TUNING.max),
    );

    const next = Math.hypot(v.linear[0], v.linear[2]) > WALK_SPEED_THRESHOLD ? 'walk' : 'idle';
    if (next !== current.current) {
      const from = actions[current.current];
      const to = actions[next];
      current.current = next;
      if (from && to) {
        to.reset().play();
        to.crossFadeFrom(from, FADE_S, false);
      }
    }
  });

  return (
    <group ref={group}>
      <primitive object={scene} scale={scale} position={[0, yOffset, 0]} />
      <CorruptionArmTendrils
        leftArm={armBones[0]}
        rightArm={armBones[1]}
        activeRef={volatileActive}
        corruptionRef={corruptionProgress}
      />
    </group>
  );
};

/** Owns the teammate entities and renders one avatar per entity. */
export const Teammates = () => {
  const entities = useMemo(
    () => TEAMMATE_SPAWNS.map((s) => makeTeammate(s.pos[0], s.pos[1], s.patrolTo)),
    [],
  );

  useEffect(() => {
    for (const e of entities) world.add(e);
    return () => {
      for (const e of entities) world.remove(e);
    };
  }, [entities]);

  return (
    <>
      {entities.map((e, k) => (
        <TeammateAvatar key={k} entity={e} />
      ))}
    </>
  );
};
