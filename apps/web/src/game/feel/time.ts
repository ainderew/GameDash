/**
 * TIME CONTROL — the heart of hitstop.
 *
 * The sim runs on a *game clock* (`gameNow()`), which is separate from wall-clock time.
 * Hitstop and slow-mo simply stop (or slow) the advance of this clock. Because every
 * gameplay system and gameplay animation reads `gameNow()`, freezing it freezes the
 * ENTIRE fight — attacker and target both — on one frame.
 *
 * Feel FX (sparks, shockwave, screen shake, audio) deliberately DO NOT use this clock;
 * they run on real `performance.now()` / real delta, so they keep bursting while the sim
 * is frozen. That contrast — motion frozen, effects erupting — is what sells the impact.
 *
 * Usage (SystemRunner, once per frame):
 *   const { scaledDt } = advanceTime(rawDt);   // rawDt = real seconds this frame
 *   const now = gameNow();                      // frozen during hitstop
 *   ...run systems with (now, scaledDt)...
 */

let gameTimeMs = 0;

/** Remaining real-time budget of a full freeze (timeScale 0). */
let hitstopRealMs = 0;
/** Remaining real-time budget of a slow-mo window. */
let slowmoRealMs = 0;
let slowmoScale = 1;

/** The game clock, in ms. Frozen while hitstop is active, slowed during slow-mo. */
export const gameNow = (): number => gameTimeMs;

/**
 * Freeze the whole sim for `ms` of REAL time. Multiple requests don't stack — the
 * longest wins (a heavy hit mid-freeze extends, a light one doesn't shorten).
 */
export const requestHitstop = (ms: number): void => {
  if (ms > hitstopRealMs) hitstopRealMs = ms;
};

/** Drop into slow-mo (scale < 1) for `ms` of real time. Used by parry. */
export const requestSlowmo = (scale: number, ms: number): void => {
  slowmoScale = scale;
  if (ms > slowmoRealMs) slowmoRealMs = ms;
};

/** Current sim time scale: 0 while frozen, `slowmoScale` during slow-mo, else 1. */
export const currentTimeScale = (): number => {
  if (hitstopRealMs > 0) return 0;
  if (slowmoRealMs > 0) return slowmoScale;
  return 1;
};

export const isFrozen = (): boolean => hitstopRealMs > 0;

/**
 * Advance both clocks by one frame. `rawDtSec` is REAL delta seconds. Returns the
 * scaled (game) delta to feed the sim. Consumes the hitstop/slow-mo budgets on real time
 * so effects unfreeze on schedule regardless of how slow game time is running.
 */
export const advanceTime = (rawDtSec: number): { scaledDt: number } => {
  const rawMs = rawDtSec * 1000;
  const scale = currentTimeScale();
  gameTimeMs += rawMs * scale;

  if (hitstopRealMs > 0) {
    hitstopRealMs = Math.max(0, hitstopRealMs - rawMs);
  } else if (slowmoRealMs > 0) {
    slowmoRealMs = Math.max(0, slowmoRealMs - rawMs);
    if (slowmoRealMs === 0) slowmoScale = 1;
  }

  return { scaledDt: rawDtSec * scale };
};

/**
 * NETWORKED driver override (Phase 3): in a multiplayer session the sim clock is the
 * fixed-tick timeline (clientTick × MS_PER_TICK), not the accumulated frame clock —
 * entity timers must be stamped in tick time so prediction replay is deterministic.
 * SystemRunner calls this once per frame with tickTime + alpha remainder so renderers
 * reading gameNow() (animation gates, footsteps) stay smooth and consistent with the
 * ECS timers. Hitstop/slow-mo never run in the hub, so nothing is lost while networked.
 */
export const syncGameTime = (ms: number): void => {
  gameTimeMs = ms;
};

/** Test/lifecycle reset. */
export const resetTime = (): void => {
  gameTimeMs = 0;
  hitstopRealMs = 0;
  slowmoRealMs = 0;
  slowmoScale = 1;
};
