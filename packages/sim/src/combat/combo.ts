import type { HitStrength } from '@shared/combat';

/**
 * Melee combo chain. Spamming melee advances through these moves in order and then
 * loops (slash → alt slash → spin → uppercut → slash …). Shared by the weapon system
 * (timing/arc/damage) and the renderer (which procedural animation + VFX to play).
 *
 * PHASES: each move plays out as windup (anticipation) → active (hitbox live) → recovery
 * (commitment lockout), carved out of the clip by `hitWindow` below.
 * The move's TOTAL duration is NOT phase-derived: it is the actual mocap
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
   * FROZEN sim data (Phase 3): the server and every client must integrate the identical
   * lunge or reconciliation fires corrections — never mutate at runtime. (The old leva
   * "Attack · lunge" live panel is gone for this reason; tune here, in source.)
   */
  readonly lungeDist: number;
  /** Mocap clip this move plays. */
  clip: ComboClip;
}

// Every move plays its OWN self-contained single-swing clip (each starts/ends near the
// guard stance), so chained crossfades line up and mashing reads as a choreographed chain.
// SNAPPY (character-action) tuning: contact lands early in the clip and the swing can be
// cancelled into the next move well before the animation fully settles, so mashing reads as a
// fast, aggressive chain rather than a rooted commitment. `hitWindow` starts are pulled forward
// (light contact ≈ 200ms from press) and `cancelAt` pulled in so recovery isn't dead time.
// These are FROZEN sim data (server + every client integrate them identically) — tune HERE.
export const COMBO_MOVES: readonly ComboMove[] = [
  { key: 'slash', weight: 'light', halfArc: Math.PI / 3, damageMul: 1, hitWindow: [0.2, 0.36], cancelAt: 0.5, lungeDist: 1.6, clip: 'light1' },
  { key: 'altSlash', weight: 'light', halfArc: Math.PI / 3, damageMul: 1, hitWindow: [0.22, 0.38], cancelAt: 0.5, lungeDist: 1.6, clip: 'light2' },
  { key: 'spin', weight: 'heavy', halfArc: Math.PI, damageMul: 1.15, hitWindow: [0.3, 0.54], cancelAt: 0.62, lungeDist: 0.35, clip: 'spin' },
  { key: 'uppercut', weight: 'heavy', halfArc: Math.PI / 4, damageMul: 1.7, hitWindow: [0.34, 0.5], cancelAt: 0.68, lungeDist: 1.4, clip: 'finisher' },
];

/** After a move's animation ends, how long the player may still press to keep the chain. */
export const COMBO_CONTINUE_MS = 600;

/** The move at a (possibly out-of-range) combo index, wrapping around the chain. */
export const comboAt = (index: number): ComboMove =>
  COMBO_MOVES[((index % COMBO_MOVES.length) + COMBO_MOVES.length) % COMBO_MOVES.length]!;

// ── Animation-true durations ─────────────────────────────────────────────────

/**
 * Source attack-clip lengths, seconds — FROZEN sim constants (Phase 3).
 * These are the MEASURED animation durations of the shipped hero GLBs
 * (apps/web/public/models/hero/anim-*.glb, max keyframe time of the mixamo.com clip):
 *   anim-attack-l1.glb 1.6667 s · anim-attack-l2.glb 1.5 s ·
 *   anim-spin.glb 2.25 s · anim-finisher.glb 2.625 s
 * Through Phase 2 the client STAMPED these at GLB-load time, which meant a headless
 * server would compute different swing windows/root motion than its clients and
 * reconciliation would fight the difference. Never stamp at runtime again — if a clip
 * is re-exported, re-measure and update HERE.
 */
export const ATTACK_CLIP_S: Readonly<Record<ComboClip, number>> = {
  light1: 1.6667,
  light2: 1.5,
  spin: 2.25,
  finisher: 2.625,
};

/**
 * Attack playback speed per clip — FROZEN sim constants (Phase 3; the leva
 * "Attack · speed" live panel is gone: it mutated shared sim data the server can't see).
 * The renderer reads it at swing start and moveAnimMs derives the swing window from it,
 * so gameplay duration and animation stay locked together.
 */
export const ATTACK_TIMESCALE: Readonly<Record<ComboClip, number>> = {
  // SNAPPY: lights play fast enough to feel like quick jabs (~1s → ~0.6s felt via the earlier
  // cancel window), heavies stay a touch weightier for commitment. Pushed up from the earlier
  // "read the full arc" values toward the character-action feel bar — still short of comical
  // compression. Read by the renderer at swing start so animation stays locked to gameplay.
  light1: 1.65,
  light2: 1.65,
  spin: 1.45,
  finisher: 1.35,
};

// ── Phase timing helpers ─────────────────────────────────────────────────────

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
// SNAPPY: the outgoing swing can be cancelled into the next move once it's ~halfway (just past
// its active window), so a mashed combo flows without waiting out the recovery tail. The FADE_FAST
// crossfade smooths the handoff; the input buffer still catches presses made during the swing.
export const CHAIN_CANCEL_FRAC = 0.5;

/**
 * When the NEXT melee press is accepted, ms from swing start: never before the hitbox closes,
 * and never before most of the swing has visibly played — chaining cancels only the tail.
 * (A dodge, by contrast, cancels the swing at ANY point — see applyPlayerIntent.)
 */
export const chainReadyMs = (m: ComboMove): number => {
  const { end } = moveActiveWindow(m);
  return Math.max(end, moveAnimMs(m) * Math.max(CHAIN_CANCEL_FRAC, m.cancelAt));
};

/** Short beat after the blade passes before free locomotion may break the recovery tail, ms. */
export const MOVE_CANCEL_GRACE_MS = 60;

/**
 * From swing start, ms after which fresh WASD input CANCELS the recovery tail and the player
 * walks out of the swing (character-action snappiness — a single tap doesn't root you for the
 * whole clip). Never before the hitbox closes, so a step-out can't erase the blade. Purely
 * input-driven, so it's identical on server and every client replay (no server-force divergence).
 */
export const moveCancelMs = (m: ComboMove): number => moveActiveWindow(m).end + MOVE_CANCEL_GRACE_MS;
