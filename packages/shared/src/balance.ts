/**
 * Single source of truth for gameplay tuning.
 * ANTI-PATTERN: never hardcode these numbers in components — import from here.
 */

/** Horizontal move speed while sprinting (Shift held), world units per second. */
export const PLAYER_SPEED = 6;

/** Default horizontal move speed (plain WASD = walk), world units per second. */
export const PLAYER_WALK_SPEED = 2.8;

/** Distance covered by a single dodge dash, world units. */
export const DODGE_DISTANCE = 4;

/** Duration of the dodge dash itself, ms. */
export const DODGE_DURATION_MS = 180;

/** Invulnerability window granted by a dodge, ms (consumed by combat in Phase 2). */
export const DODGE_IFRAME_MS = 350;

/** Cooldown before another dodge can start, ms. */
export const DODGE_COOLDOWN_MS = 550;

/** Upward impulse applied on jump, world units per second. */
export const JUMP_IMPULSE = 7;

/** Gravity acceleration, world units per second squared (negative = down). */
export const GRAVITY = -22;

/** Camera follow distance behind the player, world units. */
export const CAMERA_DISTANCE = 8.5;

/** Camera height offset above the player, world units (with DISTANCE ⇒ ~48° look-down). */
export const CAMERA_HEIGHT = 10.5;

/** Camera smoothing factor (higher = snappier). */
export const CAMERA_DAMPING = 6;

// ── Combat: player weapons ────────────────────────────────────────────────
/** Base melee damage per swing. */
export const MELEE_DAMAGE = 34;
/** Reach of the melee arc, world units. */
export const MELEE_RANGE = 2.4;
/** Half-angle of the melee arc, radians (total arc = 2×). */
export const MELEE_HALF_ARC = Math.PI / 3;
/** Cooldown between melee swings, ms. */
export const MELEE_COOLDOWN_MS = 420;
/** Duration the swing's hit query stays active, ms. */
export const MELEE_ACTIVE_MS = 160;

/** Base ranged (projectile) damage. */
export const RANGED_DAMAGE = 22;
/** Projectile travel speed, world units/sec. */
export const PROJECTILE_SPEED = 22;
/** Projectile collision radius, world units. */
export const PROJECTILE_RADIUS = 0.35;
/** Projectile max lifetime before despawn, ms. */
export const PROJECTILE_LIFETIME_MS = 1600;
/** Cooldown between ranged shots, ms. */
export const RANGED_COOLDOWN_MS = 300;

// ── UI: enemy health bars ─────────────────────────────────────────────────
/** How long a monster's HP bar stays fully visible after its last hit, ms. */
export const HP_BAR_LINGER_MS = 3000;
/** Fade-out duration once the linger window expires, ms. */
export const HP_BAR_FADE_MS = 400;
/** Hold before the white "chip" segment starts draining toward current HP, ms. */
export const HP_BAR_GHOST_HOLD_MS = 350;
/** Exponential drain rate of the chip segment once the hold expires (higher = faster). */
export const HP_BAR_GHOST_DRAIN = 9;

// ── Combat: spawning / pickups ────────────────────────────────────────────
/** Hard cap on simultaneously-alive monsters (perf guard). */
export const MAX_MONSTERS = 60;
/** Radius within which a pickup is auto-collected, world units. */
export const PICKUP_RANGE = 1.4;

// ── Relic (RELIC RELAY core object) ───────────────────────────────────────
/** Carried Relic float anchor: behind and above the LEFT shoulder (local to facing). */
export const RELIC_CARRY_OFFSET: readonly [number, number, number] = [-0.85, 1.7, -0.35];
/** Aim-mode anchor: forward into the left edge of frame, steadier and readable. */
export const RELIC_AIM_OFFSET: readonly [number, number, number] = [-0.55, 1.45, 0.6];
/** Ground speed of a thrown Relic along its arc, world units/sec. */
export const RELIC_THROW_SPEED = 14;
/** Maximum throw distance, world units (aim past this and the throw clamps). */
export const RELIC_THROW_RANGE = 12;
/** Minimum throw distance — a throw at your own feet still leaves your hands. */
export const RELIC_THROW_MIN = 2;
/** Floor on flight time so short lobs still read as an arc, ms. */
export const RELIC_FLIGHT_MIN_MS = 280;
/** XZ radius within which a player catches the Relic (in flight or grounded). */
export const RELIC_CATCH_RADIUS = 1.3;
/** Max vertical separation for a catch — you can't catch it at the top of its arc. */
export const RELIC_CATCH_HEIGHT = 2.2;
/** After a throw, nobody can catch it for this long (stops instant self-recatch), ms. */
export const RELIC_RECATCH_DELAY_MS = 300;
/** How high the grounded Relic hovers above the terrain, world units. */
export const RELIC_GROUND_HOVER = 0.6;
/** Radius of the defensive shockwave a successful catch releases, world units. */
export const RELIC_SHOCKWAVE_RADIUS = 3.5;
/** Stagger applied to monsters caught in the catch shockwave, ms. */
export const RELIC_SHOCKWAVE_STUN_MS = 300;
/** Knockback speed the catch shockwave applies to nearby monsters, world units/sec. */
export const RELIC_SHOCKWAVE_KNOCKBACK = 7;

// ── Relic passing (soft auto-aim + deterministic Bézier flight) ───────────
/** Max pass distance, world units. */
export const RELIC_PASS_RANGE = 15;
/** Half-angle of the aimed-pass selection cone around camera forward, degrees. */
export const RELIC_PASS_CONE_DEG = 35;
/** Quick pass (tap) requires stronger intent — a narrower cone. */
export const RELIC_QUICK_CONE_DEG = 27;
/** Selected target is only dropped once it leaves this wider cone (hysteresis). */
export const RELIC_RELEASE_CONE_DEG = 48;
/** Another candidate must beat the selected target's score by this much to steal lock. */
export const RELIC_SWITCH_MARGIN = 0.15;
/** Holding E longer than this enters aim mode; releasing earlier is a quick pass, ms. */
export const RELIC_QUICK_TAP_MS = 160;
/** After passing, that player can't receive again for this long (forces rotation), ms. */
export const RELIC_PASS_RECATCH_MS = 2500;
/** How far ahead of the receiver's velocity the throw leads them, seconds. */
export const RELIC_LEAD_S = 0.15;
/** Flight duration = clamp(distance / this, min, max) — seconds and world units/sec. */
export const RELIC_PASS_SPEED = 20;
export const RELIC_PASS_DURATION_MIN_S = 0.25;
export const RELIC_PASS_DURATION_MAX_S = 0.65;
/** Bézier arc height = clamp(0.55 + distance × 0.11, min, max), world units. */
export const RELIC_PASS_ARC_MIN = 0.6;
export const RELIC_PASS_ARC_MAX = 2.2;
/** Homing begins in the last portion of flight (fraction of t). */
export const RELIC_HOMING_START_T = 0.62;
/** Max endpoint correction while homing; beyond this the pass fails into a drop. */
export const RELIC_HOMING_MAX_CORRECTION = 3;
/** One-hit handoff shield granted to the receiver on catch, ms. */
export const RELIC_HANDOFF_SHIELD_MS = 400;
/** Chest height of the catch socket above an entity's feet, world units. */
export const RELIC_CATCH_SOCKET_Y = 1.2;
/** Carrier moves at this fraction of normal speed while aiming a pass. */
export const RELIC_AIM_MOVE_SCALE = 0.8;

// ── Relic pass failure (bounce-once landing) ──────────────────────────────
/** How far the failed Relic bounces along its remaining momentum, world units. */
export const RELIC_FAIL_BOUNCE_DIST = 1.2;
/** Peak height of the bounce hop, world units. */
export const RELIC_FAIL_BOUNCE_ARC = 0.5;
/** Bounce hop duration, ms. */
export const RELIC_FAIL_BOUNCE_MS = 260;
/** How long the grounded marker runs "hot" after a failed pass, ms. */
export const RELIC_FAIL_HOT_MS = 1500;
