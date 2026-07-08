import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { Group, Object3D } from 'three';
import { world } from '@/game/ecs/world';
import type { Entity } from '@/game/ecs/components';
import { AnimatedCharacter } from '@/game/entities/AnimatedCharacter';
import type { CharState } from '@/game/entities/AnimatedCharacter';
import { comboAt } from '@/game/combat/combo';

interface Props {
  /** GameCanvas passes this so the camera can follow the player group. */
  playerRef: React.MutableRefObject<Object3D | null>;
}

const makePlayerEntity = (): Entity => ({
  // Model's front is +Z; forward movement is -Z, so face away from camera at spawn.
  transform: { position: [0, 0, 0], rotationY: Math.PI },
  velocity: { linear: [0, 0, 0] },
  health: { current: 100, max: 100 },
  faction: 'player',
  radius: 0.45,
  playerControlled: true,
});

const RUN_SPEED_THRESHOLD = 0.5;
const HURT_ANIM_MS = 360;

const smooth = (t: number): number => t * t * (3 - 2 * t);

interface Pose {
  /** Extra body twist about Y, radians. */
  yaw: number;
  /** Forward step along facing, world units. */
  lunge: number;
  /** Forward/back lean about X, radians. */
  pitch: number;
  /** Vertical hop, world units. */
  hop: number;
}

/** Horizontal sword swing; `dir` flips it (right→left vs left→right). */
const horizontalSwing = (p: number, dir: number): Pose => {
  if (p < 0.2) {
    const k = smooth(p / 0.2); // wind up to the far side
    return { yaw: -0.5 * dir * k, lunge: -0.08 * k, pitch: -0.05 * k, hop: 0 };
  }
  if (p < 0.45) {
    const k = smooth((p - 0.2) / 0.25); // whip across + step in
    return { yaw: dir * (-0.5 + 1.4 * k), lunge: -0.08 + 0.5 * k, pitch: -0.05 + 0.32 * k, hop: 0 };
  }
  const k = smooth((p - 0.45) / 0.55);
  return { yaw: dir * 0.9 * (1 - k), lunge: 0.42 * (1 - k), pitch: 0.27 * (1 - k), hop: 0 };
};

/** A full 360° spin attack with a step-through. */
const spinSwing = (p: number): Pose => ({
  yaw: smooth(p) * Math.PI * 2,
  lunge: Math.sin(p * Math.PI) * 0.5,
  pitch: Math.sin(p * Math.PI) * 0.12,
  hop: 0,
});

/** A rising uppercut: crouch, then spring up and lean back with a hop. */
const uppercutSwing = (p: number): Pose => {
  if (p < 0.22) {
    const k = smooth(p / 0.22); // crouch + dip
    return { yaw: 0.2 * k, lunge: -0.05 * k, pitch: 0.18 * k, hop: -0.05 * k };
  }
  if (p < 0.5) {
    const k = smooth((p - 0.22) / 0.28); // spring up + lean back + hop
    return { yaw: 0.2 - 0.2 * k, lunge: -0.05 + 0.35 * k, pitch: 0.18 - 0.7 * k, hop: -0.05 + 0.55 * k };
  }
  const k = smooth((p - 0.5) / 0.5);
  return { yaw: 0, lunge: 0.3 * (1 - k), pitch: -0.52 * (1 - k), hop: 0.5 * (1 - k) };
};

const REST: Pose = { yaw: 0, lunge: 0, pitch: 0, hop: 0 };

/** Pick the procedural motion for the given combo move at progress `p` (0..1). */
const comboPose = (index: number, p: number): Pose => {
  if (p < 0 || p > 1) return REST;
  switch (comboAt(index).key) {
    case 'altSlash':
      return horizontalSwing(p, -1);
    case 'spin':
      return spinSwing(p);
    case 'uppercut':
      return uppercutSwing(p);
    default:
      return horizontalSwing(p, 1);
  }
};

/**
 * The player: owns the ECS entity + the animated avatar. Movement is authored by
 * the ECS; this component mirrors the transform onto the scene graph and resolves
 * the animation state machine (hurt > slash > run > idle) from ECS state.
 */
export const Player = ({ playerRef }: Props) => {
  const group = useRef<Group>(null);
  const entityRef = useRef<Entity | null>(null);
  const charState = useRef<CharState>('idle');

  // Latches + change-detection for one-shot animations.
  const slashUntil = useRef(0);
  const slashStartAt = useRef(0);
  const slashMove = useRef(0);
  const hurtUntil = useRef(0);
  const lastAttackStart = useRef(0);
  const lastHealth = useRef(100);

  useEffect(() => {
    const entity = world.add(makePlayerEntity());
    entityRef.current = entity;
    return () => {
      world.remove(entity);
      entityRef.current = null;
    };
  }, []);

  useFrame(() => {
    const g = group.current;
    const e = entityRef.current;
    if (!g || !e?.transform || !e.velocity) return;
    const now = performance.now();

    const [x, y, z] = e.transform.position;
    g.position.set(x, y, z);
    g.rotation.y = e.transform.rotationY;
    playerRef.current = g;

    // Latch the combo move when a new swing starts.
    const atkStart = e.attackState?.startedAt ?? 0;
    if (atkStart > lastAttackStart.current) {
      lastAttackStart.current = atkStart;
      slashStartAt.current = atkStart;
      slashMove.current = e.attackState?.combo ?? 0;
      slashUntil.current = atkStart + comboAt(slashMove.current).animMs;
    }
    // Latch hurt when HP drops.
    const hp = e.health?.current ?? lastHealth.current;
    if (hp < lastHealth.current) hurtUntil.current = now + HURT_ANIM_MS;
    lastHealth.current = hp;

    // Resolve state by priority.
    const [vx, , vz] = e.velocity.linear;
    const speed = Math.hypot(vx, vz);
    let next: CharState;
    if (now < hurtUntil.current) next = 'hurt';
    else if (now < slashUntil.current) next = 'slash';
    else if (speed > RUN_SPEED_THRESHOLD) next = 'run';
    else next = 'idle';
    charState.current = next;

    // Layer the combo move's procedural motion over the clip so each hit reads.
    if (now < slashUntil.current) {
      const move = comboAt(slashMove.current);
      const pose = comboPose(slashMove.current, (now - slashStartAt.current) / move.animMs);
      g.rotation.y = e.transform.rotationY + pose.yaw;
      g.rotation.x = pose.pitch;
      g.position.set(
        x + Math.sin(e.transform.rotationY) * pose.lunge,
        y + pose.hop,
        z + Math.cos(e.transform.rotationY) * pose.lunge,
      );
    } else if (g.rotation.x !== 0) {
      g.rotation.x = 0;
    }
  });

  return (
    <group ref={group}>
      {/* Temporary: the generated (rigged) test-monster as the player avatar.
          Forward axis is +X (Tripo rig convention) vs game -Z, hence faceOffset. */}
      <AnimatedCharacter
        idlePath="/models/test-monster-idle.glb"
        runPath="/models/test-monster-run.glb"
        slashPath="/models/test-monster-slash.glb"
        hurtPath="/models/test-monster-hurt.glb"
        targetHeight={1.8}
        faceOffset={-Math.PI / 2}
        stateRef={charState}
      />
    </group>
  );
};
