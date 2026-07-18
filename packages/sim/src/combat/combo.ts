import type { HitStrength } from '@shared/combat';

/**
 * Melee combo chain. Spamming melee advances through these moves in order and then
 * loops (horizontal cut → reverse cut → overhead strike → thrust → horizontal …). Shared by the weapon system
 * (timing/arc/damage) and the renderer (which procedural animation + VFX to play).
 *
 * PHASES: each move plays out as windup (anticipation) → active (hitbox live) → recovery
 * (commitment lockout), carved out of the clip by `hitWindow` below.
 * The move's TOTAL duration is NOT phase-derived: it is the actual mocap
 * clip length at its playback speed (see moveAnimMs), so the attack state, the rooting, and
 * the animation always end on the same frame — the swing visually completes, never cut off.
 */
export type ComboKey = 'horizontal' | 'reverse' | 'overhead' | 'thrust';

/** Which mocap attack clip a move plays (see AnimatedCharacter `attack-*` states). */
export type ComboClip = 'horizontal' | 'reverse' | 'overhead' | 'thrust';

export interface ComboMove {
  key: ComboKey;
  /** Light (jab) or heavy (committed) — selects phase timing AND feedback strength. */
  weight: HitStrength;
  /** Half-angle of the swing arc, radians (spin ≈ π → hits all around). */
  halfArc: number;
  /** Damage multiplier vs base MELEE_DAMAGE. */
  damageMul: number;
  /** Whether this move opens a gameplay hitbox during its authored blade delivery. */
  damaging: boolean;
  /** Normalized [start, end] of the visible blade delivery inside this clip. */
  hitWindow: readonly [number, number];
  /** Normalized VFX/audio trail window, padded slightly around the gameplay hit window. */
  trailWindow: readonly [number, number];
  /** Normalized authored contact pose at the center of the Blender blade delivery. */
  contactAt: number;
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
  /** Reach multiplier vs base MELEE_RANGE (default 1). Lets a skill swing hit from further. */
  readonly rangeMul?: number;
  /** Scales ONLY the lunge's motion window (not the anim or hitbox): <1 covers the same
   *  lungeDist in less time = a FASTER dash at the same distance. Default 1. */
  readonly lungeTimeMul?: number;
}

// Every click plays one complete authored attack: anticipation, delivery, contact, recovery.
// SNAPPY (character-action) tuning: contact lands early in the clip and the swing can be
// cancelled into the next move well before the animation fully settles, so mashing reads as a
// fast, aggressive chain rather than a rooted commitment. `hitWindow` starts are pulled forward
// (light contact ≈ 200ms from press) and `cancelAt` pulled in so recovery isn't dead time.
// These are FROZEN sim data (server + every client integrate them identically) — tune HERE.
export const COMBO_MOVES: readonly ComboMove[] = [
  {
    // Slash 1 — high→mid DIAGONAL DOWN-CUT (combo mocap f8–27, contact f20).
    // The opener carries the swing's own wind-up, so contact sits later in the clip than the
    // follow-ups; ATTACK_TIMESCALE runs it hot (1.7×) so the hit still lands ~0.24s from press.
    key: 'horizontal',
    weight: 'light',
    halfArc: Math.PI / 2,
    damageMul: 1,
    damaging: true,
    hitWindow: [0.52, 0.74],
    trailWindow: [0.46, 0.8],
    contactAt: 0.632,
    cancelAt: 0.7,
    lungeDist: 1.6,
    clip: 'horizontal',
  },
  {
    // Slash 2 — mid HORIZONTAL SWEEP (combo mocap f27–45, contact f34). Already snappy at 1x.
    key: 'reverse',
    weight: 'light',
    halfArc: Math.PI / 2,
    damageMul: 1.1,
    damaging: true,
    hitWindow: [0.28, 0.5],
    trailWindow: [0.22, 0.56],
    contactAt: 0.389,
    cancelAt: 0.55,
    lungeDist: 1.3,
    clip: 'reverse',
  },
  {
    // Slash 3 — big OVERHEAD CHOP (combo mocap f45–66, contact f55: hand rises to 0.84 then
    // plunges to 0.16). The natural end of the mocap combo — a heavy, committed downstrike.
    key: 'overhead',
    weight: 'heavy',
    halfArc: Math.PI / 3,
    damageMul: 1.4,
    damaging: true,
    hitWindow: [0.37, 0.6],
    trailWindow: [0.3, 0.66],
    contactAt: 0.476,
    cancelAt: 0.62,
    lungeDist: 1.0,
    clip: 'overhead',
  },
  {
    // Stage 4 — 360° SPIN FINISHER (separate "Standing Melee Attack 360 High" mocap, f8–38,
    // contact f22). A wide sweep that hits all around, the reward for completing the chain.
    // NOTE: the dash-slash skill borrows this clip (see weaponSystem), so it now also spins.
    key: 'thrust',
    weight: 'heavy',
    halfArc: Math.PI * 0.9,
    damageMul: 1.9,
    damaging: true,
    hitWindow: [0.34, 0.6],
    trailWindow: [0.28, 0.66],
    contactAt: 0.467,
    cancelAt: 0.66,
    lungeDist: 0.7,
    clip: 'thrust',
  },
];

/** After a move's animation ends, how long the player may still press to keep the chain. */
export const COMBO_CONTINUE_MS = 600;

/**
 * DASH SLASH — the "1" skill. A committed, heavy gap-closer: the swing's own root motion
 * carries the hero a long way forward (lungeDist), so the dash IS the attack. NOT part of
 * COMBO_MOVES (pressing 1 never advances the J-chain), but it borrows the thrust clip so
 * the renderer already knows how to animate it. FROZEN sim data — tune here, never at runtime.
 */
export const DASH_SLASH_MOVE: ComboMove = {
  key: 'thrust',
  weight: 'heavy',
  // Wide, forgiving AoE (~306° total) at a moderate radius — hits to the sides/behind so the
  // dash lands without pixel-perfect aim, but not a whole-arena grab.
  halfArc: Math.PI * 0.85,
  damageMul: 2.4,
  damaging: true,
  hitWindow: [0.35, 0.6],
  trailWindow: [0.3, 0.64],
  contactAt: 0.45,
  cancelAt: 0.65,
  // Lunge covers this distance over the same motion window, so a larger value = a FASTER
  // (and slightly longer) gap-closer. lungeSpeed integrates to lungeDist × rangeMul.
  lungeDist: 8.5,
  clip: 'thrust',
  rangeMul: 2.0,
  // Cover the same distance in a THIRD of the time — a fast, snappy blink of a dash.
  // (Exact even at this short window thanks to midpoint lunge sampling in applyPlayerIntent.)
  lungeTimeMul: 0.33,
};

/** The move at a (possibly out-of-range) combo index, wrapping around the chain. */
export const comboAt = (index: number): ComboMove =>
  COMBO_MOVES[((index % COMBO_MOVES.length) + COMBO_MOVES.length) % COMBO_MOVES.length]!;

/**
 * The move data a live attack should be simulated with. The dash-slash resolves to its own
 * bespoke move; every normal swing resolves through the chain. Both the hitbox (weaponSystem)
 * and the root-motion lunge (movementSystem) MUST go through this so the two never disagree.
 */
export const moveForAttack = (atk: { combo?: number; dashSlash?: boolean }): ComboMove =>
  atk.dashSlash ? DASH_SLASH_MOVE : comboAt(atk.combo ?? 0);

// ── Animation-true durations ─────────────────────────────────────────────────

/**
 * Source attack-clip lengths, seconds — FROZEN sim constants (Phase 3).
 * These are the MEASURED animation durations of the shipped hero GLBs
 * (apps/web/public/models/hero/anim-combo-*.glb, sliced in Blender from Mixamo mocap at 30fps):
 *   anim-combo-horizontal.glb 0.6333 s (combo f8–27, 19f) · anim-combo-reverse.glb 0.6 s (f27–45, 18f) ·
 *   anim-combo-overhead.glb 0.7 s (f45–66, 21f) · anim-combo-thrust.glb 1.0 s (360-spin f8–38, 30f)
 * Through Phase 2 the client STAMPED these at GLB-load time, which meant a headless
 * server would compute different swing windows/root motion than its clients and
 * reconciliation would fight the difference. Never stamp at runtime again — if a clip
 * is re-exported, re-measure and update HERE.
 */
export const ATTACK_CLIP_S: Readonly<Record<ComboClip, number>> = {
  horizontal: 0.633333,
  reverse: 0.6,
  overhead: 0.7,
  thrust: 1.0,
};

/**
 * Attack playback speed per clip — FROZEN sim constants (Phase 3; the leva
 * "Attack · speed" live panel is gone: it mutated shared sim data the server can't see).
 * The renderer reads it at swing start and moveAnimMs derives the swing window from it,
 * so gameplay duration and animation stay locked together.
 */
export const ATTACK_TIMESCALE: Readonly<Record<ComboClip, number>> = {
  // SNAPPY tuning: these sliced mocap clips carry real wind-up, so we run them hot to pull
  // time-to-contact into the ~0.2–0.29s band (character-action responsiveness) while keeping
  // the authored pose flow intact. Per-clip, because each slash's wind-up length differs:
  horizontal: 1.7, // 0.6333s clip, contact 0.632 → ~0.24s from press
  reverse: 1.15, //   0.6s   clip, contact 0.389 → ~0.20s
  overhead: 1.5, //   0.7s   clip, contact 0.476 → ~0.22s
  thrust: 1.6, //     1.0s spin, contact 0.467 → ~0.29s (heavier finisher)
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

/** Sword ribbon/audio window measured from swing start, aligned to the authored delivery. */
export const moveTrailWindow = (m: ComboMove): { start: number; end: number } => {
  const duration = moveAnimMs(m);
  return { start: duration * m.trailWindow[0], end: duration * m.trailWindow[1] };
};

/** Exact contact pose authored at the center of the Blender blade delivery. */
export const moveContactMs = (m: ComboMove): number => moveAnimMs(m) * m.contactAt;

/**
 * ROOT MOTION: forward speed (world units/sec) at `ageMs` into a swing. The character is
 * locked into the animation, but the swing itself strides forward — the full lungeDist × mul
 * is covered from swing start through the END of the active window (you step INTO the cut),
 * then holds ground through the recovery tail. Ease-out profile: fast first stride settling
 * to zero at contact. Integrates to exactly lungeDist × mul over the motion window.
 */
export const lungeSpeed = (m: ComboMove, ageMs: number, mul = 1): number => {
  // lungeTimeMul < 1 shrinks the window → same distance covered faster (a quicker dash).
  const motionMs = moveActiveWindow(m).end * (m.lungeTimeMul ?? 1);
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
export const moveCancelMs = (m: ComboMove): number =>
  m.damaging ? moveActiveWindow(m).end + MOVE_CANCEL_GRACE_MS : moveAnimMs(m);
