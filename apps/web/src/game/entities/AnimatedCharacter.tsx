import { useAnimations } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Box3, LoopOnce, LoopRepeat, Vector3 } from 'three';
import type { AnimationClip, Group, Object3D } from 'three';
import { useGameModel } from '@/lib/loaders';
import { collectNodeNames, prepareClip } from '@/lib/animClips';
import { deMetalize } from '@/lib/materials';
import { CHARACTER_FILL_LAYER } from '@/game/entities/characters';
import { heroTransform } from '@/game/entities/heroConfig';
import { ATTACK_CLIP_S, ATTACK_TIMESCALE, type ComboClip } from '@sim/combat/combo';

/** Player animation states. Attacks are split by which mocap clip plays. */
export type CharState =
  | 'idle'
  | 'idle-bored'
  | 'walk'
  | 'run'
  | 'jump'
  | 'double-jump'
  | 'dodge'
  | 'hurt'
  | 'death'
  | 'throw'
  | 'catch'
  | 'attack-spin'
  | 'attack-light1'
  | 'attack-light2'
  | 'attack-finisher';

interface Props {
  /** Skinned character glb (mesh + skeleton). */
  characterPath: string;
  // Clip-only glbs (share the character's skeleton; bound by bone name at runtime).
  idlePath: string;
  /** Fidget/bored idle — the owner switches to 'idle-bored' after standing still a while. */
  boredPath: string;
  walkPath: string;
  runPath: string;
  jumpPath: string;
  /** Airborne SECOND jump — a distinct clip played on the double jump (jumpsUsed 2). */
  jump2Path: string;
  dodgePath: string;
  hurtPath: string;
  deathPath: string;
  // One self-contained single-swing clip per combo move (each starts/ends near guard).
  spinPath: string;
  light1Path: string;
  light2Path: string;
  finisherPath: string;
  /** Relic throw clip (wind-up → release → follow-through). */
  throwPath: string;
  /** Relic catch/receive clip — a one-shot reach-and-grab played on acquiring the relic. */
  catchPath: string;
  targetHeight?: number;
  /** Owner writes the desired CharState each frame; the machine crossfades to it. */
  stateRef: React.MutableRefObject<CharState>;
  /**
   * While true and the 'throw' state is active, the clip plays up to its wind-up frame
   * and FREEZES there (aim hold). Dropping to false releases the throw — the rest of
   * the clip plays. Pause only stops clip time; crossfade weights keep blending.
   */
  throwHoldRef?: React.MutableRefObject<boolean>;
  /** Called once the rig is loaded, with its root — used to find bones (e.g. RightHand). */
  onRigReady?: (root: Object3D) => void;
}

const FADE = 0.15;
/**
 * Snappy states (attacks, dodge) crossfade near-instantly — a 150ms blend on an attack
 * reads as input lag because the first frames are still mostly the previous pose.
 */
const FADE_FAST = 0.04;
const FAST_STATES: ReadonlySet<CharState> = new Set([
  'attack-light1',
  'attack-light2',
  'attack-spin',
  'attack-finisher',
  'dodge',
  'throw',
  'catch',
]);

// ── Relic throw clip windows (seconds in CLIP time, pre-timeScale) ─────────
/** Skip the clip's slow approach; enter partway into the wind-up (aim hold only). */
const THROW_START_S = 0.3;
/**
 * The aim-hold pose AND the release point: an aim hold plays up to here and freezes;
 * a throw entered WITHOUT a hold (quick pass) starts here directly, so the arm whips
 * the same instant the relic launches instead of winding up after it's gone.
 */
const THROW_HOLD_S = 1.05;

/**
 * Per-state clip start offset, seconds. The 'Stand To Roll' dodge clip has a short
 * standing anticipation — skip most of it so the dodge reads instantly. (Attack clips
 * are self-contained single swings and play from 0.)
 */
const START_AT: Partial<Record<CharState, number>> = { dodge: 0.1 };
/**
 * Per-state playback speed for NON-attack states. Attack speeds live in combat data
 * (ATTACK_TIMESCALE in combo.ts, leva-tunable) because the swing's gameplay duration is
 * derived from clip length ÷ speed — keeping them together guarantees anim and attack match.
 */
export const STATE_TIMESCALE: Partial<Record<CharState, number>> = {
  dodge: 2,
  // The Mixamo throw is leisurely mocap (3.8 s) — run it hot so the release snaps.
  throw: 1.6,
  // The catch mocap is a leisurely 2 s reach-and-grab — run it hot so the grab reads
  // on the same beat the relic snaps into hand, then hands control back quickly.
  catch: 1.6,
};

/** Which combat clip each attack state plays — for duration stamping + speed lookup. */
const ATTACK_CLIP_FOR_STATE: Partial<Record<CharState, ComboClip>> = {
  'attack-light1': 'light1',
  'attack-light2': 'light2',
  'attack-spin': 'spin',
  'attack-finisher': 'finisher',
};


/** Which states loop; everything else is a clamped one-shot. */
const LOOPS: Record<CharState, boolean> = {
  idle: true,
  'idle-bored': true,
  walk: true,
  run: true,
  jump: false,
  'double-jump': false,
  dodge: false,
  hurt: false,
  death: false,
  throw: false,
  catch: false,
  'attack-spin': false,
  'attack-light1': false,
  'attack-light2': false,
  'attack-finisher': false,
};

/**
 * Rigged player avatar built from a Mixamo hero: ONE skinned `characterPath` (mesh +
 * `mixamorig` skeleton) plus clip-only glbs. All clips share the skeleton, so three's
 * AnimationMixer binds each clip to the character's bones **by name** — no retargeting.
 * Looping states (idle/run) repeat; the rest are clamped one-shots. Crossfades on change.
 */
export const AnimatedCharacter = ({
  characterPath,
  idlePath,
  boredPath,
  walkPath,
  runPath,
  jumpPath,
  jump2Path,
  dodgePath,
  hurtPath,
  deathPath,
  spinPath,
  light1Path,
  light2Path,
  finisherPath,
  throwPath,
  catchPath,
  targetHeight = 1.8,
  stateRef,
  throwHoldRef,
  onRigReady,
}: Props) => {
  const character = useGameModel(characterPath);
  const idle = useGameModel(idlePath);
  const bored = useGameModel(boredPath);
  const walk = useGameModel(walkPath);
  const run = useGameModel(runPath);
  const jump = useGameModel(jumpPath);
  const jump2 = useGameModel(jump2Path);
  const dodge = useGameModel(dodgePath);
  const hurt = useGameModel(hurtPath);
  const death = useGameModel(deathPath);
  const spin = useGameModel(spinPath);
  const light1 = useGameModel(light1Path);
  const light2 = useGameModel(light2Path);
  const finisher = useGameModel(finisherPath);
  const throwClip = useGameModel(throwPath);
  const catchClip = useGameModel(catchPath);
  const group = useRef<Group>(null);

  // Normalize to targetHeight from the bind-pose bounds (Mixamo/Tripo export scale varies).
  const { scale, yOffset } = useMemo(() => {
    const box = new Box3().setFromObject(character.scene);
    const size = box.getSize(new Vector3());
    const s = targetHeight / (size.y || 1);
    return { scale: s, yOffset: -box.min.y * s };
  }, [character.scene, targetHeight]);

  useEffect(() => {
    deMetalize(character.scene); // Tripo bakes metalness 0.4 — blackens diffuse (see helper)
    character.scene.traverse((child) => {
      const m = child as unknown as {
        isMesh?: boolean;
        castShadow?: boolean;
        receiveShadow?: boolean;
        frustumCulled?: boolean;
        layers?: { enable: (l: number) => void };
      };
      if (m.isMesh) {
        m.castShadow = true;
        m.receiveShadow = true;
        m.frustumCulled = false; // skinned bounds jitter; don't cull mid-swing
        m.layers?.enable(CHARACTER_FILL_LAYER); // receive the player-only fill light
      }
    });
    onRigReady?.(character.scene);
  }, [character.scene, onRigReady]);

  // Bones present in the character rig — prepareClip drops tracks for bones this
  // rig doesn't have instead of leaving dead bindings that spam warnings.
  const rigBones = useMemo(() => collectNodeNames(character.scene), [character.scene]);

  // Gather the external clips, renamed to their state key. Clone so we don't mutate the
  // cached gltf clips.
  const clips = useMemo(() => {
    const named: [CharState, AnimationClip | undefined][] = [
      ['idle', idle.animations[0]],
      ['idle-bored', bored.animations[0]],
      ['walk', walk.animations[0]],
      ['run', run.animations[0]],
      ['jump', jump.animations[0]],
      ['double-jump', jump2.animations[0]],
      ['dodge', dodge.animations[0]],
      ['hurt', hurt.animations[0]],
      ['death', death.animations[0]],
      ['attack-spin', spin.animations[0]],
      ['attack-light1', light1.animations[0]],
      ['attack-light2', light2.animations[0]],
      ['attack-finisher', finisher.animations[0]],
      ['throw', throwClip.animations[0]],
      ['catch', catchClip.animations[0]],
    ];
    return named
      .filter((n): n is [CharState, AnimationClip] => n[1] !== undefined)
      .map(([name, clip]) => {
        const c = prepareClip(clip, name, rigBones);
        // NOTE (Phase 3): attack-clip durations are FROZEN in @sim ATTACK_CLIP_S — the
        // server computes swing windows from the same constants, so stamping measured
        // durations here again is BANNED (it would desync sim data from the authority).
        // If a clip's real length drifts from the constant, warn loudly in dev.
        const combatClip = ATTACK_CLIP_FOR_STATE[name];
        if (import.meta.env.DEV && combatClip && Math.abs(ATTACK_CLIP_S[combatClip] - c.duration) > 0.01) {
          // eslint-disable-next-line no-console
          console.warn(
            `[combat] ${name} clip is ${c.duration.toFixed(4)}s but ATTACK_CLIP_S.${combatClip} is ` +
              `${ATTACK_CLIP_S[combatClip]}s — re-measure and update packages/sim/src/combat/combo.ts`,
          );
        }
        return c;
      });
  }, [
    rigBones,
    idle.animations,
    bored.animations,
    walk.animations,
    run.animations,
    jump.animations,
    jump2.animations,
    dodge.animations,
    hurt.animations,
    death.animations,
    spin.animations,
    light1.animations,
    light2.animations,
    finisher.animations,
    throwClip.animations,
    catchClip.animations,
  ]);

  const { actions } = useAnimations(clips, group);
  const current = useRef<CharState>('idle');

  useEffect(() => {
    (Object.keys(LOOPS) as CharState[]).forEach((state) => {
      const a = actions[state];
      if (!a) return;
      if (!LOOPS[state]) {
        a.setLoop(LoopOnce, 1);
        a.clampWhenFinished = true;
      }
    });
    actions.idle?.reset().play();
  }, [actions]);

  useFrame(() => {
    // Live placement (leva "Hero" panel) — corrects the export-quirk transform.
    const g = group.current;
    if (g) {
      g.rotation.y = heroTransform.yaw;
      g.position.y = yOffset + heroTransform.yOffsetAdd;
      g.scale.setScalar(scale * heroTransform.scaleMul);
    }

    // Throw aim-hold: while E is held, the throw clip advances to its wind-up frame and
    // freezes there (paused stops CLIP time only — crossfade weights keep blending, so
    // entering the hold still eases in). Releasing unpauses: the throw plays through.
    if (current.current === 'throw') {
      const a = actions.throw;
      if (a) a.paused = throwHoldRef?.current === true && a.time >= THROW_HOLD_S;
    }

    // State machine crossfade.
    const next = stateRef.current;
    if (next === current.current) return;
    const from = actions[current.current];
    const to = actions[next];
    if (!to) return;
    const fade = FAST_STATES.has(next) ? FADE_FAST : FADE;
    from?.fadeOut(fade);
    to.reset();
    // Throw entry point depends on context: holding = play the wind-up (then freeze);
    // launching cold (quick pass) = start at the release so the motion matches the relic.
    if (next === 'throw') to.time = throwHoldRef?.current ? THROW_START_S : THROW_HOLD_S;
    else to.time = START_AT[next] ?? 0;
    // Read the (live-tunable) speed at swing start so leva edits apply immediately.
    // Attack states pull from combat data so playback speed matches the gameplay window.
    const combatClip = ATTACK_CLIP_FOR_STATE[next];
    to.timeScale = combatClip ? ATTACK_TIMESCALE[combatClip] : (STATE_TIMESCALE[next] ?? 1);
    to.setLoop(LOOPS[next] ? LoopRepeat : LoopOnce, LOOPS[next] ? Infinity : 1);
    to.clampWhenFinished = !LOOPS[next];
    to.fadeIn(fade).play();
    current.current = next;
  });

  return (
    <group ref={group} position={[0, yOffset, 0]} scale={scale}>
      <primitive object={character.scene} />
    </group>
  );
};
