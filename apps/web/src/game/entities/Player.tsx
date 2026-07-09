import { useFrame } from '@react-three/fiber';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { world } from '@/game/ecs/world';
import type { Entity } from '@/game/ecs/components';
import { AnimatedCharacter } from '@/game/entities/AnimatedCharacter';
import type { CharState } from '@/game/entities/AnimatedCharacter';
import { WeaponMount } from '@/game/entities/Weapon';
import { comboAt, type ComboClip } from '@/game/combat/combo';
import { getWeapon } from '@/game/combat/weapons';
import { useWeaponStore } from '@/game/combat/weaponStore';
import { gameNow } from '@/game/feel/time';
import { feel } from '@/game/feel/config';
import { DODGE_DURATION_MS } from '@shared/balance';

interface Props {
  /** GameCanvas passes this so the camera can follow the player group. */
  playerRef: React.MutableRefObject<Object3D | null>;
}

const makePlayerEntity = (): Entity => ({
  transform: { position: [0, 0, 0], rotationY: Math.PI },
  velocity: { linear: [0, 0, 0] },
  health: { current: 100, max: 100 },
  faction: 'player',
  radius: 0.45,
  playerControlled: true,
});

/** Moving at all → at least walk. */
const WALK_SPEED_THRESHOLD = 0.5;
/** Between walk (2.8) and sprint (6) speeds — above this the run clip plays. */
const RUN_SPEED_THRESHOLD = 4.4;
/** Airborne threshold, world units — above this the jump clip plays. */
const AIRBORNE_Y = 0.06;
/** How long the hurt clip plays after a hit lands ("Hit To Body" is a self-contained ~0.83s
 * recoil; 700ms shows the full reaction and covers the knockback shove, fading out the tail). */
const HURT_ANIM_MS = 700;
/** The dash is over in DODGE_DURATION_MS; hold the roll clip longer so it visually completes. */
const DODGE_ANIM_MS = 450;
/** Standing still this long switches the idle to the bored/fidget clip. */
const BORED_IDLE_AFTER_MS = 3000;
/**
 * Between the sim (SystemRunner, -100) and the default-0 renderers. AnimatedCharacter's
 * useFrame registers BEFORE Player's (child effects first), so at equal priority it would
 * crossfade from LAST frame's charState — one extra frame of input→animation lag.
 */
const PLAYER_PRIORITY = -50;
/** Which animation state each combo move's clip plays. */
const ATTACK_STATE: Record<ComboClip, CharState> = {
  light1: 'attack-light1',
  light2: 'attack-light2',
  spin: 'attack-spin',
  finisher: 'attack-finisher',
};
/**
 * Mixamo right-hand bone the weapon mounts onto. GLTFLoader strips reserved chars (`:`)
 * from node names, so `mixamorig:RightHand` in the file loads as `mixamorigRightHand` —
 * match by suffix instead of exact name.
 */
const HAND_BONE_RE = /RightHand$/;

/**
 * The player: owns the ECS entity + the animated avatar. Movement is authored by the ECS;
 * this component mirrors the transform onto the scene graph and resolves the animation state
 * (death > dodge > attack > jump > run > idle) from ECS state. Swings are real Mixamo mocap —
 * no procedural pose layering — and the weapon is mounted on the hand bone so it's held.
 */
export const Player = ({ playerRef }: Props) => {
  const group = useRef<Group>(null);
  const entityRef = useRef<Entity | null>(null);
  const charState = useRef<CharState>('idle');

  // Weapon: find the hand bone once the rig loads, then mount the current weapon onto it.
  const [handBone, setHandBone] = useState<Object3D | null>(null);
  const weaponId = useWeaponStore((s) => s.currentId);
  // Hero materials + their rest emissive, for the hit flash (monsters do this per-instance).
  const flashMats = useRef<{ mat: MeshStandardMaterial; base: [number, number, number] }[]>([]);
  const wasFlashing = useRef(false);

  const onRigReady = useCallback((root: Object3D) => {
    let hand: Object3D | null = null;
    const mats: { mat: MeshStandardMaterial; base: [number, number, number] }[] = [];
    root.traverse((o) => {
      if (!hand && HAND_BONE_RE.test(o.name)) hand = o;
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const sm = m as MeshStandardMaterial;
          if (sm.isMeshStandardMaterial) mats.push({ mat: sm, base: [sm.emissive.r, sm.emissive.g, sm.emissive.b] });
        }
      }
    });
    flashMats.current = mats;
    setHandBone(hand);
  }, []);

  // Latch each dodge so its roll clip outlives the (much shorter) dash itself.
  const dodgeAnimUntil = useRef(0);
  const lastDodgeStamp = useRef(0);

  /** gameNow() when the current uninterrupted idle began (null while doing anything). */
  const idleSince = useRef<number | null>(null);

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
    const now = gameNow();

    const [x, y, z] = e.transform.position;
    g.position.set(x, y, z);
    g.rotation.y = e.transform.rotationY;
    playerRef.current = g;

    // Resolve the animation state by priority.
    const [vx, , vz] = e.velocity.linear;
    const speed = Math.hypot(vx, vz);
    const dead = (e.health?.current ?? 1) <= 0;
    const du = e.dodgingUntil ?? 0;
    if (du > lastDodgeStamp.current) {
      lastDodgeStamp.current = du;
      dodgeAnimUntil.current = du - DODGE_DURATION_MS + DODGE_ANIM_MS;
    }
    const dodging = now < dodgeAnimUntil.current;
    // The swing window is authored by the ECS (attackAnimUntil = the clip's real length,
    // zeroed by a dodge-cancel) — so the attack anim always finishes unless canceled.
    const attacking = now < (e.attackAnimUntil ?? 0);

    const hurting = e.hitReactionAt != null && now < e.hitReactionAt + HURT_ANIM_MS;

    let next: CharState;
    if (dead) next = 'death';
    else if (dodging) next = 'dodge';
    else if (attacking) next = ATTACK_STATE[comboAt(e.meleeCombo ?? 0).clip];
    else if (hurting) next = 'hurt';
    else if (y > AIRBORNE_Y) next = 'jump';
    else if (speed > RUN_SPEED_THRESHOLD) next = 'run';
    else if (speed > WALK_SPEED_THRESHOLD) next = 'walk';
    else {
      // Standing idle first; after a stretch with no action, drift into the bored fidget.
      if (idleSince.current === null) idleSince.current = now;
      next = now - idleSince.current >= BORED_IDLE_AFTER_MS ? 'idle-bored' : 'idle';
    }
    if (next !== 'idle' && next !== 'idle-bored') idleSince.current = null;
    charState.current = next;

    // Hit flash: additive red emissive on the hero's materials, fading over the flash window.
    const flashUntil = e.hitFlashUntil ?? 0;
    const flashing = flashUntil > now && !!e.hitFlashColor;
    if (flashing || wasFlashing.current) {
      const dur = feel.flash.durationMs[e.hitReactionStrength ?? 'light'];
      const k = flashing ? feel.flash.intensity * Math.max(0, Math.min(1, (flashUntil - now) / dur)) : 0;
      const [fr, fg, fb] = e.hitFlashColor ?? [0, 0, 0];
      for (const { mat, base } of flashMats.current) {
        mat.emissive.setRGB(base[0] + fr * k, base[1] + fg * k, base[2] + fb * k);
      }
      wasFlashing.current = flashing;
    }
  }, PLAYER_PRIORITY);

  return (
    <group ref={group}>
      <AnimatedCharacter
        characterPath="/models/hero/hero.glb"
        idlePath="/models/hero/anim-idle.glb"
        boredPath="/models/hero/anim-idle-bored.glb"
        walkPath="/models/hero/anim-walk.glb"
        runPath="/models/hero/anim-run.glb"
        jumpPath="/models/hero/anim-jump.glb"
        dodgePath="/models/hero/anim-roll.glb"
        hurtPath="/models/hero/anim-hurt.glb"
        deathPath="/models/hero/anim-death.glb"
        spinPath="/models/hero/anim-spin.glb"
        light1Path="/models/hero/anim-attack-l1.glb"
        light2Path="/models/hero/anim-attack-l2.glb"
        finisherPath="/models/hero/anim-finisher.glb"
        targetHeight={1.8}
        stateRef={charState}
        onRigReady={onRigReady}
      />
      {handBone && <WeaponMount bone={handBone} def={getWeapon(weaponId)} />}
    </group>
  );
};
