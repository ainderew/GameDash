import { useFrame } from '@react-three/fiber';
import { Billboard, Text, useAnimations } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, Vector3 } from 'three';
import type { Group, Mesh } from 'three';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { world } from '@/game/ecs/world';
import type { Entity } from '@sim/components';
import { ANIM_FLAG_AIRBORNE, INTERP_DELAY_MS } from '@shared/net/constants';
import { useGameModel } from '@/lib/loaders';
import { collectNodeNames, prepareClip } from '@/lib/animClips';
import { deMetalize } from '@/lib/materials';
import { PLAYER_CHARACTERS, type PlayerCharacterId } from '@/game/entities/characters';
import { netClient } from '@/net/client';
import { useUIStore, type SessionMemberUI } from '@/ui/store';

/**
 * Remote session members rendered in the shared hub: one ECS entity + druid-style cloned
 * avatar per member (the Teammates.tsx approach — SkeletonUtils clone because several
 * instances mount at once), driven by the snapshot-interpolation buffer ~100 ms in the
 * past. Phase 2 feeds the buffers from the temporary transform relay; Phase 3 swaps the
 * feed to authoritative snapshots and THIS rendering path stays unchanged.
 */

const IDLE_PATH = '/models/hero/anim-idle.glb';
const WALK_PATH = '/models/hero/anim-walk.glb';
const RUN_PATH = '/models/hero/anim-run.glb';
const JUMP_PATH = '/models/hero/anim-jump.glb';

/** Same locomotion thresholds as Player.tsx so remote avatars read identically. */
const WALK_SPEED_THRESHOLD = 0.5;
const RUN_SPEED_THRESHOLD = 4.4;
const FADE_S = 0.15;

type RemoteAnim = 'idle' | 'walk' | 'run' | 'jump';

const isPlayerCharacterId = (v: string): v is PlayerCharacterId => v in PLAYER_CHARACTERS;

const makeRemoteEntity = (): Entity => ({
  // Parked out of sight until the first snapshot arrives.
  transform: { position: [0, -1000, 0], rotationY: 0 },
  health: { current: 100, max: 100 },
  faction: 'player',
  radius: 0.45,
  remotePlayer: true,
  // NOTE: deliberately NO `velocity` — movementSystem must never integrate remotes;
  // their motion is a replay of relayed snapshots, not simulation.
});

const RemoteAvatar = ({ member }: { member: SessionMemberUI }) => {
  const group = useRef<Group>(null);
  const entityRef = useRef<Entity | null>(null);
  const characterId: PlayerCharacterId = isPlayerCharacterId(member.character)
    ? member.character
    : 'druid';

  const gltf = useGameModel(PLAYER_CHARACTERS[characterId].modelPath);
  const idle = useGameModel(IDLE_PATH);
  const walk = useGameModel(WALK_PATH);
  const run = useGameModel(RUN_PATH);
  const jump = useGameModel(JUMP_PATH);

  const scene = useMemo(() => skeletonClone(gltf.scene), [gltf.scene]);
  // Measure the ORIGINAL cached scene (cloned skinned rigs report bogus bounds — see
  // Teammates.tsx). yOffsetAdd is a baked world-unit correction, added raw.
  const { scale, yOffset } = useMemo(() => {
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const s = 1.8 / (size.y || 1);
    return { scale: s, yOffset: -box.min.y * s + PLAYER_CHARACTERS[characterId].yOffsetAdd };
  }, [gltf.scene, characterId]);

  const clips = useMemo(() => {
    const bones = collectNodeNames(scene);
    return [
      prepareClip(idle.animations[0]!, 'idle', bones),
      prepareClip(walk.animations[0]!, 'walk', bones),
      prepareClip(run.animations[0]!, 'run', bones),
      prepareClip(jump.animations[0]!, 'jump', bones),
    ];
  }, [scene, idle, walk, run, jump]);
  const { actions } = useAnimations(clips, scene);
  const current = useRef<RemoteAnim>('idle');

  useEffect(() => {
    const entity = world.add(makeRemoteEntity());
    entityRef.current = entity;
    return () => {
      world.remove(entity);
      entityRef.current = null;
    };
  }, []);

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
    const entity = entityRef.current;
    if (!g || !entity?.transform) return;

    // Sample the shared timeline INTERP_DELAY_MS in the past — replayed, never guessed.
    const buffer = netClient.remoteBuffer(member.id);
    const renderT = netClient.serverNow() - INTERP_DELAY_MS;
    const sample = buffer.sample(renderT);
    if (!sample) {
      g.visible = false; // nothing relayed yet — stay hidden rather than at origin
      return;
    }
    buffer.prune(renderT - 2000);
    g.visible = true;

    // Mirror into the ECS (hub systems / future gameplay see remotes as entities)…
    entity.transform.position = [sample.pos[0], sample.pos[1], sample.pos[2]];
    entity.transform.rotationY = sample.rotY;
    // …and onto the scene graph.
    g.position.set(sample.pos[0], sample.pos[1], sample.pos[2]);
    g.rotation.y = sample.rotY;

    // Locomotion from interpolated velocity + relayed anim flags.
    const speed = Math.hypot(sample.velocity[0], sample.velocity[2]);
    let next: RemoteAnim;
    if ((sample.flags & ANIM_FLAG_AIRBORNE) !== 0) next = 'jump';
    else if (speed > RUN_SPEED_THRESHOLD) next = 'run';
    else if (speed > WALK_SPEED_THRESHOLD) next = 'walk';
    else next = 'idle';

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
    <group ref={group} visible={false}>
      <primitive object={scene} scale={scale} position={[0, yOffset, 0]} />
      {/* Name tag: world-space billboard above the head. */}
      <Billboard position={[0, 2.25, 0]}>
        <Text
          fontSize={0.22}
          color="#e9f8f2"
          outlineWidth={0.016}
          outlineColor="#0c1512"
          anchorX="center"
          anchorY="bottom"
        >
          {member.name}
        </Text>
      </Billboard>
    </group>
  );
};

/** One avatar per OTHER session member. Mounted in the hub scene only (Phase 2 scope). */
export const RemotePlayers = () => {
  const session = useUIStore((s) => s.session);
  if (!session) return null;
  return (
    <>
      {session.members
        .filter((m) => m.id !== session.playerId)
        .map((m) => (
          <RemoteAvatar key={m.id} member={m} />
        ))}
    </>
  );
};
