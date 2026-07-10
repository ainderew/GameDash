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
 */

export type HitStrength = 'light' | 'heavy';

/** A value that differs for light vs heavy hits. */
export interface ByStrength<T> {
  light: T;
  heavy: T;
}

export interface AttackPhaseTuning {
  /** Anticipation before the hitbox goes live, ms. The telegraph that makes the strike snap. */
  windupMs: number;
  /** Hitbox-live window, ms. */
  activeMs: number;
  /** Commitment lockout after the active window, ms. */
  recoveryMs: number;
}

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
  };

  // ── 7. IMPACT AUDIO ──────────────────────────────────────────────────────
  audio: {
    enabled: boolean;
    /** 0..1 master gain for all feel SFX. */
    masterVolume: number;
  };

  // ── 8. ATTACK PHASES (windup → active → recovery) ────────────────────────
  /** Phase timings by weight. Individual combo moves pick light or heavy. */
  phases: ByStrength<AttackPhaseTuning>;

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
  hitstopMs: { light: 110, heavy: 240 },

  knockback: {
    speed: { light: 20, heavy: 16 },
    launch: { light: 0.5, heavy: 4.5 },
    friction: 9,
    playerScale: 0.6,
  },
  bodyRadiusScale: 1,

  screenShake: {
    enabled: true,
    traumaPerHit: { light: 0.4, heavy: 0.8 },
    maxOffset: 0.55,
    maxRoll: 0.06,
    decayPerSec: 1.6,
    frequency: 26,
  },

  hitstunMs: { light: 280, heavy: 500 },
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
  },

  audio: {
    enabled: true,
    masterVolume: 0.8,
  },

  phases: {
    light: { windupMs: 80, activeMs: 90, recoveryMs: 160 },
    heavy: { windupMs: 300, activeMs: 100, recoveryMs: 400 },
  },

  parry: {
    enabled: true,
    windowMs: 150,
    slowmoScale: 0.15,
    slowmoMs: 260,
    attackerStunMs: 700,
  },
};

/** Pick a light/heavy value. */
export const byStrength = <T>(v: ByStrength<T>, s: HitStrength): T => v[s];
