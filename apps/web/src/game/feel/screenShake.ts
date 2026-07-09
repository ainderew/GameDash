/**
 * SCREEN SHAKE — trauma model (Squirrel Eiserloh style).
 *
 * Add `trauma` on impact; the actual shake is `trauma²` so small hits barely wobble and
 * big hits kick hard, with a smooth falloff. Trauma decays every frame on REAL delta, so
 * the shake keeps moving even while the sim is frozen for hitstop.
 *
 * The camera samples `shakeOffset(dt)` once per frame and adds it after its follow logic.
 */

import { feel } from '@/game/feel/config';

let trauma = 0;
/** Monotonic real-time accumulator that drives the oscillation phase. */
let phase = 0;

/** Cheap deterministic-ish noise in [-1, 1] from a seed + phase. */
const noise = (seed: number): number => {
  const v = Math.sin(phase * feel.screenShake.frequency + seed * 12.9898) * 43758.5453;
  return (v - Math.floor(v)) * 2 - 1;
};

/** Add trauma from a hit. Clamped to 1 so shake never runs away. */
export const addTrauma = (amount: number): void => {
  if (!feel.screenShake.enabled) return;
  trauma = Math.min(1, trauma + amount);
};

export interface ShakeOffset {
  x: number;
  y: number;
  /** Camera roll about the view axis, radians. */
  roll: number;
}

const ZERO: ShakeOffset = { x: 0, y: 0, roll: 0 };

/**
 * Advance the shake by real `dt` seconds and return this frame's offset.
 * Returns zero when disabled or fully decayed.
 */
export const shakeOffset = (dt: number): ShakeOffset => {
  if (!feel.screenShake.enabled || trauma <= 0) {
    trauma = 0;
    return ZERO;
  }
  phase += dt;
  trauma = Math.max(0, trauma - feel.screenShake.decayPerSec * dt);

  const shake = trauma * trauma;
  const { maxOffset, maxRoll } = feel.screenShake;
  return {
    x: noise(1) * shake * maxOffset,
    y: noise(2) * shake * maxOffset,
    roll: noise(3) * shake * maxRoll,
  };
};

/** Immediately clear shake (e.g. on reset). */
export const resetShake = (): void => {
  trauma = 0;
  phase = 0;
};
