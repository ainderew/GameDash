import { useAnimations } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, LoopOnce, LoopRepeat, Vector3 } from 'three';
import type { AnimationClip, Group } from 'three';
import { useGameModel } from '@/lib/loaders';

/** Player animation states, highest priority first when the state machine resolves. */
export type CharState = 'hurt' | 'slash' | 'run' | 'idle';

interface Props {
  idlePath: string;
  runPath: string;
  slashPath: string;
  hurtPath: string;
  targetHeight?: number;
  faceOffset?: number;
  /** Owner writes the desired CharState each frame; the machine crossfades to it. */
  stateRef: React.MutableRefObject<CharState>;
}

const FADE = 0.14;
const ONE_SHOT: Record<CharState, boolean> = { idle: false, run: false, slash: true, hurt: true };

/**
 * Rigged player avatar with an idle/run/slash/hurt state machine. All clips share
 * one rig (retargeted by bone name onto the idle mesh). One-shot clips (slash/hurt)
 * play once and clamp; looping clips (idle/run) repeat. Crossfades on state change.
 */
export const AnimatedCharacter = ({
  idlePath,
  runPath,
  slashPath,
  hurtPath,
  targetHeight = 1.8,
  faceOffset = 0,
  stateRef,
}: Props) => {
  const idleGltf = useGameModel(idlePath);
  const runGltf = useGameModel(runPath);
  const slashGltf = useGameModel(slashPath);
  const hurtGltf = useGameModel(hurtPath);
  const group = useRef<Group>(null);

  const { scale, yOffset } = useMemo(() => {
    const box = new Box3().setFromObject(idleGltf.scene);
    const size = box.getSize(new Vector3());
    const s = targetHeight / (size.y || 1);
    return { scale: s, yOffset: -box.min.y * s };
  }, [idleGltf.scene, targetHeight]);

  useEffect(() => {
    idleGltf.scene.traverse((child) => {
      const mesh = child as { isMesh?: boolean; castShadow?: boolean; receiveShadow?: boolean };
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
  }, [idleGltf.scene]);

  const clips = useMemo(() => {
    const named: [CharState, AnimationClip | undefined][] = [
      ['idle', idleGltf.animations[0]],
      ['run', runGltf.animations[0]],
      ['slash', slashGltf.animations[0]],
      ['hurt', hurtGltf.animations[0]],
    ];
    return named
      .filter((n): n is [CharState, AnimationClip] => n[1] !== undefined)
      .map(([name, clip]) => {
        clip.name = name;
        return clip;
      });
  }, [idleGltf.animations, runGltf.animations, slashGltf.animations, hurtGltf.animations]);

  const { actions } = useAnimations(clips, group);
  const current = useRef<CharState>('idle');

  useEffect(() => {
    for (const state of ['slash', 'hurt'] as CharState[]) {
      const a = actions[state];
      if (a) {
        a.setLoop(LoopOnce, 1);
        a.clampWhenFinished = true;
      }
    }
    actions.idle?.reset().play();
  }, [actions]);

  useFrame(() => {
    const next = stateRef.current;
    if (next === current.current) return;
    const from = actions[current.current];
    const to = actions[next];
    if (!to) return;
    from?.fadeOut(FADE);
    to.reset().setLoop(ONE_SHOT[next] ? LoopOnce : LoopRepeat, ONE_SHOT[next] ? 1 : Infinity);
    to.clampWhenFinished = ONE_SHOT[next];
    to.fadeIn(FADE).play();
    current.current = next;
  });

  return (
    <group ref={group} position={[0, yOffset, 0]} rotation={[0, faceOffset, 0]} scale={scale}>
      <primitive object={idleGltf.scene} />
    </group>
  );
};
