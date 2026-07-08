/**
 * Pure combat rules — no rendering, no Rapier, no ECS coupling.
 * These are the correctness-critical, headless-testable pieces.
 */

export type Faction = 'player' | 'monster';

export interface DamageModifiers {
  /** Multiplicative damage bonus, e.g. 0.2 = +20%. */
  bonusPct?: number;
  /** Flat damage added after the percentage bonus. */
  flat?: number;
  /** True if this hit is a critical (doubles the result). */
  crit?: boolean;
}

/** Compute final damage from a base value and modifiers. Always ≥ 0, integer. */
export const computeDamage = (base: number, mods: DamageModifiers = {}): number => {
  const { bonusPct = 0, flat = 0, crit = false } = mods;
  let dmg = base * (1 + bonusPct) + flat;
  if (crit) dmg *= 2;
  return Math.max(0, Math.round(dmg));
};

/** A minimal shape any i-frame check needs — avoids importing the ECS Entity here. */
export interface IFrameCarrier {
  iframeUntil?: number;
}

/** True if the entity is currently invulnerable (mid-dodge i-frames). */
export const isInIFrames = (entity: IFrameCarrier, now: number): boolean =>
  (entity.iframeUntil ?? 0) > now;

/** Whether `attacker` and `target` are on opposing factions (can damage each other). */
export const isHostile = (attacker: Faction, target: Faction): boolean => attacker !== target;
