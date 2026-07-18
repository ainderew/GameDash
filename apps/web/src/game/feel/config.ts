/**
 * COMBAT FEEL — the single source of truth for every "juice" value.
 *
 * This whole layer exists to make hits land with weight. Every number here is meant
 * to be dialed in BY FEEL — tweak, play, repeat. The `<FeelControls/>` leva panel binds
 * to this object live, so you can tune during play; systems read the mutable object each
 * frame (never a React snapshot), so edits take effect immediately.
 *
 * Default tuning comes from the design brief's table. Two archetypes drive most values:
 *   - `light`  — a jab: crisp, immediate, low commitment.
 *   - `heavy`  — a committed strike: slower windup, big payoff (freeze + shake + launch).
 *
 * SIM SPLIT (multiplayer Phase 1): values the headless sim consumes in gameplay math —
 * knockback, hitstun, parry rules, body radii — LIVE in @shared/balance now (they're
 * balance, not juice). This object ALIASES those (same object identity / passthrough
 * accessors), so the leva panel keeps live-tuning them exactly as before.
 */

import {
  BODY_TUNING,
  HITSTUN_MS,
  KNOCKBACK_TUNING,
  PARRY_TUNING,
} from '@shared/balance';

export type { ByStrength, HitStrength } from '@shared/combat';
import type { ByStrength, HitStrength } from '@shared/combat';


export interface FeelConfig {
  // ── 1. HITSTOP (hitpause) ────────────────────────────────────────────────
  /** Freeze duration for the whole sim on a confirmed hit, ms. THE impact primitive. */
  hitstopMs: ByStrength<number>;

  // ── 2/3. KNOCKBACK + SOLID BODIES ────────────────────────────────────────
  knockback: {
    /** Initial launch speed away from the attacker, world units/sec. */
    speed: ByStrength<number>;
    /** Slight upward pop on impact, world units/sec (heavier hits launch more). */
    launch: ByStrength<number>;
    /** Velocity decay per second (higher = knockback dies faster). Ground "friction". */
    friction: number;
    /** Multiplier on speed/launch when the PLAYER is the one shoved (0 = old no-knockback). */
    playerScale: number;
  };
  /** Multiplier applied to body radii for the solid push-apart. 1 = touch exactly. */
  bodyRadiusScale: number;

  // ── 4. SCREEN SHAKE (trauma model) ───────────────────────────────────────
  screenShake: {
    enabled: boolean;
    /** Trauma added per hit (clamped to 1). shake = trauma². */
    traumaPerHit: ByStrength<number>;
    /** Max positional shake at trauma=1, world units. */
    maxOffset: number;
    /** Max camera roll at trauma=1, radians. */
    maxRoll: number;
    /** Trauma decay per second. */
    decayPerSec: number;
    /** Shake oscillation frequency, Hz-ish (higher = buzzier). */
    frequency: number;
  };

  // ── 5. TARGET HIT REACTION ───────────────────────────────────────────────
  /** How long the target is staggered (can't act while knockback plays), ms. */
  hitstunMs: ByStrength<number>;
  flash: {
    /** Flash hold duration, ms. */
    durationMs: ByStrength<number>;
    /** Light = white, heavy = red (hex). */
    colorLight: string;
    colorHeavy: string;
    /** Emissive intensity of the flash (additive). */
    intensity: number;
  };
  squash: {
    /** Peak squash&stretch amount (0.3 = ±30%). */
    amount: ByStrength<number>;
    /** Squash settle duration, ms. */
    durationMs: number;
  };

  // ── 6. IMPACT VFX ────────────────────────────────────────────────────────
  vfx: {
    /** Spark shards per burst. */
    sparkCount: ByStrength<number>;
    /** Spark travel distance at full life, world units. */
    sparkRadius: ByStrength<number>;
    /** Spark burst lifetime, ms. Kept longer than hitstop so the release has a tail. */
    sparkLifetimeMs: ByStrength<number>;
    /** Accent colors for flying shards; the central flash stays white-hot for clarity. */
    sparkColors: ByStrength<Array<readonly [number, number, number]>>;
    /** Shockwave ring final radius, world units. */
    ringRadius: ByStrength<number>;
    /** Shockwave ring lifetime, ms. */
    ringLifetimeMs: number;
    colorLight: string;
    colorHeavy: string;
    /** Play the Blender-authored flipbook billboard instead of procedural sparks+ring. */
    blenderFlipbook: boolean;
    /** Flipbook billboard lifetime, ms. */
    flipbookLifetimeMs: ByStrength<number>;
    /** Flipbook billboard world size (diameter). */
    flipbookSize: ByStrength<number>;
    /** Dash-slash skill billboard size (diameter) — bigger, its own dramatic Blender sheet. */
    flipbookDashSlashSize: number;
  };

  // ── 7. IMPACT AUDIO ──────────────────────────────────────────────────────
  audio: {
    enabled: boolean;
    /** 0..1 master gain for all feel SFX. */
    masterVolume: number;
  };

  // NOTE: swing phase timing (windup → active → recovery) is NOT here. It lives in the frozen
  // sim constants at packages/sim/src/combat/combo.ts (moveActiveWindow / moveAnimMs), shared
  // byte-for-byte with the server — duplicating it here would let the two drift.

  // ── OPTIONAL: parry ──────────────────────────────────────────────────────
  parry: {
    enabled: boolean;
    /** Block window at attack startup that negates the incoming hit, ms. */
    windowMs: number;
    /** Time scale during the parry flourish (0.15 = heavy slow-mo). */
    slowmoScale: number;
    /** Real-time duration of the parry slow-mo, ms. */
    slowmoMs: number;
    /** How long the parried attacker is staggered, ms. */
    attackerStunMs: number;
  };
}

/**
 * Live, mutable defaults. Import this object and read fields each frame.
 * NEVER destructure at module load — that captures a stale snapshot.
 */
export const feel: FeelConfig = {
  // Short contact holds preserve impact without turning a fast combo into visible stutter.
  // 45/90ms is roughly 3/5 frames at 60fps; the old 110/240ms froze 7/14 frames.
  hitstopMs: { light: 45, heavy: 90 },

  // ALIASED into @shared/balance (same object) — the sim reads it there, leva tunes here.
  knockback: KNOCKBACK_TUNING,
  get bodyRadiusScale() {
    return BODY_TUNING.radiusScale;
  },
  set bodyRadiusScale(v: number) {
    BODY_TUNING.radiusScale = v;
  },

  screenShake: {
    enabled: true,
    traumaPerHit: { light: 0.4, heavy: 0.8 },
    maxOffset: 0.55,
    maxRoll: 0.06,
    decayPerSec: 1.6,
    frequency: 26,
  },

  // ALIASED into @shared/balance (same object) — hitstun is sim math now.
  hitstunMs: HITSTUN_MS,
  flash: {
    durationMs: { light: 120, heavy: 180 },
    colorLight: '#ffffff',
    colorHeavy: '#ff3020',
    intensity: 1.7,
  },
  squash: {
    amount: { light: 0.18, heavy: 0.34 },
    durationMs: 220,
  },

  vfx: {
    // A deliberately small burst: the hot central cluster, directional streaks and bloom
    // carry the read better than throwing hundreds of transparent particles at the screen.
    sparkCount: { light: 8, heavy: 14 },
    sparkRadius: { light: 1.25, heavy: 2.35 },
    sparkLifetimeMs: { light: 340, heavy: 440 },
    // Cyan/violet keep light cuts arcane; the heavier palette adds magenta and hotter gold.
    // Values are linear RGB and are written straight into the pooled vertex-color buffer.
    sparkColors: {
      light: [
        [0.3, 0.95, 1],
        [0.65, 0.4, 1],
        [1, 0.42, 0.82],
        [1, 0.82, 0.2],
      ],
      heavy: [
        [0.12, 1, 0.95],
        [0.55, 0.18, 1],
        [1, 0.16, 0.52],
        [1, 0.62, 0.08],
      ],
    },
    // This is a camera-facing contact halo, not a large ground decal. Keeping it compact
    // prevents a rapid combo from covering the play space in transparent overdraw.
    ringRadius: { light: 0.78, heavy: 1.35 },
    ringLifetimeMs: 260,
    colorLight: '#fff4c2',
    colorHeavy: '#ffb03a',
    // Blender-authored flipbook: a baked sprite-sheet burst played on a single billboard.
    blenderFlipbook: true,
    flipbookLifetimeMs: { light: 400, heavy: 520 },
    flipbookSize: { light: 2.7, heavy: 4.0 },
    flipbookDashSlashSize: 6.0,
  },

  audio: {
    enabled: true,
    masterVolume: 0.8,
  },

  // enabled/windowMs/attackerStunMs pass through to @shared/balance (sim rules);
  // the slow-mo flourish stays purely client feel.
  parry: {
    get enabled() {
      return PARRY_TUNING.enabled;
    },
    set enabled(v: boolean) {
      PARRY_TUNING.enabled = v;
    },
    get windowMs() {
      return PARRY_TUNING.windowMs;
    },
    set windowMs(v: number) {
      PARRY_TUNING.windowMs = v;
    },
    slowmoScale: 0.15,
    slowmoMs: 260,
    get attackerStunMs() {
      return PARRY_TUNING.attackerStunMs;
    },
    set attackerStunMs(v: number) {
      PARRY_TUNING.attackerStunMs = v;
    },
  },
};

/** Pick a light/heavy value. */
export const byStrength = <T>(v: ByStrength<T>, s: HitStrength): T => v[s];
