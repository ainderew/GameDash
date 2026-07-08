import { randomInt } from 'node:crypto';

/**
 * Cryptographically-secure RNG for rewards/rolls. NEVER use Math.random() for
 * anything a player could exploit (drops, gacha pulls).
 */

/** Uniform integer in [minInclusive, maxInclusive]. */
export const secureIntInclusive = (minInclusive: number, maxInclusive: number): number =>
  randomInt(minInclusive, maxInclusive + 1);

/** Weighted pick: returns the index chosen proportionally to `weights`. */
export const secureWeightedIndex = (weights: number[]): number => {
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0);
  if (total <= 0) return 0;
  let roll = randomInt(0, total);
  for (let i = 0; i < weights.length; i++) {
    roll -= Math.max(0, weights[i] ?? 0);
    if (roll < 0) return i;
  }
  return weights.length - 1;
};
