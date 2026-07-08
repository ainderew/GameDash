/**
 * Melee combo chain. Spamming melee advances through these moves in order and then
 * loops (slash → alt slash → spin → uppercut → slash …). Shared by the weapon system
 * (timing/arc/damage) and the renderer (which procedural animation + VFX to play).
 */
export type ComboKey = 'slash' | 'altSlash' | 'spin' | 'uppercut';

export interface ComboMove {
  key: ComboKey;
  /** Total procedural animation length, ms. */
  animMs: number;
  /** Damage-dealing window from swing start, ms. */
  activeMs: number;
  /** Input lockout before the next move may start — short, so presses cancel-chain. */
  recoveryMs: number;
  /** Half-angle of the swing arc, radians (spin ≈ π → hits all around). */
  halfArc: number;
  /** Damage multiplier vs base MELEE_DAMAGE. */
  damageMul: number;
}

export const COMBO_MOVES: ComboMove[] = [
  { key: 'slash', animMs: 340, activeMs: 150, recoveryMs: 185, halfArc: Math.PI / 3, damageMul: 1 },
  { key: 'altSlash', animMs: 340, activeMs: 150, recoveryMs: 185, halfArc: Math.PI / 3, damageMul: 1 },
  { key: 'spin', animMs: 470, activeMs: 260, recoveryMs: 300, halfArc: Math.PI, damageMul: 1.15 },
  { key: 'uppercut', animMs: 500, activeMs: 200, recoveryMs: 360, halfArc: Math.PI / 4, damageMul: 1.7 },
];

/** After a move's animation ends, how long the player may still press to keep the chain. */
export const COMBO_CONTINUE_MS = 600;

/** The move at a (possibly out-of-range) combo index, wrapping around the chain. */
export const comboAt = (index: number): ComboMove =>
  COMBO_MOVES[((index % COMBO_MOVES.length) + COMBO_MOVES.length) % COMBO_MOVES.length]!;
