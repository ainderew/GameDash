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
