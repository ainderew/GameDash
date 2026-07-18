import { useFrame } from '@react-three/fiber';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { relics, world } from '@/game/ecs/world';
import { passAim } from '@/game/combat/passAim';
import type { Entity } from '@sim/components';
import { AnimatedCharacter } from '@/game/entities/AnimatedCharacter';
import type { CharState } from '@/game/entities/AnimatedCharacter';
import {
  applyCharacterTransform,
  CHARACTER_FILL_LAYER,
  PLAYER_CHARACTERS,
} from '@/game/entities/characters';
import { useUIStore } from '@/ui/store';
import { WeaponMount } from '@/game/entities/Weapon';
import { comboAt, type ComboClip } from '@sim/combat/combo';
import { getWeapon } from '@/game/combat/weapons';
import { useWeaponStore } from '@/game/combat/weaponStore';
import { gameNow } from '@/game/feel/time';
import { netGame } from '@/net/netGame';
import { feel } from '@/game/feel/config';
import { playFootstep, playJump, playDoubleJump } from '@/game/feel/audio';
import { heightAt } from '@sim/terrain/terrainHeight';
import {
  DODGE_DURATION_MS,
  PLAYER_RUN_ANIM_THRESHOLD,
  RELIC_CATCH_ROOT_MS,
  RELIC_CORRUPTION_TUNING,
} from '@shared/balance';
import { relicNet } from '@/net/relicNet';
import { netClient } from '@/net/client';
import { CorruptionArmTendrils } from '@/game/fx/CorruptionArmTendrils';
import { heroRig } from '@/game/entities/heroRig';

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
  // THE entity this client owns — HUD/camera/input select on this, never `.first`.
  localPlayer: true,
});

/** Moving at all → at least walk. */
const WALK_SPEED_THRESHOLD = 0.5;
/** Shared midpoint between doubled walk and sprint speeds. */
const RUN_SPEED_THRESHOLD = PLAYER_RUN_ANIM_THRESHOLD;
/** Airborne threshold, world units — above this the jump clip plays. */
const AIRBORNE_Y = 0.06;
/** How long the hurt clip plays after a hit lands ("Hit To Body" is a self-contained ~0.83s
 * recoil; 700ms shows the full reaction and covers the knockback shove, fading out the tail). */
const HURT_ANIM_MS = 700;
/** The dash is over in DODGE_DURATION_MS; hold the roll clip longer so it visually completes. */
const DODGE_ANIM_MS = 450;
/** Standing still this long switches the idle to the bored/fidget clip. */
const BORED_IDLE_AFTER_MS = 3000;
/** How long the throw follow-through shows after a pass launches. The player is NOT
 * rooted during this — the clip plays over whatever they're doing (spec §8). */
const THROW_FOLLOW_MS = 550;
/** How long the catch/receive clip plays after the player acquires the relic. Locked to the
 * sim-side plant (RELIC_CATCH_ROOT_MS) so the animation and the no-glide root end together.
 * Sped-up (STATE_TIMESCALE.catch) so the grab reads inside the window; dodge/attack outrank
 * it, so a catch never eats a defensive input. */
const CATCH_ANIM_MS = RELIC_CATCH_ROOT_MS;
/** World units per left/right foot plant; cadence scales continuously with actual speed. */
const STEP_LENGTH = { walk: 1.35, run: 1.75 } as const;
/**
 * Between the sim (SystemRunner, -100) and the default-0 renderers. AnimatedCharacter's
 * useFrame registers BEFORE Player's (child effects first), so at equal priority it would
 * crossfade from LAST frame's charState — one extra frame of input→animation lag.
 */
const PLAYER_PRIORITY = -50;
/** Which animation state each combo move's clip plays. */
const ATTACK_STATE: Record<ComboClip, CharState> = {
  horizontal: 'attack-horizontal',
  reverse: 'attack-reverse',
  overhead: 'attack-overhead',
  thrust: 'attack-thrust',
};
/**
 * Mixamo right-hand bone the weapon mounts onto. GLTFLoader strips reserved chars (`:`)
 * from node names, so `mixamorig:RightHand` in the file loads as `mixamorigRightHand` —
 * match by suffix instead of exact name.
 */
const HAND_BONE_RE = /RightHand$/;
const LEFT_ARM_RE = /LeftForeArm$/;
const RIGHT_ARM_RE = /RightForeArm$/;

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
  // Dev-only console handle (same pattern as __world / __passAim) — read the live
  // animation state from tooling: window.__charState.current
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as { __charState?: typeof charState }).__charState = charState;
  }

  // Weapon: find the hand bone once the rig loads, then mount the current weapon onto it.
  const [handBone, setHandBone] = useState<Object3D | null>(null);
  const [armBones, setArmBones] = useState<[Object3D | null, Object3D | null]>([null, null]);
  const volatileActive = useRef(false);
  const corruptionProgress = useRef(0);
  const weaponId = useWeaponStore((s) => s.currentId);

  // Which skinned model the avatar uses — all characters share the hero clip set.
  const characterId = useUIStore((s) => s.playerCharacter);
  useEffect(() => applyCharacterTransform(characterId), [characterId]);
  // Hero materials + their rest emissive, for the hit flash (monsters do this per-instance).
  const flashMats = useRef<{ mat: MeshStandardMaterial; base: [number, number, number] }[]>([]);
  const wasFlashing = useRef(false);

  const onRigReady = useCallback((root: Object3D) => {
    let hand: Object3D | null = null;
    let leftArm: Object3D | null = null;
    let rightArm: Object3D | null = null;
    const mats: { mat: MeshStandardMaterial; base: [number, number, number] }[] = [];
    root.traverse((o) => {
      if (!hand && HAND_BONE_RE.test(o.name)) hand = o;
      if (!leftArm && LEFT_ARM_RE.test(o.name)) leftArm = o;
      if (!rightArm && RIGHT_ARM_RE.test(o.name)) rightArm = o;
      const mesh = o as Mesh;
      if (mesh.isMesh) {
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const sm = m as MeshStandardMaterial;
          if (sm.isMeshStandardMaterial)
            mats.push({ mat: sm, base: [sm.emissive.r, sm.emissive.g, sm.emissive.b] });
        }
      }
    });
    flashMats.current = mats;
    setHandBone(hand);
    setArmBones([leftArm, rightArm]);
    // Publish the live rig so pose-reading VFX (dash ghost trail) can clone it.
    heroRig.root = root;
  }, []);

  const weapon = getWeapon(weaponId);

  // Latch each dodge so its roll clip outlives the (much shorter) dash itself.
  const dodgeAnimUntil = useRef(0);
  const lastDodgeStamp = useRef(0);

  /** gameNow() when the current uninterrupted idle began (null while doing anything). */
  const idleSince = useRef<number | null>(null);
  /** True while pass-aiming — AnimatedCharacter freezes the throw clip at its wind-up. */
  const throwHold = useRef(false);
  /** gameNow() until which the throw follow-through plays after a launch. */
  const throwFollowUntil = useRef(0);
  /** startedAt of the last pass we latched, so each launch triggers exactly once. */
  const lastThrowStamp = useRef<number | undefined>(undefined);
  /** Whether WE held the relic last frame — a false→true edge is a fresh catch/pickup. */
  const wasCarrying = useRef<boolean | null>(null);
  /** gameNow() until which the catch clip plays after acquiring the relic. */
  const catchUntil = useRef(0);
  /** gameNow() when another foot plant may sound; uses game time, so hitstop stays silent. */
  const nextFootstepAt = useRef(0);
  /** Last-seen jumpsUsed, to fire the take-off SFX on the 0→1 (ground jump) edge only. */
  const prevJumpsUsed = useRef(0);

  useEffect(() => {
    const entity = world.add(makePlayerEntity());
    entityRef.current = entity;
    return () => {
      world.remove(entity);
      entityRef.current = null;
      heroRig.root = null;
    };
  }, []);

  useFrame(() => {
    const g = group.current;
    const e = entityRef.current;
    if (!g || !e?.transform || !e.velocity) return;
    const now = gameNow();

    const [x, y, z] = e.transform.position;
    // Reconciliation residue folds into the PRESENTATION transform only (~100 ms) —
    // the sim corrected instantly, the mesh never snaps (no-rubberband contract #4).
    if (netGame.active) {
      const off = netGame.presentationOffset();
      g.position.set(x + off[0], y + off[1], z + off[2]);
    } else {
      g.position.set(x, y, z);
    }
    g.rotation.y = e.transform.rotationY;
    playerRef.current = g;

    // Resolve the animation state by priority.
    const [vx, , vz] = e.velocity.linear;
    const speed = Math.hypot(vx, vz);
    // Multiplayer reconciliation sends the authoritative downed bit before the local health
    // bridge necessarily reaches zero. Either signal must start the death clip immediately.
    const dead = e.downed === true || (e.health?.current ?? 1) <= 0;
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

    // Relic throw: hold the wind-up while aiming AND planted — while aim-walking the
    // legs play locomotion instead (a frozen full-body pose glides; the relic's aim
    // pose + trajectory carry the "aiming" read until upper-body masking exists).
    // On launch (aimed or quick pass) the follow-through plays for a beat, latched off
    // the relic's flight state so it fires on the exact launch tick, once per pass.
    throwHold.current = passAim.aiming;
    const rs = relics.first?.relic;
    if (rs?.mode === 'pass' && rs.thrower === e && rs.startedAt !== lastThrowStamp.current) {
      lastThrowStamp.current = rs.startedAt;
      throwFollowUntil.current = now + THROW_FOLLOW_MS;
    }
    const throwing =
      (passAim.aiming && speed <= WALK_SPEED_THRESHOLD) || now < throwFollowUntil.current;

    // Catch: latch the receive clip on the false→true edge of us holding the relic —
    // covers pass receptions and walk-in ground pickups alike. Skip the very first
    // observation so spawning with the relic in hand doesn't fire a phantom catch.
    const carrying = rs?.phase === 'carried' && rs.carrier === e;
    const authoritativeCorruption = netGame.active
      ? relicNet.state.corruption
      : (rs?.corruption ?? 0);
    corruptionProgress.current = Math.max(
      0,
      Math.min(1, authoritativeCorruption / RELIC_CORRUPTION_TUNING.max),
    );
    volatileActive.current = netGame.active
      ? relicNet.state.phase === 'carried' && relicNet.state.carrierId === netClient.localEntityId()
      : carrying;
    if (wasCarrying.current !== null && !wasCarrying.current && carrying) {
      catchUntil.current = now + CATCH_ANIM_MS;
    }
    wasCarrying.current = carrying;
    const catching = now < catchUntil.current;

    let next: CharState;
    if (dead) next = 'death';
    else if (dodging) next = 'dodge';
    else if (attacking) next = ATTACK_STATE[comboAt(e.meleeCombo ?? 0).clip];
    else if (catching) next = 'catch';
    else if (throwing) next = 'throw';
    else if (hurting) next = 'hurt';
    // Airborne: the second (double) jump plays its own clip; the first jump and any other
    // airborne moment (walking off a ledge, jumpsUsed 0) play the normal jump.
    else if (y > AIRBORNE_Y) next = (e.jumpsUsed ?? 0) >= 2 ? 'double-jump' : 'jump';
    else if (speed > RUN_SPEED_THRESHOLD) next = 'run';
    else if (speed > WALK_SPEED_THRESHOLD) next = 'walk';
    else {
      // Standing idle first; after a stretch with no action, drift into the bored fidget.
      if (idleSince.current === null) idleSince.current = now;
      next = now - idleSince.current >= BORED_IDLE_AFTER_MS ? 'idle-bored' : 'idle';
    }
    if (next !== 'idle' && next !== 'idle-bored') idleSince.current = null;
    charState.current = next;

    // Jump SFX, keyed off jumpsUsed (climbs on each launch, resets to 0 on landing): the 0→1
    // edge is the ground take-off (whoosh + voice), the 1→2 edge is the airborne double jump
    // (its own distinct sample). Edge-gated so each fires exactly once per jump.
    const jumpsUsed = e.jumpsUsed ?? 0;
    if (jumpsUsed > prevJumpsUsed.current) {
      if (jumpsUsed === 1) playJump();
      else if (jumpsUsed === 2) playDoubleJump();
    }
    prevJumpsUsed.current = jumpsUsed;

    // Audio follows actual horizontal travel rather than render delta: stopping, collisions,
    // and any future movement-speed buffs naturally retime the left/right foot cadence.
    const locomotion = next === 'walk' || next === 'run';
    const grounded = Math.abs(y - heightAt(x, z)) < 0.08 && Math.abs(e.velocity.linear[1]) < 0.08;
    if (!locomotion || !grounded) {
      nextFootstepAt.current = now;
    } else if (now >= nextFootstepAt.current) {
      const running = next === 'run';
      if (playFootstep(running)) {
        const stepMs = (STEP_LENGTH[running ? 'run' : 'walk'] / Math.max(speed, 0.01)) * 1000;
        nextFootstepAt.current = now + stepMs;
      }
    }

    // Hit flash: additive red emissive on the hero's materials, fading over the flash window.
    const flashUntil = e.hitFlashUntil ?? 0;
    const flashing = flashUntil > now && !!e.hitFlashColor;
    if (flashing || wasFlashing.current) {
      const dur = feel.flash.durationMs[e.hitReactionStrength ?? 'light'];
      const k = flashing
        ? feel.flash.intensity * Math.max(0, Math.min(1, (flashUntil - now) / dur))
        : 0;
      const [fr, fg, fb] = e.hitFlashColor ?? [0, 0, 0];
      for (const { mat, base } of flashMats.current) {
        mat.emissive.setRGB(base[0] + fr * k, base[1] + fg * k, base[2] + fb * k);
      }
      wasFlashing.current = flashing;
    }
  }, PLAYER_PRIORITY);

  return (
    <group ref={group}>
      {/* Soft overhead bounce that follows the player and lights ONLY the playable
          character (layer-scoped) — keeps the backlit side readable without touching
          world lighting. No shadows, so it costs one light slot and nothing else. */}
      <pointLight
        position={[0, 2.4, 0]}
        intensity={4}
        distance={6}
        decay={2}
        color="#ffe7cc"
        onUpdate={(l) => l.layers.set(CHARACTER_FILL_LAYER)}
      />
      {/* key: full remount on character switch — useAnimations caches actions by clip
          name against the old skeleton, which leaves the new rig undriven (T-pose). */}
      <AnimatedCharacter
        key={characterId}
        characterPath={PLAYER_CHARACTERS[characterId].modelPath}
        idlePath="/models/hero/anim-idle.glb"
        boredPath="/models/hero/anim-idle-bored.glb"
        walkPath="/models/hero/anim-walk.glb"
        runPath="/models/hero/anim-run.glb"
        jumpPath="/models/hero/anim-jump.glb"
        jump2Path="/models/hero/anim-double-jump.glb"
        dodgePath="/models/hero/anim-roll.glb"
        hurtPath="/models/hero/anim-hurt.glb"
        deathPath="/models/hero/anim-death.glb"
        horizontalPath="/models/hero/anim-combo-horizontal.glb"
        reversePath="/models/hero/anim-combo-reverse.glb"
        overheadPath="/models/hero/anim-combo-overhead.glb"
        thrustPath="/models/hero/anim-combo-thrust.glb"
        throwPath="/models/hero/anim-throw.glb"
        catchPath="/models/hero/anim-catch.glb"
        targetHeight={1.8}
        stateRef={charState}
        throwHoldRef={throwHold}
        onRigReady={onRigReady}
      />
      {handBone && <WeaponMount bone={handBone} def={weapon} stateRef={charState} />}
      <CorruptionArmTendrils
        leftArm={armBones[0]}
        rightArm={armBones[1]}
        activeRef={volatileActive}
        corruptionRef={corruptionProgress}
      />
    </group>
  );
};
