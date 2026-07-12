import { RELIC_CORRUPTION_TUNING } from '@shared/balance';

export interface CorruptionPowerVisual {
  tierIndex: number;
  normalizedTier: number;
  intensity: number;
  particleCount: number;
  color: string;
  hotColor: string;
}

const COLORS = [
  ['#8b5cf6', '#c4b5fd'],
  ['#a855f7', '#e9d5ff'],
  ['#7c3aed', '#67e8f9'],
  ['#db2777', '#f0abfc'],
  ['#ef164e', '#fff1ff'],
] as const;

/** Pure tier-to-presentation mapping shared by tests and the render-only power aura. */
export const corruptionPowerVisual = (corruption: number): CorruptionPowerVisual => {
  const max = RELIC_CORRUPTION_TUNING.max;
  const value = Math.max(0, Math.min(max, corruption));
  const tiers = RELIC_CORRUPTION_TUNING.tiers;
  let tierIndex = tiers.findIndex((tier, index) =>
    index === tiers.length - 1
      ? value >= tier.minCorruption && value <= tier.maxCorruption
      : value >= tier.minCorruption && value < tier.maxCorruption,
  );
  if (tierIndex < 0) tierIndex = tiers.length - 1;

  const tier = tiers[tierIndex]!;
  const width = Math.max(1, tier.maxCorruption - tier.minCorruption);
  const normalizedTier = Math.max(0, Math.min(1, (value - tier.minCorruption) / width));
  const activeTier = Math.max(0, tierIndex);
  const intensity =
    activeTier === 0 ? 0 : Math.min(1, 0.2 + activeTier * 0.2 + normalizedTier * 0.16);
  const [color, hotColor] = COLORS[tierIndex]!;

  return {
    tierIndex,
    normalizedTier,
    intensity,
    particleCount: tierIndex === 0 ? 0 : 8 + tierIndex * 8,
    color,
    hotColor,
  };
};
