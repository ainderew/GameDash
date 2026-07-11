import { Leva, useControls } from 'leva';
import { feel } from '@/game/feel/config';
import { syncAudioSettings } from '@/game/feel/audio';

/**
 * COMBAT FEEL tuning panel (leva). Every slider writes straight into the mutable `feel`
 * config that the systems read each frame, so you tune the game WHILE playing it — which is
 * the whole point: these numbers only come alive by feel. Dev-only; mount in the DOM layer.
 *
 * Not exhaustive by choice — the highest-leverage knobs from the design brief's table are
 * here. Add more by binding another `onChange` to a `feel.*` field.
 */
export const FeelControls = () => {
  useControls('Toggles', {
    screenShake: {
      value: feel.screenShake.enabled,
      onChange: (v: boolean) => (feel.screenShake.enabled = v),
    },
    audio: {
      value: feel.audio.enabled,
      onChange: (v: boolean) => {
        feel.audio.enabled = v;
        syncAudioSettings();
      },
    },
    parry: { value: feel.parry.enabled, onChange: (v: boolean) => (feel.parry.enabled = v) },
  });

  useControls('Hitstop (ms)', {
    light: {
      value: feel.hitstopMs.light,
      min: 0,
      max: 400,
      step: 5,
      onChange: (v: number) => (feel.hitstopMs.light = v),
    },
    heavy: {
      value: feel.hitstopMs.heavy,
      min: 0,
      max: 400,
      step: 5,
      onChange: (v: number) => (feel.hitstopMs.heavy = v),
    },
  });

  useControls('Screen shake', {
    traumaLight: {
      value: feel.screenShake.traumaPerHit.light,
      min: 0,
      max: 1,
      step: 0.02,
      onChange: (v: number) => (feel.screenShake.traumaPerHit.light = v),
    },
    traumaHeavy: {
      value: feel.screenShake.traumaPerHit.heavy,
      min: 0,
      max: 1,
      step: 0.02,
      onChange: (v: number) => (feel.screenShake.traumaPerHit.heavy = v),
    },
    maxOffset: {
      value: feel.screenShake.maxOffset,
      min: 0,
      max: 2,
      step: 0.05,
      onChange: (v: number) => (feel.screenShake.maxOffset = v),
    },
    decayPerSec: {
      value: feel.screenShake.decayPerSec,
      min: 0.2,
      max: 5,
      step: 0.1,
      onChange: (v: number) => (feel.screenShake.decayPerSec = v),
    },
  });

  useControls('Knockback', {
    speedLight: {
      value: feel.knockback.speed.light,
      min: 0,
      max: 40,
      step: 0.5,
      onChange: (v: number) => (feel.knockback.speed.light = v),
    },
    speedHeavy: {
      value: feel.knockback.speed.heavy,
      min: 0,
      max: 40,
      step: 0.5,
      onChange: (v: number) => (feel.knockback.speed.heavy = v),
    },
    launchHeavy: {
      value: feel.knockback.launch.heavy,
      min: 0,
      max: 12,
      step: 0.25,
      onChange: (v: number) => (feel.knockback.launch.heavy = v),
    },
    friction: {
      value: feel.knockback.friction,
      min: 1,
      max: 20,
      step: 0.5,
      onChange: (v: number) => (feel.knockback.friction = v),
    },
    playerScale: {
      value: feel.knockback.playerScale,
      min: 0,
      max: 1.5,
      step: 0.05,
      onChange: (v: number) => (feel.knockback.playerScale = v),
    },
  });

  useControls('Hit reaction', {
    flashLightMs: {
      value: feel.flash.durationMs.light,
      min: 0,
      max: 500,
      step: 10,
      onChange: (v: number) => (feel.flash.durationMs.light = v),
    },
    flashHeavyMs: {
      value: feel.flash.durationMs.heavy,
      min: 0,
      max: 500,
      step: 10,
      onChange: (v: number) => (feel.flash.durationMs.heavy = v),
    },
    flashIntensity: {
      value: feel.flash.intensity,
      min: 0,
      max: 4,
      step: 0.1,
      onChange: (v: number) => (feel.flash.intensity = v),
    },
    squashLight: {
      value: feel.squash.amount.light,
      min: 0,
      max: 0.8,
      step: 0.02,
      onChange: (v: number) => (feel.squash.amount.light = v),
    },
    squashHeavy: {
      value: feel.squash.amount.heavy,
      min: 0,
      max: 0.8,
      step: 0.02,
      onChange: (v: number) => (feel.squash.amount.heavy = v),
    },
    hitstunLightMs: {
      value: feel.hitstunMs.light,
      min: 0,
      max: 1500,
      step: 10,
      onChange: (v: number) => (feel.hitstunMs.light = v),
    },
    hitstunHeavyMs: {
      value: feel.hitstunMs.heavy,
      min: 0,
      max: 1500,
      step: 10,
      onChange: (v: number) => (feel.hitstunMs.heavy = v),
    },
  });

  // Swing PHASE timing (windup → active → recovery) is NOT tunable here: it derives from the
  // frozen sim constants in packages/sim/src/combat/combo.ts (moveActiveWindow / moveAnimMs),
  // shared byte-for-byte with the server. A leva panel that mutated it would desync the sim and
  // silently do nothing in gameplay — tune it in combo.ts source instead.

  useControls('Bodies & parry', {
    bodyRadiusScale: {
      value: feel.bodyRadiusScale,
      min: 0.5,
      max: 2,
      step: 0.05,
      onChange: (v: number) => (feel.bodyRadiusScale = v),
    },
    audioVolume: {
      value: feel.audio.masterVolume,
      min: 0,
      max: 1,
      step: 0.05,
      onChange: (v: number) => {
        feel.audio.masterVolume = v;
        syncAudioSettings();
      },
    },
    parryWindowMs: {
      value: feel.parry.windowMs,
      min: 30,
      max: 400,
      step: 5,
      onChange: (v: number) => (feel.parry.windowMs = v),
    },
    parrySlowmoScale: {
      value: feel.parry.slowmoScale,
      min: 0.05,
      max: 1,
      step: 0.05,
      onChange: (v: number) => (feel.parry.slowmoScale = v),
    },
  });

  return <Leva collapsed titleBar={{ title: 'Combat Feel' }} />;
};
