import { feel, type AttackPhaseTuning, type HitStrength } from '@/game/feel/config';

/**
 * Melee combo chain. Spamming melee advances through these moves in order and then
 * loops (slash → alt slash → spin → uppercut → slash …). Shared by the weapon system
 * (timing/arc/damage) and the renderer (which procedural animation + VFX to play).
 *
 * PHASES: each move plays out as windup (anticipation) → active (hitbox live) → recovery
 * (commitment lockout). Windup/active timings live in the tunable feel config, keyed by the
 * move's `weight`. The move's TOTAL duration is NOT phase-derived: it is the actual mocap
 * clip length at its playback speed (see moveAnimMs), so the attack state, the rooting, and
 * the animation always end on the same frame — the swing visually completes, never cut off.
 */
export type ComboKey = 'slash' | 'altSlash' | 'spin' | 'uppercut';

/** Which mocap attack clip a move plays (see AnimatedCharacter `attack-*` states). */
export type ComboClip = 'light1' | 'light2' | 'spin' | 'finisher';

export interface ComboMove {
  key: ComboKey;
  /** Light (jab) or heavy (committed) — selects phase timing AND feedback strength. */
  weight: HitStrength;
  /** Half-angle of the swing arc, radians (spin ≈ π → hits all around). */
  halfArc: number;
  /** Damage multiplier vs base MELEE_DAMAGE. */
  damageMul: number;
  /** Normalized [start, end] of the visible blade delivery inside this clip. */
  hitWindow: readonly [number, number];
  /** Normalized point at which a buffered next move may take over. */
  cancelAt: number;
  /**
   * Root motion: forward distance (world units) the swing itself carries the character.
   * MUTABLE — the leva "Attack · lunge" panel writes here live; bake tuned values back.
   */
  lungeDist: number;
  /** Mocap clip this move plays. */
  clip: ComboClip;
}

// Every move plays its OWN self-contained single-swing clip (each starts/ends near the
// guard stance), so chained crossfades line up and mashing reads as a choreographed chain.
export const COMBO_MOVES: ComboMove[] = [
  { key: 'slash', weight: 'light', halfArc: Math.PI / 3, damageMul: 1, hitWindow: [0.32, 0.45], cancelAt: 0.88, lungeDist: 1.6, clip: 'light1' },
  { key: 'altSlash', weight: 'light', halfArc: Math.PI / 3, damageMul: 1, hitWindow: [0.34, 0.48], cancelAt: 0.88, lungeDist: 1.6, clip: 'light2' },
  { key: 'spin', weight: 'heavy', halfArc: Math.PI, damageMul: 1.15, hitWindow: [0.38, 0.62], cancelAt: 0.9, lungeDist: 0.35, clip: 'spin' },
  { key: 'uppercut', weight: 'heavy', halfArc: Math.PI / 4, damageMul: 1.7, hitWindow: [0.42, 0.56], cancelAt: 0.92, lungeDist: 1.4, clip: 'finisher' },
];

/** After a move's animation ends, how long the player may still press to keep the chain. */
export const COMBO_CONTINUE_MS = 600;

/** The move at a (possibly out-of-range) combo index, wrapping around the chain. */
export const comboAt = (index: number): ComboMove =>
  COMBO_MOVES[((index % COMBO_MOVES.length) + COMBO_MOVES.length) % COMBO_MOVES.length]!;

// ── Animation-true durations ─────────────────────────────────────────────────

/**
 * Source attack-clip lengths, seconds. Stamped with the REAL durations by AnimatedCharacter
 * when the glbs load; these fallbacks are the measured export lengths (used headless/in tests).
 */
export const ATTACK_CLIP_S: Record<ComboClip, number> = {
  light1: 1.13,
  light2: 1.2,
  spin: 1.6,
  finisher: 1.8,
};

/**
 * Attack playback speed per clip. MUTABLE — the leva "Attack · speed" panel writes here live;
 * the renderer reads it at swing start and moveAnimMs reads it when stamping the swing window,
 * so gameplay duration and animation stay locked together while tuning.
 */
export const ATTACK_TIMESCALE: Record<ComboClip, number> = {
  // Let the contact and follow-through read. These are still responsive, but no longer
  // compress the mocap so far that the weapon appears to stop short of its full arc.
  light1: 1.4,
  light2: 1.4,
  spin: 1.3,
  finisher: 1.25,
};

// ── Phase timing helpers (read the tunable config live) ─────────────────────

/** The live windup/active timing for a move, from the feel config. */
export const movePhase = (m: ComboMove): AttackPhaseTuning => feel.phases[m.weight];

/**
 * Total swing duration = the actual clip length at its playback speed, ms. The attack state,
 * the movement rooting, and the animation all share this ONE number, so the swing anim always
 * plays to completion and gameplay matches what's on screen.
 */
export const moveAnimMs = (m: ComboMove): number =>
  (ATTACK_CLIP_S[m.clip] / ATTACK_TIMESCALE[m.clip]) * 1000;

/** Hitbox-live window measured from swing start, ms: [start, end). Clamped into the anim. */
export const moveActiveWindow = (m: ComboMove): { start: number; end: number } => {
  const duration = moveAnimMs(m);
  return { start: duration * m.hitWindow[0], end: duration * m.hitWindow[1] };
};

/**
 * ROOT MOTION: forward speed (world units/sec) at `ageMs` into a swing. The character is
 * locked into the animation, but the swing itself strides forward — the full lungeDist × mul
 * is covered from swing start through the END of the active window (you step INTO the cut),
 * then holds ground through the recovery tail. Ease-out profile: fast first stride settling
 * to zero at contact. Integrates to exactly lungeDist × mul over the motion window.
 */
export const lungeSpeed = (m: ComboMove, ageMs: number, mul = 1): number => {
  const motionMs = moveActiveWindow(m).end;
  if (ageMs < 0 || ageMs >= motionMs) return 0;
  const p = ageMs / motionMs;
  return (2 * (1 - p) * m.lungeDist * mul) / (motionMs / 1000);
};

/** How far into the swing (fraction of the full anim) a chain press may cancel into the next move. */
// Keep nearly all of the outgoing swing visible before a buffered input takes over.
// The existing input buffer preserves responsiveness even though the handoff is later.
export const CHAIN_CANCEL_FRAC = 0.86;

/**
 * When the NEXT melee press is accepted, ms from swing start: never before the hitbox closes,
 * and never before most of the swing has visibly played — chaining cancels only the tail.
 * (A dodge, by contrast, cancels the swing at ANY point — see applyPlayerIntent.)
 */
export const chainReadyMs = (m: ComboMove): number => {
  const { end } = moveActiveWindow(m);
  return Math.max(end, moveAnimMs(m) * Math.max(CHAIN_CANCEL_FRAC, m.cancelAt));
};
